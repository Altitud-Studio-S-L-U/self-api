import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { loadLocalJson } from './local-file.js';
import { validateRuntime, type ValidationRuntime } from './validation-runtime.js';

export const DOCKER_PROFILE = Object.freeze({
  id: 'node24-linux-amd64-v2',
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
  journal: Object.freeze({
    schemaVersion: 1, directory: 'containers', maxBytes: 16 * 1024,
    beforeCreate: 'exclusive-fsynced-intent', beforeStart: 'exclusive-fsynced-created',
    cleanup: 'verified-id-removal-record', recovery: 'guarded-remove-only',
    labelPrefix: 'io.plumber.',
  }),
  isolationArgs: Object.freeze([
    '--pull=never', '--network=none', '--read-only', '--user=65534:65534',
    '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
    '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=128',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
    '--shm-size=16m', '--init', '--no-healthcheck', '--restart=no', '--log-driver=none',
    '--workdir=/workspace',
  ]),
});

const PYTHON_DRIVER = [
  'import importlib.util, pathlib, sys, unittest',
  'for source in sorted(pathlib.Path("/workspace").rglob("*.py")):',
  '    compile(source.read_bytes(), str(source), "exec")',
  'suite = unittest.TestSuite()',
  'for index, test in enumerate(sys.argv[1:]):',
  '    sys.path.insert(0, str(pathlib.Path(test).parent))',
  '    name = "keepseam_validation_" + str(index)',
  '    spec = importlib.util.spec_from_file_location(name, test)',
  '    module = importlib.util.module_from_spec(spec)',
  '    sys.modules[name] = module',
  '    try:',
  '        spec.loader.exec_module(module)',
  '    except SystemExit:',
  '        raise RuntimeError("Selected unittest modules must not exit during import") from None',
  '    selected = unittest.defaultTestLoader.loadTestsFromModule(module)',
  '    if selected.countTestCases() == 0:',
  '        raise RuntimeError("Every selected Python file must expose at least one unittest case")',
  '    suite.addTests(selected)',
  'result = unittest.TextTestRunner(verbosity=2).run(suite)',
  'sys.exit(0 if result.wasSuccessful() else 1)',
].join('\n');

const JAVA_DRIVER = [
  'set -eu',
  'mkdir /tmp/classes',
  'find /workspace -type f -name "*.java" -print0 | xargs -0 javac -J-Xmx256m -proc:none -d /tmp/classes',
  'for test do java -ea -Xmx256m --class-path /tmp/classes "$test"; done',
].join('\n');

export const PYTHON_DOCKER_PROFILE = Object.freeze({
  ...DOCKER_PROFILE,
  id: 'python313-linux-amd64-v1',
  image: 'python@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a',
  entrypoint: '/usr/local/bin/python3',
  command: Object.freeze(['-B', '-c', PYTHON_DRIVER]),
});

export const JAVA_DOCKER_PROFILE = Object.freeze({
  ...DOCKER_PROFILE,
  id: 'java25-linux-amd64-v1',
  image: 'eclipse-temurin@sha256:51ae87bbb1949c1afdff51f6a3e6c5f283d84a4bd68512c9657fdc6605026a49',
  entrypoint: '/bin/sh',
  command: Object.freeze(['-c', JAVA_DRIVER, 'keepseam-java-validation']),
});

