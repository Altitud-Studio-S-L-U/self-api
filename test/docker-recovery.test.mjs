import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { createDockerRecoveryRunner, createDockerValidationRunner, DOCKER_PROFILE, JAVA_DOCKER_PROFILE, PYTHON_DOCKER_PROFILE } from '../dist/docker-runner.js';

const parent = resolve('work/test-docker-recovery');
await mkdir(parent, { recursive: true });
const realParent = await realpath(parent);
const temporary = await mkdtemp(join(realParent, 'recovery-'));
let fixtureNumber = 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => digest(JSON.stringify(value));
const imageId = `sha256:${'e'.repeat(64)}`;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const daemonInfo = { os: 'linux', arch: 'x86_64', security: ['name=seccomp,profile=builtin'], memory: true, swap: true, cpuPeriod: true, cpuQuota: true, pids: true };

for (const profile of [PYTHON_DOCKER_PROFILE, JAVA_DOCKER_PROFILE]) {
  test(`${profile.id}: recovery requires the approved profile and verifies its exact image, command and entrypoint`, async () => {
    const context = await fixture(profile);
    let owned = true;
    const docker = fakeDocker({ start: () => { owned = false; return { code: 0 }; } });
    const interrupted = await docker.run()( { ...context.input('baseline'), guard: () => { if (!owned) throw new Error('Controlled lease loss.'); } });
    assert.equal(interrupted.status, 'cleanup-failed');
    const journal = await readJson(join(context.statePath, 'containers/baseline.intent.json'));
    assert.equal(journal.profileSha256, jsonHash(profile));
    const recover = profileId => docker.recover()({ statePath: context.statePath, execution: context.execution, profileId, guard: () => {} });
    assert.equal((await recover(DOCKER_PROFILE.id)).cleanup, 'failed', 'A different approved runtime cannot be substituted during recovery.');
    assert.equal(docker.containers.size, 1);
    const container = [...docker.containers.values()][0];
    const originalEntrypoint = container.entrypoint;
    container.entrypoint = ['/unapproved/runtime'];
    assert.equal((await recover(profile.id)).cleanup, 'failed');
    assert.equal(docker.containers.size, 1);
    container.entrypoint = originalEntrypoint;
    assert.equal((await recover(profile.id)).cleanup, 'removed');
    assert.equal(docker.containers.size, 0);
    assert.equal(docker.calls.filter(call => call.args[0] === 'start').length, 1, 'Recovery never reexecutes consumer tests.');
  });
}

after(async () => {
  const target = await realpath(temporary);
  assert.equal(dirname(target), realParent);
  assert.ok(basename(target).startsWith('recovery-'));
  await rm(target, { recursive: true, force: false });
});

async function fixture(profile = DOCKER_PROFILE) {
  const statePath = join(temporary, `attempt-${fixtureNumber++}`);
  await mkdir(statePath, { mode: 0o700 });
  const testPath = profile === PYTHON_DOCKER_PROFILE ? 'test_example.py' : profile === JAVA_DOCKER_PROFILE ? 'ExampleTest.java' : 'example.test.mjs';
  for (const phase of ['baseline', 'candidate']) {
    await mkdir(join(statePath, phase));
    await writeFile(join(statePath, phase, testPath), 'not executed by the synthetic Docker fixture');
  }
  const receiptId = randomUUID();
  const execution = { intentId: digest(receiptId), receiptId, requestId: 'b'.repeat(64) };
  const marker = { schemaVersion: 1, receiptId, planId: 'c'.repeat(64), executionDigest: 'd'.repeat(64), consumedAt: new Date().toISOString() };
  await writeFile(join(statePath, 'marker.json'), JSON.stringify(marker), { mode: 0o600 });
  await writeFile(join(statePath, 'request.json'), JSON.stringify({ id: execution.requestId }), { mode: 0o600 });
  return {
    statePath, execution, marker,
    input: phase => ({ statePath, snapshotPath: join(statePath, phase), testPaths: [testPath], execution: { ...execution, phase } }),
  };
}

