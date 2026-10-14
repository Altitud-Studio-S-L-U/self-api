import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { createDockerValidationRunner, DOCKER_PROFILE, runDockerValidation } from '../dist/docker-runner.js';
import { runtimeRecipeSha256 } from '../dist/validation-runtime.js';

const parent = resolve('work/test-docker-runner');
await mkdir(parent, { recursive: true });
const resolvedParent = await realpath(parent);
const temporary = await mkdtemp(join(resolvedParent, 'docker-runner-'));
let fixtureNumber = 0;
after(async () => {
  const target = await realpath(temporary);
  assert.equal(dirname(target), resolvedParent);
  assert.ok(basename(target).startsWith('docker-runner-'));
  await rm(target, { recursive: true, force: false });
});

async function fixture() {
  const statePath = join(temporary, `run-${fixtureNumber++}`);
  const snapshotPath = join(statePath, 'snapshot');
  await mkdir(snapshotPath, { recursive: true });
  await writeFile(join(snapshotPath, 'example.test.mjs'), 'throw new Error("fixture is never executed by unit tests");');
  return { statePath, snapshotPath, testPaths: ['example.test.mjs'] };
}

const daemonInfo = { os: 'linux', arch: 'x86_64', security: ['name=seccomp,profile=builtin'], memory: true, swap: true, cpuPeriod: true, cpuQuota: true, pids: true };
const containerId = 'a'.repeat(64);

