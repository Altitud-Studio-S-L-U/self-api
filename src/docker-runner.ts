import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const DOCKER_PROFILE = Object.freeze({
  id: 'node24-linux-amd64-v1',
  image: 'node@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd',
  platform: 'linux/amd64',
  executable: '/usr/bin/docker',
  endpoint: 'unix:///var/run/docker.sock',
  timeoutMs: 30_000,
  cleanupTimeoutMs: 5_000,
  maxOutputBytes: 1024 * 1024,
  maxControlOutputBytes: 16 * 1024,
  ownershipLabel: 'io.plumber.validation',
  mountTarget: '/workspace',
  mountOptions: 'readonly,bind-recursive=disabled',
  entrypoint: '/usr/local/bin/node',
  command: Object.freeze(['--test', '--test-reporter=tap', '--']),
  environment: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }),
  isolationArgs: Object.freeze([
    '--pull=never', '--network=none', '--read-only', '--user=65534:65534',
    '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
    '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=128',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
    '--shm-size=16m', '--init', '--no-healthcheck', '--restart=no', '--log-driver=none',
    '--workdir=/workspace',
  ]),
});

export interface DockerValidationInput {
  readonly snapshotPath: string;
  readonly testPaths: readonly string[];
  readonly statePath: string;
}

export interface DockerValidationResult {
  status: 'passed' | 'failed' | 'blocked' | 'timed-out' | 'output-limit' | 'cleanup-failed';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cleanup: 'removed' | 'not-created' | 'failed';
  containerName?: string;
  reason?: string;
}

type SpawnDocker = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
interface RunnerOptions {
  readonly spawn: SpawnDocker;
  readonly platform: string;
  readonly arch: string;
  readonly timeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}
interface ProcessResult {
  readonly status: 'exited' | 'timed-out' | 'output-limit' | 'unavailable';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const INFO_FORMAT = '{"os":{{json .OSType}},"arch":{{json .Architecture}},'
  + '"security":{{json .SecurityOptions}},"memory":{{json .MemoryLimit}},'
  + '"swap":{{json .SwapLimit}},"cpuPeriod":{{json .CPUCfsPeriod}},'
  + '"cpuQuota":{{json .CPUCfsQuota}},"pids":{{json .PidsLimit}}}';

function blocked(reason: string): DockerValidationResult {
  return { status: 'blocked', exitCode: null, stdout: '', stderr: '', cleanup: 'not-created', reason };
}

async function checkedPath(path: string, directory: boolean): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || /^[\\/]{2}/.test(path)
    || /[\x00-\x1f\x7f,"]/.test(path)) throw new Error('Invalid local path.');
  const absolute = resolve(path);
  if (absolute === parse(absolute).root) throw new Error('Filesystem roots are not allowed.');
  const root = parse(absolute).root;
  let current = root;
  const segments = absolute.slice(root.length).split(sep);
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = join(current, segments[index]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === segments.length - 1 && !directory ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('Expected an unlinked local path.');
    }
  }
  if (await realpath(absolute) !== absolute) throw new Error('Path changed while checking it.');
  return absolute;
}

export function isSupportedDockerTestPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 500 && !/[\\:\x00-\x1f\x7f*?\[\]{}()]/.test(path)
    && !path.startsWith('/') && !path.split('/').some(part => part === '' || part === '.' || part === '..' || part.startsWith('.'))
    && /\.(?:js|mjs|cjs|ts|mts|cts)$/.test(path) && !/\.d\.(?:ts|mts|cts)$/.test(path);
}

async function preparePaths(input: DockerValidationInput): Promise<{ snapshot: string; state: string; tests: readonly string[] }> {
  if (!Array.isArray(input.testPaths) || input.testPaths.length === 0 || input.testPaths.length > 500) {
    throw new Error('Select one or more bounded source tests.');
  }
  const tests = new Set<string>();
  for (const test of [...input.testPaths]) {
    if (!isSupportedDockerTestPath(test) || tests.has(test)) {
      throw new Error('Invalid test selection.');
    }
    tests.add(test);
  }
  const snapshot = await checkedPath(input.snapshotPath, true);
  const state = await checkedPath(input.statePath, true);
  const stateFromSnapshot = relative(snapshot, state);
  if (stateFromSnapshot === '' || (!stateFromSnapshot.startsWith(`..${sep}`) && stateFromSnapshot !== '..' && !isAbsolute(stateFromSnapshot))) {
    throw new Error('Run state must be outside the snapshot.');
  }
  for (const test of tests) await checkedPath(join(snapshot, ...test.split('/')), false);
  return { snapshot, state, tests: [...tests] };
}