function fakeDocker(hooks = {}) {
  const calls = [];
  const containers = new Map();
  let pending;
  const spawn = (executable, rawArgs, options) => {
    const args = rawArgs.slice(4);
    const call = { executable, rawArgs: [...rawArgs], args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
    queueMicrotask(async () => {
      try {
        let response;
        if (args[0] === 'info') response = { code: 0, stdout: JSON.stringify(daemonInfo) };
        else if (args[0] === 'image') response = { code: 0, stdout: args.includes('{{.Id}}') ? `${imageId}\n` : 'linux/amd64\n' };
        else if (args[0] === 'create') {
          const containerLabels = {};
          args.forEach((arg, index) => {
            if (arg === '--label') {
              const value = args[index + 1];
              const separator = value.indexOf('=');
              containerLabels[value.slice(0, separator)] = value.slice(separator + 1);
            }
          });
          const source = args[args.indexOf('--mount') + 1].match(/^type=bind,source=(.+),target=\/workspace,/u)[1];
          const id = digest(randomUUID());
          const entrypointIndex = args.indexOf('--entrypoint');
          const image = args[entrypointIndex + 2];
          pending = {
            id, name: `/${args[args.indexOf('--name') + 1]}`, imageId, image,
            labels: containerLabels, command: args.slice(entrypointIndex + 3),
            entrypoint: [args[entrypointIndex + 1]], user: '65534:65534', workingDir: '/workspace',
            readonly: true, network: 'none', privileged: false, capAdd: null, capDrop: ['ALL'],
            securityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
            mounts: [{ Type: 'bind', Source: source, Destination: '/workspace', RW: false }],
          };
          containers.set(id, pending);
          response = { code: 0, stdout: `${id}\n` };
        } else if (args[0] === 'start') response = { code: 0, stdout: 'synthetic test success\n' };
        else if (args[0] === 'inspect') {
          const target = args.at(-1);
          const container = containers.get(target) ?? [...containers.values()].find(item => item.name === `/${target}`);
          response = container === undefined ? { code: 1, stderr: `Error: No such object: ${target}\n` }
            : args.includes('{{json .State}}')
              ? { code: 0, stdout: JSON.stringify({ Status: 'exited', Running: false, Dead: false, Error: '', OOMKilled: false, ExitCode: 0 }) }
              : { code: 0, stdout: JSON.stringify(container) };
        } else if (args[0] === 'rm') {
          assert.match(args.at(-1), /^[a-f0-9]{64}$/u, 'Owned cleanup must remove by verified ID.');
          containers.delete(args.at(-1));
          response = { code: 0, stdout: `${args.at(-1)}\n` };
        } else throw new Error(`Forbidden fake Docker action ${args[0]}`);
        if (hooks[args[0]]) response = await hooks[args[0]]({ call, response, containers, pending });
        if (response.hang) return;
        if (response.error) { child.emit('error', response.error); return; }
        if (response.stdout) child.stdout.write(response.stdout);
        if (response.stderr && !child.stderr.destroyed) child.stderr.write(response.stderr);
        child.emit('close', response.code ?? 0);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  return {
    calls, containers,
    publishPending: () => { containers.set(pending.id, pending); },
    run: extra => createDockerValidationRunner({ spawn, platform: 'linux', arch: 'x64', ...extra }),
    recover: extra => createDockerRecoveryRunner({ spawn, platform: 'linux', arch: 'x64', ...extra }),
  };
}

async function interruptedFixture(hooks = {}) {
  const context = await fixture();
  let owned = true;
  const docker = fakeDocker({ ...hooks, start: async details => {
    owned = false;
    if (hooks.start) return hooks.start(details);
    return { error: new Error('synthetic executor lost its lease') };
  } });
  const result = await docker.run()({ ...context.input('baseline'), guard: () => { if (!owned) throw new Error('lease lost'); } });
  assert.equal(result.cleanup, 'failed');
  assert.equal(result.status, 'cleanup-failed');
  assert.equal(docker.containers.size, 1);
  return { ...context, docker, result };
}

test('v2 binds journal policy and writes intent before create, creation receipt before start, and removal after verification', async () => {
  assert.equal(DOCKER_PROFILE.id, 'node24-linux-amd64-v2');
  assert.ok(Object.isFrozen(DOCKER_PROFILE.journal));
  const context = await fixture();
  const directory = join(context.statePath, 'containers');
  const events = [];
  const docker = fakeDocker({
    create: async ({ response }) => {
      const intent = await readJson(join(directory, 'baseline.intent.json'));
      assert.equal(intent.requestId, context.execution.requestId);
      assert.equal(intent.containerName, `self-managed-api-validation-${intent.owner}`);
      await assert.rejects(access(join(directory, 'baseline.created.json')), { code: 'ENOENT' });
      events.push('intent-before-create');
      return response;
    },
    start: async ({ call, response }) => {
      const created = await readJson(join(directory, 'baseline.created.json'));
      assert.equal(created.containerId, call.args.at(-1));
      assert.equal(created.intentSha256, jsonHash(await readJson(join(directory, 'baseline.intent.json'))));
      events.push('created-before-start');
      return response;
    },
    rm: async ({ response }) => {
      await assert.rejects(access(join(directory, 'baseline.cleanup.json')), { code: 'ENOENT' });
      events.push('no-premature-cleanup');
      return response;
    },
  });
  const markerBefore = await readFile(join(context.statePath, 'marker.json'));
  const result = await docker.run()({ ...context.input('baseline'), guard() {} });
  assert.equal(result.status, 'passed');
  assert.equal(result.cleanup, 'removed');
  assert.deepEqual(events, ['intent-before-create', 'created-before-start', 'no-premature-cleanup']);
  assert.deepEqual((await readdir(directory)).sort(), ['baseline.cleanup.json', 'baseline.created.json', 'baseline.intent.json']);
  assert.deepEqual(await readFile(join(context.statePath, 'marker.json')), markerBefore);
  const journal = await readJson(join(directory, 'baseline.intent.json'));
  assert.equal(journal.profileSha256, jsonHash(DOCKER_PROFILE));
  assert.equal(journal.imageId, imageId);
  assert.ok(!JSON.stringify(journal).includes(context.statePath));
  assert.ok(!JSON.stringify(journal).includes('example.test.mjs'));
  const removeCount = docker.calls.filter(call => call.args[0] === 'rm').length;
  assert.deepEqual(await docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} }), { cleanup: 'removed' });
  assert.equal(docker.calls.filter(call => call.args[0] === 'rm').length, removeCount);
});

test('confirmed interrupted execution can be recovered without starting or retrying it and leaves unrelated containers alone', async () => {
  const context = await interruptedFixture();
  const unrelated = { ...structuredClone([...context.docker.containers.values()][0]), id: 'f'.repeat(64), name: '/unrelated-active-container' };
  context.docker.containers.set(unrelated.id, unrelated);
  const markerBefore = await readFile(join(context.statePath, 'marker.json'));
  const start = context.docker.calls.length;
  const result = await context.docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} });
  assert.deepEqual(result, { cleanup: 'removed' });
  assert.equal(context.docker.containers.size, 1);
  assert.equal(context.docker.containers.get(unrelated.id), unrelated);
  const calls = context.docker.calls.slice(start);
  assert.ok(calls.every(call => ['inspect', 'rm'].includes(call.args[0])));
  assert.ok(calls.some(call => call.args[0] === 'rm'));
  assert.deepEqual(await readFile(join(context.statePath, 'marker.json')), markerBefore);
  assert.ok(await readJson(join(context.statePath, 'containers', 'baseline.created.json')));
  for (const call of calls) {
    assert.equal(call.executable, '/usr/bin/docker');
    assert.deepEqual(call.rawArgs.slice(2, 4), ['--host', 'unix:///var/run/docker.sock']);
    assert.equal(call.options.shell, false);
    assert.deepEqual(Object.keys(call.options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH']);
  }
});

test('unconfirmed creation remains pending even after a late owned container is found and removed', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const context = await fixture();
  let owned = true;
  const docker = fakeDocker({ create: ({ containers }) => {
    owned = false;
    containers.clear();
    t.mock.timers.tick(100);
    return { hang: true };
  } });
  const run = await docker.run({ timeoutMs: 100 })({ ...context.input('baseline'), guard: () => { if (!owned) throw new Error('lease lost'); } });
  assert.equal(run.status, 'cleanup-failed');
  const input = { statePath: context.statePath, execution: context.execution, guard() {} };
  assert.deepEqual(await docker.recover()(input), { cleanup: 'pending', reason: 'creation-outcome-unknown' });
  assert.equal(docker.calls.filter(call => call.args[0] === 'rm').length, 0);
  docker.publishPending();
  assert.deepEqual(await docker.recover()(input), { cleanup: 'pending', reason: 'creation-outcome-unknown' });
  assert.equal(docker.containers.size, 0);
  assert.ok(await readJson(join(context.statePath, 'containers', 'baseline.cleanup.json')));
  assert.deepEqual(await docker.recover()(input), { cleanup: 'pending', reason: 'creation-outcome-unknown' });
});