function fakeDocker(overrides = {}) {
  const calls = [];
  const kills = [];
  let exists = false;
  let name;
  let ownership;
  let testExit = 0;
  const spawn = (command, rawArgs, options) => {
    const args = rawArgs.slice(4);
    const call = { command, rawArgs: [...rawArgs], args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = signal => {
      kills.push({ command: args[0], signal });
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    queueMicrotask(() => {
      let response;
      if (args[0] === 'info') response = { stdout: JSON.stringify(daemonInfo), code: 0 };
      else if (args[0] === 'image') response = { stdout: 'linux/amd64\n', code: 0 };
      else if (args[0] === 'create') {
        exists = true;
        name = args[args.indexOf('--name') + 1];
        ownership = args[args.indexOf('--label') + 1].split('=')[1];
        response = { stdout: `${containerId}\n`, code: 0 };
      } else if (args[0] === 'start') response = { stdout: 'synthetic test passed\n', code: 0 };
      else if (args[0] === 'inspect') response = args.includes('{{json .State}}')
        ? { stdout: JSON.stringify({ Status: 'exited', Running: false, Dead: false, Error: '', OOMKilled: false, ExitCode: testExit }), code: 0 }
        : exists ? { stdout: JSON.stringify({ id: containerId, labels: { [DOCKER_PROFILE.ownershipLabel]: ownership } }), code: 0 }
          : { stderr: `Error: No such object: ${args.at(-1)}\n`, code: 1 };
      else if (args[0] === 'rm') {
        exists = false;
        response = { stdout: `${name}\n`, code: 0 };
      } else throw new Error(`Unexpected fake Docker command: ${args[0]}`);
      if (overrides[args[0]]) response = overrides[args[0]]({ call, response, ownership, name, exists });
      if (args[0] === 'start') testExit = response.code ?? 0;
      if (response.hang) return;
      if (response.error) { child.emit('error', response.error); return; }
      if (response.stdout) child.stdout.write(response.stdout);
      if (response.stderr && !child.stderr.destroyed) child.stderr.write(response.stderr);
      child.emit('close', response.code ?? 0);
    });
    return child;
  };
  return { calls, kills, spawn, runner: extra => createDockerValidationRunner({ spawn, platform: 'linux', arch: 'x64', ...extra }) };
}

test('profile binds image, execution permissions, environment, and limits immutably', () => {
  assert.equal(DOCKER_PROFILE.image, 'node@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd');
  assert.equal(DOCKER_PROFILE.platform, 'linux/amd64');
  assert.equal(DOCKER_PROFILE.timeoutMs, 30_000);
  assert.equal(DOCKER_PROFILE.maxOutputBytes, 1024 * 1024);
  assert.ok(Object.isFrozen(DOCKER_PROFILE));
  assert.ok(Object.isFrozen(DOCKER_PROFILE.isolationArgs));
  assert.ok(Object.isFrozen(DOCKER_PROFILE.environment));
  assert.ok(Object.isFrozen(DOCKER_PROFILE.command));
});

test('prepared framework image labels must match the approved recipe and dependencies before creation', async () => {
  const input = await fixture();
  await writeFile(join(input.snapshotPath, 'test_contract.py'), 'def test_contract(): assert True\n');
  const runtime = { schemaVersion: 1, kind: 'pytest', imageId: `sha256:${'a'.repeat(64)}`,
    recipeSha256: runtimeRecipeSha256('pytest'), dependenciesSha256: 'b'.repeat(64) };
  for (const change of [{ 'io.keepseam.validation.recipe': '0'.repeat(64) }, { 'io.keepseam.validation.dependencies': '0'.repeat(64) }, { 'io.keepseam.validation.framework': 'maven-junit' }]) {
    const docker = fakeDocker({ image: ({ call, response }) => call.args.includes('{{json .Config.Labels}}') ? { code: 0, stdout: JSON.stringify({
      'io.keepseam.validation.recipe': runtime.recipeSha256, 'io.keepseam.validation.dependencies': runtime.dependenciesSha256,
      'io.keepseam.validation.framework': runtime.kind, ...change }) } : response });
    const result = await docker.runner()({ ...input, testPaths: ['test_contract.py'], runtime });
    assert.equal(result.status, 'blocked');
    assert.equal(result.cleanup, 'not-created');
    assert.equal(docker.calls.some(call => call.args[0] === 'create'), false);
  }
});

test('validates selected tests with fixed policy and verifies removal before returning passed', async () => {
  const input = await fixture();
  const docker = fakeDocker();
  const result = await docker.runner()(input);
  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup, 'removed');
  assert.match(result.containerName, /^plumber-validation-[a-f0-9-]{36}$/);
  assert.equal(result.stdout, 'synthetic test passed\n');
  assert.deepEqual(docker.calls.map(call => call.args[0]), ['info', 'image', 'create', 'start', 'inspect', 'inspect', 'rm', 'inspect', 'inspect']);
  const create = docker.calls.find(call => call.args[0] === 'create');
  const required = ['--pull=never', '--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=128', '--log-driver=none'];
  for (const flag of required) assert.ok(create.args.includes(flag), flag);
  assert.ok(create.args.includes(`type=bind,source=${input.snapshotPath},target=/workspace,readonly,bind-recursive=disabled`));
  assert.deepEqual(create.args.slice(create.args.indexOf('--entrypoint')), ['--entrypoint', '/usr/local/bin/node', DOCKER_PROFILE.image, '--test', '--test-reporter=tap', '--', '/workspace/example.test.mjs']);
  assert.deepEqual(docker.calls.find(call => call.args[0] === 'start').args, ['start', '--attach', containerId]);
  assert.deepEqual(docker.calls.find(call => call.args[0] === 'rm').args, ['rm', '--force', '--volumes', containerId]);
  assert.deepEqual(docker.calls.slice(-2).map(call => call.args.at(-1)), [containerId, result.containerName]);
  for (const call of docker.calls) {
    assert.equal(call.command, '/usr/bin/docker');
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(call.rawArgs.slice(2, 4), ['--host', 'unix:///var/run/docker.sock']);
    assert.equal(call.rawArgs[0], '--config');
    assert.equal(call.rawArgs[1], call.options.cwd);
    assert.equal(call.options.env.HOME, call.options.cwd);
    assert.deepEqual(Object.keys(call.options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH']);
  }
  assert.deepEqual(await readdir(input.statePath), ['snapshot']);
});

test('never forwards user Docker contexts, host environment, or secrets', async () => {
  const old = { DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, PLUMBER_HOST_SECRET: process.env.PLUMBER_HOST_SECRET };
  Object.assign(process.env, { DOCKER_HOST: 'tcp://private.invalid:1234', DOCKER_CONTEXT: 'private-context', PLUMBER_HOST_SECRET: 'fixture-secret' });
  try {
    const docker = fakeDocker();
    assert.equal((await docker.runner()(await fixture())).status, 'passed');
    const serialized = JSON.stringify(docker.calls);
    for (const forbidden of ['private.invalid', 'private-context', 'fixture-secret']) assert.equal(serialized.includes(forbidden), false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('unsupported hosts are blocked before filesystem or process access', async () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'arm64']]) {
    const docker = fakeDocker();
    const result = await docker.runner({ platform, arch })({ snapshotPath: 'missing', statePath: 'missing', testPaths: [] });
    assert.equal(result.status, 'blocked');
    assert.equal(result.cleanup, 'not-created');
    assert.equal(docker.calls.length, 0);
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') assert.equal((await runDockerValidation({})).status, 'blocked');
});

test('rejects traversal, globs, non-source paths, duplicates and mount injection without Docker', async () => {
  const input = await fixture();
  for (const testPaths of [[], ['../secret.mjs'], ['/absolute.mjs'], ['nested\\test.mjs'], ['https://private.invalid/a.mjs'], ['*.mjs'], ['{a,b}.mjs'], ['a[0].mjs'], ['.env'], ['.hidden/a.mjs'], ['missing.mjs'], ['example.test.mjs', 'example.test.mjs'], ['type.d.ts'], ['package.json'], Array(501).fill('example.test.mjs')]) {
    const docker = fakeDocker();
    const result = await docker.runner()({ ...input, testPaths });
    assert.equal(result.status, 'blocked', JSON.stringify(testPaths.slice(0, 2)));
    assert.equal(docker.calls.length, 0);
  }
  for (const snapshotPath of ['relative', '//remote/snapshot', `${input.snapshotPath},target=/host`, `${input.snapshotPath}\n`, `${input.snapshotPath}"`]) {
    const docker = fakeDocker();
    assert.equal((await docker.runner()({ ...input, snapshotPath })).status, 'blocked');
    assert.equal(docker.calls.length, 0);
  }
  const docker = fakeDocker();
  assert.equal((await docker.runner()({ ...input, statePath: input.snapshotPath })).status, 'blocked');
  assert.equal(docker.calls.length, 0);
});

test('rejects linked snapshots and linked test ancestors', async () => {
  const input = await fixture();
  const linked = join(input.statePath, 'linked');
  await symlink(input.snapshotPath, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const docker = fakeDocker();
  assert.equal((await docker.runner()({ ...input, snapshotPath: linked })).status, 'blocked');
  const nested = join(input.snapshotPath, 'linked-tests');
  await symlink(input.snapshotPath, nested, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await docker.runner()({ ...input, testPaths: ['linked-tests/example.test.mjs'] })).status, 'blocked');
  assert.equal(docker.calls.length, 0);
});

test('daemon, resource controls, image, and executable failures block without exposing diagnostics', async () => {
  const secretDiagnostic = 'private-daemon-or-registry-value';
  const variants = [
    { info: () => ({ code: 1, stderr: secretDiagnostic }) },
    { info: () => ({ error: new Error(secretDiagnostic) }) },
    { info: () => ({ code: 0, stdout: JSON.stringify({ ...daemonInfo, pids: false }) }) },
    { info: () => ({ code: 0, stdout: JSON.stringify({ ...daemonInfo, security: [] }) }) },
    { info: () => ({ code: 0, stdout: '{invalid' }) },
    { image: () => ({ code: 1, stderr: secretDiagnostic }) },
    { image: () => ({ code: 0, stdout: 'linux/arm64' }) },
  ];
  for (const overrides of variants) {
    const docker = fakeDocker(overrides);
    const result = await docker.runner()(await fixture());
    assert.equal(result.status, 'blocked');
    assert.equal(result.cleanup, 'not-created');
    assert.equal(JSON.stringify(result).includes(secretDiagnostic), false);
    assert.ok(docker.calls.every(call => !['create', 'start', 'rm'].includes(call.args[0])));
  }
});

test('preserves failing test exit and output while still removing the container', async () => {
  const docker = fakeDocker({ start: () => ({ code: 3, stdout: 'synthetic failure\n', stderr: 'assertion failed\n' }) });
  const result = await docker.runner()(await fixture());
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'synthetic failure\n');
  assert.equal(result.stderr, 'assertion failed\n');
  assert.equal(result.cleanup, 'removed');
});

test('timeout kills the attached CLI and verifies container removal', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const docker = fakeDocker({ start: () => { t.mock.timers.tick(80); return { hang: true }; } });
  const result = await docker.runner({ timeoutMs: 80 })(await fixture());
  assert.equal(result.status, 'timed-out');
  assert.equal(result.exitCode, null);
  assert.equal(result.cleanup, 'removed');
  assert.deepEqual(docker.kills, [{ command: 'start', signal: 'SIGKILL' }]);
  assert.equal(docker.calls.at(-1).args[0], 'inspect');
});

test('one total deadline includes preflight and does not reset for test execution', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const docker = fakeDocker({
    info: ({ response }) => { t.mock.timers.tick(120); return response; },
    start: ({ response }) => { t.mock.timers.tick(120); return response; },
  });
  const result = await docker.runner({ timeoutMs: 200 })(await fixture());
  assert.equal(result.status, 'timed-out');
  assert.equal(result.cleanup, 'removed');
  const blockedDocker = fakeDocker({ info: () => { t.mock.timers.tick(30); return { hang: true }; } });
  const blockedResult = await blockedDocker.runner({ timeoutMs: 30 })(await fixture());
  assert.equal(blockedResult.status, 'timed-out');
  assert.equal(blockedResult.cleanup, 'not-created');
  assert.deepEqual(blockedDocker.calls.map(call => call.args[0]), ['info']);
  const expiredBeforeDocker = fakeDocker();
  const expiredResult = await expiredBeforeDocker.runner({ timeoutMs: 30 })({
    ...await fixture(), guard() { t.mock.timers.tick(30); },
  });
  assert.equal(expiredResult.status, 'timed-out');
  assert.equal(expiredResult.cleanup, 'not-created');
  assert.deepEqual(expiredBeforeDocker.calls, []);
});

test('bounds combined stdout and stderr and removes the container on overflow', async () => {
  const docker = fakeDocker({ start: () => ({ stdout: 'x'.repeat(DOCKER_PROFILE.maxOutputBytes - 8), stderr: 'y'.repeat(100), code: 0 }) });
  const result = await docker.runner()(await fixture());
  assert.equal(result.status, 'output-limit');
  assert.equal(result.exitCode, null);
  assert.equal(result.cleanup, 'removed');
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), DOCKER_PROFILE.maxOutputBytes);
  assert.deepEqual(docker.kills, [{ command: 'start', signal: 'SIGKILL' }]);
});

