import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { modelFile, selectProfile } from './profile.mjs';
import { cases } from './fixtures.mjs';
import { classifyEvaluation, evaluationPassed } from './classification.mjs';

const root = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--profile', 'Usage: pnpm dev:model-evaluation [--profile 1.5b|7b]');
const profileName = args[1] ?? '1.5b', profile = selectProfile(profileName), memoryGiB = profileName === '7b' ? 8 : 6;
const cpuLimit = profileName === '7b' ? 8 : 4;
const pnpm = process.env.npm_execpath;
assert.ok(isAbsolute(pnpm ?? ''), 'Run with pnpm dev:model-evaluation.');
const base = join(root, 'work/model-evaluation'), runId = randomUUID();
const directory = join(base, `run-${runId}`), runtime = join(directory, 'runtime'), output = join(directory, 'output');
const modelPath = modelFile(root, profileName);
assert.equal((await stat(modelPath)).size, profile.byteLength, 'Preload the reviewed model file before running this explicit lab.');
const hash = createHash('sha256');
for await (const bytes of createReadStream(modelPath)) hash.update(bytes);
assert.equal(hash.digest('hex'), profile.sha256, 'Model bytes must match the pinned public upstream artifact.');
await mkdir(base, { recursive: true });
assert.equal(await realpath(base), base, 'Evaluation root must be canonical.');
await mkdir(directory, { recursive: false, mode: 0o700 }); await mkdir(runtime); await mkdir(output);
// Only this public synthetic output mount is writable by the unprivileged
// container UID. The owning run directory prevents access by other host users.
if (process.platform !== 'win32') await chmod(output, 0o777);
assert.equal(await realpath(directory), directory);
const ownerLabel = `io.self-managed-api.model-evaluation=${runId}`, server = `self-managed-api-model-${runId}`, client = `self-managed-api-model-probe-${runId}`;
const containers = [];

async function run(command, args, { cwd = root, timeout = 60000, expected = 0 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COREPACK_ENABLE_NETWORK: '0', npm_config_offline: 'true', npm_config_update_notifier: 'false' } });
    let stdout = '', stderr = '', size = 0, expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => {
      size += bytes.length; if (size > 4 * 1024 * 1024) child.kill(); else if (name === 'stdout') stdout += bytes; else stderr += bytes;
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (expired || signal || size > 4 * 1024 * 1024) { reject(new Error('Evaluation subprocess exceeded its time/output limit.')); return; }
      if (expected !== null && code !== expected) { reject(new Error(`Evaluation subprocess exited ${code}: ${stderr.slice(-8192)} ${stdout.slice(-8192)}`)); return; }
      done({ code, stdout, stderr });
    });
  });
}
const isolation = ['--pull=never', '--platform=linux/amd64', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
  '--pids-limit=128', '--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777'];