test('recovery checks its guard before filesystem work and again immediately before removal', async () => {
  const context = await interruptedFixture();
  let callsBefore = context.docker.calls.length;
  const denied = await context.docker.recover()({ statePath: context.statePath, execution: context.execution, guard() { throw new Error('expired recovery lease'); } });
  assert.equal(denied.cleanup, 'failed');
  assert.equal(context.docker.calls.length, callsBefore);
  let ownership = true;
  const second = await interruptedFixture({ inspect: ({ call, response }) => {
    if (!call.args.includes('{{json .State}}')) ownership = false;
    return response;
  } });
  callsBefore = second.docker.calls.length;
  const lost = await second.docker.recover()({ statePath: second.statePath, execution: second.execution, guard() { if (!ownership) throw new Error('lease lost'); } });
  assert.equal(lost.cleanup, 'failed');
  assert.ok(second.docker.calls.slice(callsBefore).every(call => call.args[0] !== 'rm'));
  assert.equal(second.docker.containers.size, 1);
});

test('missing attempts and valid markers without journals need no Docker or Linux host', async () => {
  const context = await fixture();
  const docker = fakeDocker();
  const recover = docker.recover({ platform: 'win32', arch: 'arm64' });
  const input = { statePath: context.statePath, execution: context.execution, guard() {} };
  assert.deepEqual(await recover({ ...input, statePath: join(temporary, 'not-created-attempt') }), { cleanup: 'not-created' });
  assert.deepEqual(await recover(input), { cleanup: 'not-created' });
  await mkdir(join(context.statePath, 'containers'), { mode: 0o700 });
  assert.deepEqual(await recover(input), { cleanup: 'not-created' });
  assert.equal(docker.calls.length, 0);
});