test('cleanup failure overrides a passing test and never removes a differently owned container', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  for (const overrides of [
    { inspect: ({ call, response }) => call.args.includes('{{json .State}}') ? response : ({ code: 0, stdout: JSON.stringify({ id: containerId, labels: { [DOCKER_PROFILE.ownershipLabel]: 'someone-else' } }) }) },
    { inspect: ({ call, response }) => call.args.includes('{{json .State}}') ? response : ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }) },
    { inspect: ({ call, response }) => call.args.includes('{{json .State}}') ? response : ({ code: 0, stdout: '{broken' }) },
  ]) {
    const docker = fakeDocker(overrides);
    const result = await docker.runner()(await fixture());
    assert.equal(result.status, 'cleanup-failed');
    assert.equal(result.cleanup, 'failed');
    assert.equal(result.exitCode, 0);
    assert.ok(docker.calls.every(call => call.args[0] !== 'rm'));
  }
  const docker = fakeDocker({ rm: () => { t.mock.timers.tick(30); return { hang: true }; }, inspect: ({ response, exists }) => exists ? response : ({ code: 1, stderr: 'daemon unavailable' }) });
  const result = await docker.runner({ cleanupTimeoutMs: 30 })(await fixture());
  assert.equal(result.status, 'cleanup-failed');
  assert.equal(result.cleanup, 'failed');
});