try {
  for (const image of [profile.serverImage, profile.nodeImage]) await run('docker', ['image', 'inspect', image]);
  await run(process.execPath, [pnpm, 'pack', '--out', join(directory, 'self-managed-api.tgz')]);
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'self-managed-api-model-evaluation-runtime', private: true, type: 'module',
    dependencies: { 'self-managed-api': 'file:../self-managed-api.tgz' } }), { flag: 'wx' });
  // A flat, private install avoids host-absolute Windows junctions when mounted
  // into Linux; no package lifecycle scripts execute during installation.
  await run(process.execPath, [pnpm, 'install', '--offline', '--ignore-scripts', '--ignore-workspace', '--node-linker=hoisted'], { cwd: runtime });
  for (const file of ['probe.mjs', 'fixtures.mjs', 'profile.mjs', 'classification.mjs']) await copyFile(join(import.meta.dirname, file), join(runtime, file));
  containers.push(server);
  const started = performance.now();
  await run('docker', ['run', '-d', '--name', server, '--label', ownerLabel, ...isolation, '--network=none', '--no-healthcheck',
    `--cpus=${cpuLimit}`, `--memory=${memoryGiB}g`, `--memory-swap=${memoryGiB}g`, '--env=XDG_CACHE_HOME=/tmp',
    '--mount', `type=bind,source=${modelPath},target=/models/model.gguf,readonly`, profile.serverImage,
    '--model', '/models/model.gguf', '--alias', profile.model, '--host', '127.0.0.1', '--port', '8080', '--ctx-size', '4096',
    '--parallel', '1', '--threads', String(cpuLimit), '--threads-batch', String(cpuLimit), '--n-gpu-layers', '0', '--seed', '42', '--temp', '0',
    '--offline', '--no-webui', '--metrics']);
  const configured = JSON.parse((await run('docker', ['inspect', server])).stdout)[0];
  assert.equal(configured.HostConfig.NetworkMode, 'none'); assert.equal(configured.HostConfig.Memory, memoryGiB * 1024 ** 3);
  assert.equal(configured.HostConfig.NanoCpus, cpuLimit * 1e9); assert.equal(configured.HostConfig.ReadonlyRootfs, true);
  assert.equal(configured.Config.User, '65534:65534'); assert.equal(Object.keys(configured.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal(configured.Mounts.length, 1); assert.equal(configured.Mounts[0].RW, false);
  containers.push(client);
  const result = await run('docker', ['run', '--name', client, '--label', ownerLabel, ...isolation, `--network=container:${server}`,
    '--cpus=1', '--memory=512m', '--memory-swap=512m', `--env=SELF_MANAGED_API_MODEL_EVALUATION_PROFILE=${profileName}`, '--mount', `type=bind,source=${runtime},target=/runtime,readonly`,
    '--mount', `type=bind,source=${output},target=/output`, '--workdir=/runtime', profile.nodeImage, 'node', 'probe.mjs'], { timeout: 450000 });
  await writeFile(join(output, 'probe.stdout.txt'), result.stdout, { flag: 'wx' });
  await writeFile(join(output, 'probe.stderr.txt'), result.stderr, { flag: 'wx' });
  const peak = Number((await run('docker', ['exec', server, 'cat', '/sys/fs/cgroup/memory.peak'])).stdout.trim());
  const processes = (await run('docker', ['top', server, '-eo', 'pid,comm'])).stdout;
  const raw = JSON.parse(await readFile(join(output, 'proposals.json'), 'utf8'));
  for (const outcome of raw.outcomes) {
    const scenario = cases.find(value => value.id === outcome.id);
    assert.ok(scenario);
    assert.equal(outcome.expected, scenario.expected);
    outcome.behavior = classifyEvaluation(outcome);
    if (outcome.behavior !== 'awaiting-tests') continue;
    const proposal = JSON.parse(await readFile(join(output, `${outcome.id}.proposal.json`), 'utf8'));
    assert.equal(proposal.status, 'proposal-ready');
    const changed = proposal.preview.files.find(file => file.path === 'payment.mjs');
    if (!changed) { outcome.behavior = 'no-migration'; continue; }
    assert.equal(changed.before, scenario.source); assert.equal(changed.beforeSha256, createHash('sha256').update(scenario.source).digest('hex'));
    outcome.tests = [];
    for (const revision of ['baseline', 'candidate']) {
      const fixture = join(directory, `${outcome.id}-${revision}`); await mkdir(fixture);
      assert.equal(dirname(fixture), directory);
      await writeFile(join(fixture, 'payment.mjs'), revision === 'baseline' ? scenario.source : changed.after, { flag: 'wx' });
      await writeFile(join(fixture, 'payment.test.mjs'), scenario.test, { flag: 'wx' });
      const name = `self-managed-api-model-test-${runId}-${outcome.tests.length}-${raw.outcomes.indexOf(outcome)}`;
      containers.push(name);
      const test = await run('docker', ['run', '--name', name, '--label', ownerLabel, ...isolation, '--network=none', '--cpus=1', '--memory=256m', '--memory-swap=256m',
        '--mount', `type=bind,source=${fixture},target=/fixture,readonly`, '--workdir=/fixture', profile.nodeImage, 'node', '--test', 'payment.test.mjs'], { expected: null, timeout: 30000 });
      outcome.tests.push({ revision, exitCode: test.code, testSha256: createHash('sha256').update(scenario.test).digest('hex') });
      await writeFile(join(output, `${outcome.id}-${revision}.test.txt`), test.stdout + test.stderr, { flag: 'wx' });
    }
    outcome.behavior = classifyEvaluation(outcome);
  }
  const report = { schemaVersion: 1, syntheticOnly: true, profile, cpuLimit, memoryLimitBytes: memoryGiB * 1024 ** 3, parallelRequests: 1,
    contextTokens: 4096, maximumOutputTokens: 1024, deadlineMs: 120000, peakCgroupMemoryBytes: peak, elapsedMs: Math.round(performance.now() - started),
    network: 'none', externalProbe: raw.externalProbe, outputsAreUnapproved: true, outcomes: raw.outcomes };
  await writeFile(join(output, 'evaluation.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  await writeFile(join(output, 'processes.txt'), processes, { flag: 'wx' });
  console.log(JSON.stringify({ directory, peakCgroupMemoryBytes: peak, outcomes: report.outcomes }, null, 2));
  process.exitCode = report.outcomes.every(evaluationPassed) ? 0 : 1;
} finally {
  for (const name of containers.reverse()) {
    const inspected = await run('docker', ['inspect', name], { expected: null });
    if (inspected.code !== 0) continue;
    const value = JSON.parse(inspected.stdout)[0];
    assert.equal(value.Config.Labels['io.self-managed-api.model-evaluation'], runId, 'Cleanup is restricted to this evaluation container.');
    if (name === server) {
      const logs = await run('docker', ['logs', '--tail', '300', name], { expected: null });
      await writeFile(join(output, 'server.log'), logs.stdout + logs.stderr, { flag: 'wx' });
    }
    await run('docker', ['rm', '-f', name]);
  }
}