test('partial or malformed markers and journal records fail conservatively', async () => {
  for (const content of ['', 'null', '{broken', JSON.stringify({ receiptId: randomUUID() })]) {
    const context = await fixture();
    await writeFile(join(context.statePath, 'marker.json'), content);
    const docker = fakeDocker();
    assert.equal((await docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} })).cleanup, 'failed');
    assert.equal(docker.calls.length, 0);
  }
  const partial = await fixture();
  await rm(join(partial.statePath, 'marker.json'));
  const noMarker = fakeDocker();
  assert.equal((await noMarker.recover()({ statePath: partial.statePath, execution: partial.execution, guard() {} })).cleanup, 'failed');
  assert.equal(noMarker.calls.length, 0);
  for (const filename of ['baseline.intent.json', 'baseline.created.json', 'baseline.cleanup.json']) {
    const context = await interruptedFixture();
    await writeFile(join(context.statePath, 'containers', filename), 'null', { mode: 0o600 });
    const start = context.docker.calls.length;
    assert.equal((await context.docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} })).cleanup, 'failed');
    assert.equal(context.docker.calls.length, start);
  }
});

test('recovery refuses changed ownership labels, image, command, security controls or snapshot mount', async () => {
  const mutations = [
    container => { container.name = container.name.replace('/self-managed-api-validation-', '/plumber-validation-'); },
    container => { container.name = `/self-managed-api-validation-${randomUUID()}`; },
    container => { container.labels['io.plumber.validation'] = randomUUID(); },
    container => { container.labels['io.plumber.request'] = '0'.repeat(64); },
    container => { container.labels['io.plumber.profile'] = '0'.repeat(64); },
    container => { container.imageId = `sha256:${'0'.repeat(64)}`; },
    container => { container.image = 'node:latest'; },
    container => { container.command.push('--eval=not-approved'); },
    container => { container.privileged = true; },
    container => { container.network = 'host'; },
    container => { container.securityOpt.push('seccomp=unconfined'); },
    container => { container.mounts[0].Source = dirname(container.mounts[0].Source); },
    container => { container.mounts[0].RW = true; },
  ];
  for (const mutate of mutations) {
    const context = await interruptedFixture();
    mutate([...context.docker.containers.values()][0]);
    const start = context.docker.calls.length;
    const result = await context.docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} });
    assert.equal(result.cleanup, 'failed');
    assert.equal(result.reason, 'container-identity-mismatch');
    assert.ok(context.docker.calls.slice(start).every(call => call.args[0] !== 'rm'));
    assert.equal(context.docker.containers.size, 1);
  }
});

test('recovery rejects journals with another name prefix before Docker access', async () => {
  for (const prefix of ['plumber-validation-', 'self-managed-api-validation-foreign-']) {
    const context = await interruptedFixture();
    const path = join(context.statePath, 'containers', 'baseline.intent.json');
    const intent = await readJson(path);
    const changed = { ...intent, containerName: `${prefix}${intent.owner}` };
    await writeFile(path, JSON.stringify(changed));
    const createdPath = join(context.statePath, 'containers', 'baseline.created.json');
    const created = await readJson(createdPath);
    await writeFile(createdPath, JSON.stringify({ ...created, intentSha256: jsonHash(changed) }));
    const before = context.docker.calls.length;
    const recovered = await context.docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} });
    assert.equal(recovered.cleanup, 'failed');
    assert.equal(context.docker.calls.length, before);
    assert.equal(context.docker.containers.size, 1);
  }
});