function captureProcess(
  spawnDocker: SpawnDocker, args: readonly string[], config: string, deadline: number, maxBytes: number,
): Promise<ProcessResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve({ status: 'timed-out', exitCode: null, stdout: '', stderr: '' });
  return new Promise(resolveResult => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let settled = false;
    let child: ChildProcess;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: ProcessResult['status'], exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (status !== 'exited') {
        try { child?.kill('SIGKILL'); } catch { /* Docker cleanup is verified independently. */ }
        child?.stdout?.destroy();
        child?.stderr?.destroy();
      }
      resolveResult({ status, exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    try {
      child = spawnDocker(DOCKER_PROFILE.executable, ['--config', config, '--host', DOCKER_PROFILE.endpoint, ...args], {
        cwd: config, env: { ...DOCKER_PROFILE.environment, HOME: config },
        shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch {
      finish('unavailable', null);
      return;
    }
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const accepted = Math.min(bytes.length, maxBytes - captured);
      if (accepted > 0) target.push(Buffer.from(bytes.subarray(0, accepted)));
      captured += accepted;
      if (accepted < bytes.length) finish('output-limit', null);
    };
    child.stdout?.on('data', chunk => collect(stdout, chunk as Buffer));
    child.stderr?.on('data', chunk => collect(stderr, chunk as Buffer));
    child.once('error', () => finish('unavailable', null));
    child.once('close', code => finish('exited', code));
    timer = setTimeout(() => finish('timed-out', null), remaining);
  });
}

function daemonSupportsProfile(stdout: string): boolean {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    return value.os === 'linux' && (value.arch === 'x86_64' || value.arch === 'amd64')
      && Array.isArray(value.security) && value.security.some(item => typeof item === 'string' && /^name=seccomp(?:,|$)/.test(item))
      && ['memory', 'swap', 'cpuPeriod', 'cpuQuota', 'pids'].every(key => value[key] === true);
  } catch { return false; }
}

function absent(result: ProcessResult, name: string): boolean {
  return result.status === 'exited' && result.exitCode === 1 && result.stdout.trim() === ''
    && new RegExp(`^(?:Error(?: response from daemon)?: )?No such (?:object|container): ${name}\\s*$`).test(result.stderr);
}

// This module-only process seam lets tests exercise deadlines and cleanup without Docker.
export function createDockerValidationRunner(options: RunnerOptions): (input: DockerValidationInput) => Promise<DockerValidationResult> {
  return async input => {
    if (options.platform !== 'linux' || options.arch !== 'x64') {
      return blocked('Docker validation currently requires a Linux x64 host.');
    }
    const deadline = Date.now() + (options.timeoutMs ?? DOCKER_PROFILE.timeoutMs);
    let temporary: string | undefined;
    let state: string | undefined;
    let config: string | undefined;
    let containerName: string | undefined;
    let ownership: string | undefined;
    let uncertainCreate = false;
    let result: DockerValidationResult;
    const control = (args: readonly string[], until = deadline): Promise<ProcessResult> =>
      captureProcess(options.spawn, args, config!, until, DOCKER_PROFILE.maxControlOutputBytes);
    const preflightFailure = (response: ProcessResult, reason: string): DockerValidationResult => response.status === 'timed-out'
      ? { ...blocked('Docker validation exceeded its total deadline.'), status: 'timed-out' }
      : response.status === 'output-limit' ? { ...blocked('Docker control output exceeded its limit.'), status: 'output-limit' } : blocked(reason);
    try {
      const paths = await preparePaths(input);
      state = paths.state;
      temporary = await mkdtemp(join(state, '.docker-'));
      config = join(temporary, 'config');
      await mkdir(config, { mode: 0o700 });
      const perform = async (): Promise<DockerValidationResult> => {
        const info = await control(['info', '--format', INFO_FORMAT]);
        if (info.status !== 'exited' || info.exitCode !== 0) return preflightFailure(info, 'The fixed local Docker daemon is unavailable.');
        if (!daemonSupportsProfile(info.stdout)) return blocked('The Docker daemon does not report the required Linux isolation and resource controls.');
        const image = await control(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', DOCKER_PROFILE.image]);
        if (image.status !== 'exited' || image.exitCode !== 0) return preflightFailure(image, 'The pinned Docker image is unavailable; provision it explicitly.');
        if (image.stdout.trim() !== DOCKER_PROFILE.platform) return blocked('The pinned Docker image has an unsupported platform.');
        ownership = randomUUID();
        containerName = `plumber-validation-${ownership}`;
        const create = await control([
          'create', '--name', containerName, '--label', `${DOCKER_PROFILE.ownershipLabel}=${ownership}`,
          '--platform', DOCKER_PROFILE.platform, ...DOCKER_PROFILE.isolationArgs,
          '--mount', `type=bind,source=${paths.snapshot},target=${DOCKER_PROFILE.mountTarget},${DOCKER_PROFILE.mountOptions}`,
          '--entrypoint', DOCKER_PROFILE.entrypoint, DOCKER_PROFILE.image, ...DOCKER_PROFILE.command,
          ...paths.tests.map(path => `${DOCKER_PROFILE.mountTarget}/${path}`),
        ]);
        uncertainCreate = create.status !== 'exited';
        if (create.status !== 'exited' || create.exitCode !== 0) return preflightFailure(create, 'Docker could not create the validation container.');
        if (!/^[a-f0-9]{64}\s*$/.test(create.stdout)) return blocked('Docker returned an invalid container identity.');
        const execution = await captureProcess(options.spawn, ['start', '--attach', create.stdout.trim()], config!, deadline, DOCKER_PROFILE.maxOutputBytes);
        if (execution.status === 'exited') {
          const inspect = await control(['inspect', '--type', 'container', '--format', '{{json .State}}', create.stdout.trim()]);
          let validExit = false;
          try {
            const containerState = JSON.parse(inspect.stdout) as Record<string, unknown>;
            validExit = inspect.status === 'exited' && inspect.exitCode === 0
              && containerState.Status === 'exited' && containerState.Running === false && containerState.Dead === false
              && containerState.Error === '' && containerState.OOMKilled === false
              && typeof containerState.ExitCode === 'number' && Number.isSafeInteger(containerState.ExitCode)
              && containerState.ExitCode >= 0 && containerState.ExitCode <= 255 && containerState.ExitCode === execution.exitCode;
          } catch { /* A transport or resource failure is not a failed consumer test. */ }
          if (!validExit) return {
            ...blocked('Docker could not confirm a completed test process without infrastructure or resource failure.'),
            stdout: execution.stdout, stderr: execution.stderr,
          };
        }
        return {
          status: execution.status === 'exited' ? execution.exitCode === 0 ? 'passed' : 'failed'
            : execution.status === 'unavailable' ? 'blocked' : execution.status,
          exitCode: execution.exitCode, stdout: execution.stdout, stderr: execution.stderr, cleanup: 'not-created',
          ...(execution.status === 'unavailable' ? { reason: 'Docker could not attach to the validation container.' } : {}),
        };
      };
      result = await perform();
    } catch {
      result = blocked('Validation inputs or local run state are not usable.');
    }

    if (containerName !== undefined && config !== undefined) {
      const cleanupDeadline = Date.now() + (options.cleanupTimeoutMs ?? DOCKER_PROFILE.cleanupTimeoutMs);
      let removed = false;
      try {
        const inspect = ['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}', containerName];
        const existing = await control(inspect, cleanupDeadline);
        if (absent(existing, containerName)) removed = true;
        else if (existing.status === 'exited' && existing.exitCode === 0
          && (JSON.parse(existing.stdout) as Record<string, unknown>)[DOCKER_PROFILE.ownershipLabel] === ownership) {
          await control(['rm', '--force', '--volumes', containerName], cleanupDeadline);
          removed = absent(await control(inspect, cleanupDeadline), containerName);
        }
      } catch { /* Unknown ownership or daemon failure must not become a successful cleanup. */ }
      result.containerName = containerName;
      result.cleanup = removed && !uncertainCreate ? 'removed' : 'failed';
      if (result.cleanup === 'failed') {
        result.status = 'cleanup-failed';
        result.reason = uncertainCreate
          ? 'Container creation was interrupted; absence cannot rule out a pending daemon request.'
          : 'Could not verify removal of the owned validation container.';
      }
    }
    if (temporary !== undefined && state !== undefined) {
      try {
        const target = await realpath(temporary);
        const attributes = await lstat(temporary);
        if (attributes.isSymbolicLink() || target !== temporary || dirname(target) !== state || !basename(target).startsWith('.docker-')) {
          throw new Error('Local state changed.');
        }
        await rm(target, { recursive: true, force: false });
      } catch {
        result.status = 'cleanup-failed';
        result.cleanup = 'failed';
        result.reason = 'Could not remove the owned temporary Docker configuration.';
      }
    }
    return result;
  };
}

export const runDockerValidation = createDockerValidationRunner({ spawn, platform: process.platform, arch: process.arch });