test('cleanup cannot remove a replacement that takes the inspected container name', async () => {
  let inspectedOwner = false;
  let replacementExists = false;
  const replacementId = 'b'.repeat(64);
  const docker = fakeDocker({
    inspect: ({ call, response, name }) => {
      if (call.args.includes('{{json .State}}')) return response;
      if (!inspectedOwner) {
        inspectedOwner = true;
        // The original disappears after inspection and a different container takes its name.
        replacementExists = true;
        return response;
      }
      if (call.args.at(-1) === name && replacementExists) {
        return { code: 0, stdout: JSON.stringify({ id: replacementId, labels: { [DOCKER_PROFILE.ownershipLabel]: 'another-owner' } }) };
      }
      return { code: 1, stderr: `Error: No such object: ${call.args.at(-1)}\n` };
    },
    rm: ({ call, name }) => {
      if (call.args.at(-1) === name) replacementExists = false;
      return { code: 1, stderr: `Error: No such container: ${containerId}\n` };
    },
  });
  const result = await docker.runner()(await fixture());
  assert.deepEqual(docker.calls.filter(call => call.args[0] === 'rm').map(call => call.args.at(-1)), [containerId]);
  assert.equal(replacementExists, true);
  assert.equal(result.status, 'cleanup-failed');
  assert.equal(result.cleanup, 'failed');
});