test('journals cannot be moved to another attempt, rebound, linked, or interpreted as arbitrary paths', async () => {
  const context = await interruptedFixture();
  const copied = await fixture();
  await copyFile(join(context.statePath, 'marker.json'), join(copied.statePath, 'marker.json'));
  await mkdir(join(copied.statePath, 'containers'), { mode: 0o700 });
  for (const file of ['baseline.intent.json', 'baseline.created.json']) {
    await copyFile(join(context.statePath, 'containers', file), join(copied.statePath, 'containers', file));
  }
  let before = context.docker.calls.length;
  assert.equal((await context.docker.recover()({ statePath: copied.statePath, execution: context.execution, guard() {} })).cleanup, 'failed');
  assert.equal(context.docker.calls.length, before);
  for (const changed of [
    { ...context.execution, intentId: '0'.repeat(64) }, { ...context.execution, requestId: '0'.repeat(64) },
    { ...context.execution, receiptId: '../escape' },
  ]) {
    assert.equal((await context.docker.recover()({ statePath: context.statePath, execution: changed, guard() {} })).cleanup, 'failed');
  }
  assert.equal(context.docker.calls.length, before);
  const linked = await fixture();
  await symlink(join(context.statePath, 'containers'), join(linked.statePath, 'containers'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await context.docker.recover()({ statePath: linked.statePath, execution: linked.execution, guard() {} })).cleanup, 'failed');
  assert.equal(context.docker.calls.length, before);
  const path = join(context.statePath, 'containers', 'baseline.intent.json');
  const intent = await readJson(path);
  await writeFile(path, JSON.stringify({ ...intent, containerName: '../../foreign-container' }));
  before = context.docker.calls.length;
  assert.equal((await context.docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} })).cleanup, 'failed');
  assert.equal(context.docker.calls.length, before);
});

test('daemon failure and an unverified removal never produce removed or erase evidence', async () => {
  for (const hooks of [
    { inspect: () => ({ code: 1, stderr: 'private daemon diagnostic' }) },
    { rm: ({ pending, containers }) => { containers.set(pending.id, pending); return { code: 1, stderr: 'private daemon diagnostic' }; } },
  ]) {
    const context = await interruptedFixture(hooks);
    const result = await context.docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} });
    assert.equal(result.cleanup, 'failed');
    assert.ok(!JSON.stringify(result).includes('private daemon diagnostic'));
    assert.ok(await readJson(join(context.statePath, 'marker.json')));
    assert.ok(await readJson(join(context.statePath, 'containers', 'baseline.intent.json')));
    await assert.rejects(access(join(context.statePath, 'containers', 'baseline.cleanup.json')), { code: 'ENOENT' });
  }
});

test('execution rejects wrong phase, marker, and repeated phase before creating a second container', async () => {
  const context = await fixture();
  const docker = fakeDocker();
  const wrong = await docker.run()({ ...context.input('baseline'), snapshotPath: join(context.statePath, 'candidate'), guard() {} });
  assert.equal(wrong.cleanup, 'not-created');
  assert.equal(wrong.containerName, undefined);
  assert.equal(docker.calls.length, 0);
  await writeFile(join(context.statePath, 'request.json'), JSON.stringify({ id: context.execution.requestId, padding: 'x'.repeat(5 * 1024 * 1024) }));
  const passed = await docker.run()({ ...context.input('baseline'), guard() {} });
  assert.equal(passed.status, 'passed', 'The adapter must not parse the full approved request as a small journal.');
  const before = docker.calls.filter(call => call.args[0] === 'create').length;
  const repeated = await docker.run()({ ...context.input('baseline'), guard() {} });
  assert.equal(repeated.status, 'blocked');
  assert.equal(repeated.cleanup, 'not-created');
  assert.equal(repeated.containerName, undefined);
  assert.equal(docker.calls.filter(call => call.args[0] === 'create').length, before);
});

test('baseline and candidate journals remain separate and recovery checks both phases', async () => {
  const context = await fixture();
  const docker = fakeDocker();
  for (const phase of ['baseline', 'candidate']) assert.equal((await docker.run()({ ...context.input(phase), guard() {} })).status, 'passed');
  const files = await readdir(join(context.statePath, 'containers'));
  assert.equal(files.length, 6);
  assert.deepEqual(await docker.recover()({ statePath: context.statePath, execution: context.execution, guard() {} }), { cleanup: 'removed' });
  assert.equal(docker.calls.filter(call => call.args[0] === 'create').length, 2);
  assert.equal(docker.calls.filter(call => call.args[0] === 'start').length, 2);
});