const PYTEST_DRIVER = [
  'import os, pathlib, sys',
  'os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"',
  'import pytest',
  'selected = {pathlib.Path(p).resolve() for p in sys.argv[1:]}',
  'class Evidence:',
  '    def __init__(self): self.executed = set()',
  '    def pytest_collection_finish(self, session):',
  '        collected = {pathlib.Path(item.path).resolve() for item in session.items}',
  '        if not selected.issubset(collected): raise RuntimeError("Every selected pytest file must collect a test")',
  '    def pytest_runtest_logreport(self, report):',
  '        if report.when == "call" and not report.skipped: self.executed.add(pathlib.Path(report.location[0]).resolve())',
  '    def pytest_sessionfinish(self, session, exitstatus):',
  '        if not selected.issubset(self.executed): session.exitstatus = 5',
  'sys.exit(pytest.main(["-q", "-p", "no:cacheprovider", "-o", "addopts=", "--basetemp=/tmp/pytest", "--", *sys.argv[1:]], plugins=[Evidence()]))',
].join('\n');
const MAVEN_DRIVER = [
  'set -eu',
  'mkdir /tmp/project',
  'cp -rs /workspace/. /tmp/project/',
  'cd /tmp/project',
  'tests=""',
  'for test do',
  '  name=${test#/workspace/src/test/java/}',
  '  name=${name%.java}',
  '  name=$(printf "%s" "$name" | tr / .)',
  '  tests=${tests:+$tests,}$name',
  'done',
  'export HOME=/tmp MAVEN_OPTS="-Xmx256m -XX:ActiveProcessorCount=1"',
  '/opt/maven/bin/mvn -o -B -ntp -s /opt/keepseam/settings.xml -Dmaven.repo.local=/opt/keepseam/repository -Dtest="$tests" -DfailIfNoTests=true -Dsurefire.failIfNoSpecifiedTests=true -DskipTests=false -Dmaven.test.skip=false -Dmaven.compiler.proc=none -DargLine="-Xmx256m -XX:ActiveProcessorCount=1" test',
  'exec java -Xmx128m -XX:ActiveProcessorCount=1 --class-path /opt/keepseam/check KeepseamReports /tmp/project/target/surefire-reports "$tests"',
].join('\n');

function frameworkProfile(input: ValidationRuntime) {
  const runtime = validateRuntime(input);
  return Object.freeze({ ...DOCKER_PROFILE,
    id: runtime.kind === 'pytest' ? 'pytest9-python313-linux-amd64-v1' as const : 'maven3-junit6-java25-linux-amd64-v1' as const,
    image: runtime.imageId, runtime,
    entrypoint: runtime.kind === 'pytest' ? '/usr/local/bin/python3' : '/bin/sh',
    command: Object.freeze(runtime.kind === 'pytest' ? ['-B', '-c', PYTEST_DRIVER] : ['-c', MAVEN_DRIVER, 'keepseam-maven-validation']),
    timeoutMs: 120_000,
    isolationArgs: Object.freeze(DOCKER_PROFILE.isolationArgs.map(value => value === '--memory=512m' ? '--memory=768m'
      : value === '--memory-swap=512m' ? '--memory-swap=768m'
        : value.startsWith('--tmpfs=') ? '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777' : value)),
  });
}

export type DockerProfile = typeof DOCKER_PROFILE | typeof PYTHON_DOCKER_PROFILE | typeof JAVA_DOCKER_PROFILE | ReturnType<typeof frameworkProfile>;
const PROFILES: readonly DockerProfile[] = [DOCKER_PROFILE, PYTHON_DOCKER_PROFILE, JAVA_DOCKER_PROFILE];

/** A test selection chooses one closed runtime; consumer metadata cannot supply commands or images. */
export function dockerProfileForTests(testPaths: readonly string[], runtime?: ValidationRuntime): DockerProfile {
  if (!Array.isArray(testPaths) || testPaths.length === 0 || testPaths.some(path => !isSupportedDockerTestPath(path))) {
    throw new Error('Select supported captured tests explicitly.');
  }
  const profiles = testPaths.map(path => path.endsWith('.py') ? PYTHON_DOCKER_PROFILE : path.endsWith('.java') ? JAVA_DOCKER_PROFILE : DOCKER_PROFILE);
  if (profiles.some(profile => profile !== profiles[0])) throw new Error('One validation request cannot mix runtime profiles.');
  if (runtime !== undefined) {
    const profile = frameworkProfile(runtime);
    if (runtime.kind === 'pytest' ? profiles[0] !== PYTHON_DOCKER_PROFILE : profiles[0] !== JAVA_DOCKER_PROFILE
      || testPaths.some(path => !/^src\/test\/java\/(?:[A-Za-z_$][A-Za-z0-9_$]*\/)*[A-Za-z_$][A-Za-z0-9_$]*\.java$/u.test(path))) {
      throw new Error('Framework runtime and selected test paths do not match.');
    }
    return profile;
  }
  return profiles[0]!;
}