test('interrupted creation attempts cleanup but cannot claim no pending daemon creation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const docker = fakeDocker({ create: () => { t.mock.timers.tick(50); return { hang: true }; } });
  const result = await docker.runner({ timeoutMs: 50 })(await fixture());
  assert.equal(result.status, 'cleanup-failed');
  assert.equal(result.cleanup, 'failed');
  assert.match(result.reason, /pending daemon request/);
  assert.ok(docker.calls.some(call => call.args[0] === 'rm'));
  assert.ok(docker.calls.every(call => call.args[0] !== 'start'));
});

test('a failed create is cleaned up and never starts consumer code', async () => {
  const docker = fakeDocker({ create: () => ({ code: 125, stderr: 'private fixture diagnostic' }) });
  const result = await docker.runner()(await fixture());
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup, 'removed');
  assert.ok(docker.calls.some(call => call.args[0] === 'rm'));
  assert.ok(docker.calls.every(call => call.args[0] !== 'start'));
  assert.equal(JSON.stringify(result).includes('private fixture diagnostic'), false);
});

test('does not confuse daemon transport or resource failures with failing consumer tests', async () => {
  const invalidStates = [
    { ExitCode: 1 }, { Running: true }, { Status: 'created' }, { Dead: true },
    { Error: 'private daemon failure' }, { OOMKilled: true }, { ExitCode: -1 }, { ExitCode: 1.5 },
  ];
  for (const change of invalidStates) {
    const docker = fakeDocker({ inspect: ({ call, response }) => !call.args.includes('{{json .State}}') ? response
      : { code: 0, stdout: JSON.stringify({ ...JSON.parse(response.stdout), ...change }) } });
    const result = await docker.runner()(await fixture());
    assert.equal(result.status, 'blocked');
    assert.equal(result.exitCode, null);
    assert.equal(result.cleanup, 'removed');
    assert.equal(JSON.stringify(result).includes('private daemon failure'), false);
  }
  const docker = fakeDocker({ inspect: ({ call, response }) => call.args.includes('{{json .State}}')
    ? { code: 1, stderr: 'transient daemon failure' } : response });
  const result = await docker.runner()(await fixture());
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup, 'removed');
});