function checkedProfile(id: DockerProfile['id'] | undefined, runtime?: ValidationRuntime): DockerProfile {
  if (runtime !== undefined) {
    const profile = frameworkProfile(runtime);
    if (profile.id !== id) throw new Error('Runtime does not match the approved profile.');
    return profile;
  }
  const profile = PROFILES.find(candidate => candidate.id === (id ?? DOCKER_PROFILE.id));
  if (!profile) throw new Error('Unknown isolated runtime profile.');
  return profile;
}

export interface DockerValidationInput {
  readonly snapshotPath: string;
  readonly testPaths: readonly string[];
  readonly statePath: string;
  readonly runtime?: ValidationRuntime;
  readonly execution?: DockerExecutionIdentity & { readonly phase: 'baseline' | 'candidate' };
  readonly guard?: () => void;
}

export interface DockerExecutionIdentity {
  readonly intentId: string;
  readonly receiptId: string;
  readonly requestId: string;
}

export interface DockerRecoveryInput {
  readonly statePath: string;
  readonly execution: DockerExecutionIdentity;
  readonly guard: () => void;
  readonly profileId?: DockerProfile['id'];
  readonly runtime?: ValidationRuntime;
}

export interface DockerRecoveryResult {
  readonly cleanup: 'removed' | 'not-created' | 'pending' | 'failed';
  readonly reason?: string;
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
    && /\.(?:js|mjs|cjs|ts|mts|cts|py|java)$/.test(path) && !/\.d\.(?:ts|mts|cts)$/.test(path);
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

type Phase = 'baseline' | 'candidate';
interface ContainerIntent extends DockerExecutionIdentity {
  readonly schemaVersion: 1;
  readonly phase: Phase;
  readonly statePathSha256: string;
  readonly profileSha256: string;
  readonly owner: string;
  readonly containerName: string;
  readonly imageId: string;
  readonly commandSha256: string;
  readonly recordedAt: string;
}
interface CreationRecord { readonly schemaVersion: 1; readonly intentSha256: string; readonly containerId: string }
interface RemovalRecord extends CreationRecord { readonly removedAt: string }
interface Journal {
  readonly profile: DockerProfile;
  readonly directory: string;
  readonly intent: ContainerIntent;
  readonly intentSha256: string;
  readonly created: CreationRecord | null;
  readonly removed: RemovalRecord | null;
}
type Control = (args: readonly string[]) => Promise<ProcessResult>;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const PHASES: readonly Phase[] = ['baseline', 'candidate'];
const INTENT_FIELDS = ['schemaVersion', 'intentId', 'receiptId', 'requestId', 'phase', 'statePathSha256', 'profileSha256', 'owner', 'containerName', 'imageId', 'commandSha256', 'recordedAt'];
const OWNED_INSPECT_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"image":{{json .Config.Image}},'
  + '"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},'
  + '"user":{{json .Config.User}},"workingDir":{{json .Config.WorkingDir}},"readonly":{{json .HostConfig.ReadonlyRootfs}},'
  + '"network":{{json .HostConfig.NetworkMode}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},'
  + '"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}}}';

function hashJson(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function pathHash(path: string): string { return hashJson(process.platform === 'win32' ? path.toLowerCase() : path); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function executionIdentity(value: DockerExecutionIdentity): DockerExecutionIdentity {
  if (!value || typeof value.intentId !== 'string' || !HASH.test(value.intentId)
    || typeof value.requestId !== 'string' || !HASH.test(value.requestId)
    || typeof value.receiptId !== 'string' || !UUID.test(value.receiptId)) throw new Error('Invalid execution identity.');
  return { intentId: value.intentId, receiptId: value.receiptId, requestId: value.requestId };
}
function sameIdentity(value: ContainerIntent, identity: DockerExecutionIdentity): boolean {
  return value.intentId === identity.intentId && value.receiptId === identity.receiptId && value.requestId === identity.requestId;
}
async function checkMarker(state: string, identity: DockerExecutionIdentity): Promise<void> {
  const marker = await loadLocalJson(join(state, 'marker.json'), DOCKER_PROFILE.journal.maxBytes);
  if (!object(marker) || marker.schemaVersion !== 1 || marker.receiptId !== identity.receiptId
    || typeof marker.planId !== 'string' || !HASH.test(marker.planId)
    || typeof marker.executionDigest !== 'string' || !HASH.test(marker.executionDigest) || !timestamp(marker.consumedAt)) {
    throw new Error('Execution marker does not match.');
  }
}
async function checkPrivateDirectory(path: string): Promise<string> {
  const checked = await checkedPath(path, true);
  if (process.platform !== 'win32' && ((await lstat(checked)).mode & 0o077) !== 0) throw new Error('Journal directory must be private.');
  return checked;
}
async function optionalJson(path: string): Promise<unknown> {
  try {
    const attributes = await lstat(path);
    if (!attributes.isFile() || attributes.isSymbolicLink()
      || (process.platform !== 'win32' && (attributes.mode & 0o077) !== 0)) throw new Error('Journal must be a private regular file.');
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  return loadLocalJson(path, DOCKER_PROFILE.journal.maxBytes);
}
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeJournal(path: string, value: unknown): Promise<void> {
  const directory = await checkPrivateDirectory(dirname(path));
  const json = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(json) > DOCKER_PROFILE.journal.maxBytes) throw new Error('Journal exceeds its byte limit.');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(json, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(directory);
}
function labels(journal: Pick<Journal, 'intent' | 'intentSha256'>): Record<string, string> {
  const value = journal.intent;
  const prefix = DOCKER_PROFILE.journal.labelPrefix;
  return {
    [DOCKER_PROFILE.ownershipLabel]: value.owner,
    [`${prefix}request`]: value.requestId, [`${prefix}receipt`]: value.receiptId,
    [`${prefix}phase`]: value.phase, [`${prefix}profile`]: value.profileSha256,
    [`${prefix}intent`]: value.intentId, [`${prefix}journal`]: journal.intentSha256,
  };
}
function checkCreation(value: unknown, intentSha256: string): CreationRecord {
  if (!exactFields(value, ['schemaVersion', 'intentSha256', 'containerId']) || value.schemaVersion !== 1
    || value.intentSha256 !== intentSha256 || typeof value.containerId !== 'string' || !HASH.test(value.containerId)) {
    throw new Error('Invalid creation receipt.');
  }
  return value as unknown as CreationRecord;
}
function checkRemoval(value: unknown, intentSha256: string): RemovalRecord {
  if (!exactFields(value, ['schemaVersion', 'intentSha256', 'containerId', 'removedAt']) || !timestamp(value.removedAt)) {
    throw new Error('Invalid removal receipt.');
  }
  checkCreation({ schemaVersion: value.schemaVersion, intentSha256: value.intentSha256, containerId: value.containerId }, intentSha256);
  return value as unknown as RemovalRecord;
}
async function readJournal(directory: string, state: string, phase: Phase, identity: DockerExecutionIdentity, profile: DockerProfile): Promise<Journal | null> {
  const intent = await optionalJson(join(directory, `${phase}.intent.json`));
  const created = await optionalJson(join(directory, `${phase}.created.json`));
  const removed = await optionalJson(join(directory, `${phase}.cleanup.json`));
  if (intent === undefined) {
    if (created !== undefined || removed !== undefined) throw new Error('Journal intent is missing.');
    return null;
  }
  if (!exactFields(intent, INTENT_FIELDS) || intent.schemaVersion !== 1 || intent.phase !== phase
    || intent.statePathSha256 !== pathHash(state) || intent.profileSha256 !== hashJson(profile)
    || typeof intent.owner !== 'string' || !UUID.test(intent.owner) || intent.containerName !== `plumber-validation-${intent.owner}`
    || typeof intent.imageId !== 'string' || !IMAGE_ID.test(intent.imageId)
    || typeof intent.commandSha256 !== 'string' || !HASH.test(intent.commandSha256) || !timestamp(intent.recordedAt)
    || !sameIdentity(intent as unknown as ContainerIntent, identity)) throw new Error('Journal identity does not match the attempt.');
  const intentSha256 = hashJson(intent);
  const createdReceipt = created === undefined ? null : checkCreation(created, intentSha256);
  const removedReceipt = removed === undefined ? null : checkRemoval(removed, intentSha256);
  if (createdReceipt && removedReceipt && createdReceipt.containerId !== removedReceipt.containerId) throw new Error('Journal container identities disagree.');
  return { profile, directory, intent: intent as unknown as ContainerIntent, intentSha256, created: createdReceipt, removed: removedReceipt };
}
function inspectedOwnedContainer(value: unknown, journal: Journal, state: string): string | null {
  const profile = journal.profile;
  if (!object(value) || typeof value.id !== 'string' || !HASH.test(value.id) || value.name !== `/${journal.intent.containerName}`
    || (journal.created !== null && value.id !== journal.created.containerId)
    || (journal.removed !== null && value.id !== journal.removed.containerId)
    || value.imageId !== journal.intent.imageId || value.image !== profile.image
    || !object(value.labels) || !Object.entries(labels(journal)).every(([key, expected]) => (value.labels as Record<string, unknown>)[key] === expected)
    || JSON.stringify(value.entrypoint) !== JSON.stringify([profile.entrypoint])
    || !Array.isArray(value.command) || !value.command.every(item => typeof item === 'string') || hashJson(value.command) !== journal.intent.commandSha256
    || value.user !== '65534:65534' || value.workingDir !== DOCKER_PROFILE.mountTarget
    || value.readonly !== true || value.network !== 'none' || value.privileged !== false
    || (value.capAdd !== null && (!Array.isArray(value.capAdd) || value.capAdd.length !== 0))
    || JSON.stringify(value.capDrop) !== '["ALL"]' || !Array.isArray(value.securityOpt) || value.securityOpt.length !== 2
    || !['no-new-privileges=true', 'seccomp=builtin'].every(item => (value.securityOpt as unknown[]).includes(item))
    || !Array.isArray(value.mounts)) return null;
  const mounts = value.mounts as unknown[];
  const binds = mounts.filter(item => object(item) && item.Type === 'bind');
  if (binds.length !== 1 || !object(binds[0]) || binds[0].Source !== join(state, journal.intent.phase)
    || binds[0].Destination !== DOCKER_PROFILE.mountTarget || binds[0].RW !== false
    || !mounts.every(item => object(item) && (item === binds[0] || (item.Type === 'tmpfs' && item.Destination === '/tmp')))) return null;
  return value.id;
}
async function saveRemoval(journal: Journal, containerId: string): Promise<void> {
  if (journal.removed !== null) {
    if (journal.removed.containerId !== containerId) throw new Error('Removal identity changed.');
    return;
  }
  await writeJournal(join(journal.directory, `${journal.intent.phase}.cleanup.json`), {
    schemaVersion: 1, intentSha256: journal.intentSha256, containerId, removedAt: new Date().toISOString(),
  } satisfies RemovalRecord);
}
async function removeJournalContainer(journal: Journal, state: string, control: Control, guard: () => void): Promise<DockerRecoveryResult> {
  const target = journal.created?.containerId ?? journal.intent.containerName;
  const inspect = (identity: string): Promise<ProcessResult> => control(['inspect', '--type', 'container', '--format', OWNED_INSPECT_FORMAT, identity]);
  guard();
  const existing = await inspect(target);
  if (absent(existing, target)) {
    if (journal.created === null) return { cleanup: 'pending', reason: 'creation-outcome-unknown' };
    // The name is checked too: a replacement must not be mistaken for the recorded object.
    const byName = await inspect(journal.intent.containerName);
    if (!absent(byName, journal.intent.containerName)) return { cleanup: 'failed', reason: 'container-identity-mismatch' };
    guard();
    await saveRemoval(journal, journal.created.containerId);
    return { cleanup: 'removed' };
  }
  if (existing.status !== 'exited' || existing.exitCode !== 0) return { cleanup: 'failed', reason: 'docker-inspection-unavailable' };
  let containerId: string | null = null;
  try { containerId = inspectedOwnedContainer(JSON.parse(existing.stdout) as unknown, journal, state); } catch { /* Fail closed on incomplete Docker identity. */ }
  if (containerId === null) return { cleanup: 'failed', reason: 'container-identity-mismatch' };
  guard();
  await control(['rm', '--force', '--volumes', containerId]);
  const afterId = await inspect(containerId);
  const afterName = await inspect(journal.intent.containerName);
  if (!absent(afterId, containerId) || !absent(afterName, journal.intent.containerName)) return { cleanup: 'failed', reason: 'container-removal-unconfirmed' };
  guard();
  await saveRemoval(journal, containerId);
  return journal.created === null ? { cleanup: 'pending', reason: 'creation-outcome-unknown' } : { cleanup: 'removed' };
}

// This module-only process seam lets tests exercise deadlines and cleanup without Docker.
export function createDockerValidationRunner(options: RunnerOptions): (input: DockerValidationInput) => Promise<DockerValidationResult> {
  return async input => {
    if (options.platform !== 'linux' || options.arch !== 'x64') {
      return blocked('Docker validation currently requires a Linux x64 host.');
    }
    let profile: DockerProfile;
    try { profile = dockerProfileForTests(input.testPaths, input.runtime); }
    catch { return blocked('Select tests from exactly one supported isolated runtime profile.'); }
    const deadline = Date.now() + (options.timeoutMs ?? profile.timeoutMs);
    let temporary: string | undefined;
    let state: string | undefined;
    let config: string | undefined;
    let containerName: string | undefined;
    let ownership: string | undefined;
    let journal: Journal | undefined;
    let createAttempted = false;
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
      const executionContext = input.execution === undefined ? undefined : {
        ...executionIdentity(input.execution), phase: input.execution.phase,
      };
      if (executionContext !== undefined) {
        if (!PHASES.includes(executionContext.phase) || paths.snapshot !== join(state, executionContext.phase)) throw new Error('Execution snapshot does not match its phase.');
        await checkPrivateDirectory(state);
        await checkMarker(state, executionContext);
        // The caller binds requestId to its approved request; its potentially large body is not reparsed here.
        await checkedPath(join(state, 'request.json'), false);
      }
      input.guard?.();
      temporary = await mkdtemp(join(state, '.docker-'));
      config = join(temporary, 'config');
      await mkdir(config, { mode: 0o700 });
      const perform = async (): Promise<DockerValidationResult> => {
        const info = await control(['info', '--format', INFO_FORMAT]);
        if (info.status !== 'exited' || info.exitCode !== 0) return preflightFailure(info, 'The fixed local Docker daemon is unavailable.');
        if (!daemonSupportsProfile(info.stdout)) return blocked('The Docker daemon does not report the required Linux isolation and resource controls.');
        const image = await control(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', profile.image]);
        if (image.status !== 'exited' || image.exitCode !== 0) return preflightFailure(image, 'The pinned Docker image is unavailable; provision it explicitly.');
        if (image.stdout.trim() !== profile.platform) return blocked('The pinned Docker image has an unsupported platform.');
        if ('runtime' in profile) {
          const metadata = await control(['image', 'inspect', '--format', '{{json .Config.Labels}}', profile.image]);
          try {
            const labels: unknown = JSON.parse(metadata.stdout);
            if (metadata.status !== 'exited' || metadata.exitCode !== 0 || !object(labels)
              || labels['io.keepseam.validation.recipe'] !== profile.runtime.recipeSha256
              || labels['io.keepseam.validation.dependencies'] !== profile.runtime.dependenciesSha256
              || labels['io.keepseam.validation.framework'] !== profile.runtime.kind) throw new Error('Runtime metadata mismatch');
          } catch { return blocked('The prepared runtime does not match its approved recipe and dependency manifest.'); }
        }
        ownership = randomUUID();
        containerName = `plumber-validation-${ownership}`;
        const command = [...profile.command, ...paths.tests.map(path => `${profile.mountTarget}/${path}`)];
        if (executionContext !== undefined) {
          const inspectedImage = await control(['image', 'inspect', '--format', '{{.Id}}', profile.image]);
          if (inspectedImage.status !== 'exited' || inspectedImage.exitCode !== 0 || !IMAGE_ID.test(inspectedImage.stdout.trim())) {
            return preflightFailure(inspectedImage, 'The pinned Docker image identity could not be verified.');
          }
          const directory = join(state!, DOCKER_PROFILE.journal.directory);
          try { await mkdir(directory, { mode: 0o700 }); }
          catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error; }
          await checkPrivateDirectory(directory);
          await syncDirectory(state!);
          const intent: ContainerIntent = {
            schemaVersion: 1, ...executionContext, statePathSha256: pathHash(state!), profileSha256: hashJson(profile),
            owner: ownership, containerName, imageId: inspectedImage.stdout.trim(),
            commandSha256: hashJson(command), recordedAt: new Date().toISOString(),
          };
          input.guard?.();
          await writeJournal(join(directory, `${executionContext.phase}.intent.json`), intent);
          journal = { profile, directory, intent, intentSha256: hashJson(intent), created: null, removed: null };
        }
        const containerLabels = journal === undefined ? { [DOCKER_PROFILE.ownershipLabel]: ownership } : labels(journal);
        input.guard?.();
        createAttempted = true;
        const create = await control([
          'create', '--name', containerName, ...Object.entries(containerLabels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          '--platform', profile.platform, ...profile.isolationArgs,
          '--mount', `type=bind,source=${paths.snapshot},target=${profile.mountTarget},${profile.mountOptions}`,
          '--entrypoint', profile.entrypoint, profile.image, ...command,
        ]);
        uncertainCreate = create.status !== 'exited';
        if (create.status !== 'exited' || create.exitCode !== 0) return preflightFailure(create, 'Docker could not create the validation container.');
        if (!/^[a-f0-9]{64}\s*$/.test(create.stdout)) return blocked('Docker returned an invalid container identity.');
        if (journal !== undefined) {
          const created: CreationRecord = { schemaVersion: 1, intentSha256: journal.intentSha256, containerId: create.stdout.trim() };
          await writeJournal(join(journal.directory, `${journal.intent.phase}.created.json`), created);
          journal = { ...journal, created };
        }
        input.guard?.();
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

    if ((createAttempted || journal !== undefined) && containerName !== undefined && config !== undefined) {
      const cleanupDeadline = Date.now() + (options.cleanupTimeoutMs ?? DOCKER_PROFILE.cleanupTimeoutMs);
      let removed = false;
      try {
        input.guard?.();
        if (journal !== undefined) {
          const cleanup = await removeJournalContainer(journal, state!, args => control(args, cleanupDeadline), input.guard ?? (() => {}));
          removed = cleanup.cleanup === 'removed';
        } else {
          const inspect = (identity: string): Promise<ProcessResult> => control(['inspect', '--type', 'container', '--format',
            '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}', identity], cleanupDeadline);
          const existing = await inspect(containerName);
          if (absent(existing, containerName)) removed = true;
          else if (existing.status === 'exited' && existing.exitCode === 0) {
            const inspected: unknown = JSON.parse(existing.stdout);
            if (object(inspected) && typeof inspected.id === 'string' && HASH.test(inspected.id)
              && object(inspected.labels) && inspected.labels[DOCKER_PROFILE.ownershipLabel] === ownership) {
              input.guard?.();
              await control(['rm', '--force', '--volumes', inspected.id], cleanupDeadline);
              const afterId = await inspect(inspected.id);
              const afterName = await inspect(containerName);
              removed = absent(afterId, inspected.id) && absent(afterName, containerName);
            }
          }
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
        input.guard?.();
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

/** The guard is the caller's live recovery lease check; this function never authorizes or starts work. */
export function createDockerRecoveryRunner(options: RunnerOptions): (input: DockerRecoveryInput) => Promise<DockerRecoveryResult> {
  return async input => {
    let temporary: string | undefined;
    let state: string | undefined;
    let result: DockerRecoveryResult;
    try {
      if (typeof input.guard !== 'function') throw new Error('A recovery ownership guard is required.');
      const profile = checkedProfile(input.profileId, input.runtime);
      const identity = executionIdentity(input.execution);
      input.guard();
      try { state = await checkPrivateDirectory(input.statePath); }
      catch (error) {
        if (object(error) && error.code === 'ENOENT') return { cleanup: 'not-created' };
        throw error;
      }
      await checkMarker(state, identity);
      const directory = join(state, DOCKER_PROFILE.journal.directory);
      try { await checkPrivateDirectory(directory); }
      catch (error) {
        if (object(error) && error.code === 'ENOENT') return { cleanup: 'not-created' };
        throw error;
      }
      const journals: Journal[] = [];
      for (const phase of PHASES) {
        const journal = await readJournal(directory, state, phase, identity, profile);
        if (journal !== null) journals.push(journal);
      }
      if (journals.length === 0) return { cleanup: 'not-created' };
      await checkedPath(join(state, 'request.json'), false);
      if (options.platform !== 'linux' || options.arch !== 'x64') {
        return { cleanup: 'failed', reason: 'Docker recovery currently requires a Linux x64 host.' };
      }
      input.guard();
      temporary = await mkdtemp(join(state, '.docker-recovery-'));
      const config = join(temporary, 'config');
      await mkdir(config, { mode: 0o700 });
      const deadline = Date.now() + (options.cleanupTimeoutMs ?? DOCKER_PROFILE.cleanupTimeoutMs);
      const control: Control = args => captureProcess(options.spawn, args, config, deadline, DOCKER_PROFILE.maxControlOutputBytes);
      result = { cleanup: 'removed' };
      for (const journal of journals) {
        const recovered = await removeJournalContainer(journal, state, control, input.guard);
        if (recovered.cleanup === 'failed') { result = recovered; break; }
        if (recovered.cleanup === 'pending') result = recovered;
      }
    } catch {
      result = { cleanup: 'failed', reason: 'Recovery ownership or durable container evidence could not be verified.' };
    }
    if (temporary !== undefined && state !== undefined) {
      try {
        input.guard();
        const target = await realpath(temporary);
        if ((await lstat(temporary)).isSymbolicLink() || target !== temporary || dirname(target) !== state || !basename(target).startsWith('.docker-recovery-')) {
          throw new Error('Recovery state changed.');
        }
        await rm(target, { recursive: true, force: false });
      } catch { result = { cleanup: 'failed', reason: 'Could not remove the owned temporary recovery configuration.' }; }
    }
    return result;
  };
}

export const recoverDockerValidation = createDockerRecoveryRunner({ spawn, platform: process.platform, arch: process.arch });
