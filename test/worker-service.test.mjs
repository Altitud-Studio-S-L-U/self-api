import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createServiceFixture } from '../tooling/service-fixture.mjs';
import { loadWorkerServiceConfig, requestWorkerServiceStop, runWorkerService } from '../dist/index.js';
import { appendServiceLog, serviceFailureDetails, serviceFiles } from '../dist/worker-service-state.js';
import { listSourceObservations } from '../dist/source-observer.js';
import { runWorkerServiceCli } from '../dist/worker-service-cli.js';

const parent = resolve('work/test-worker-service');
const cli = resolve('dist/cli.js');
function restrictFixture(directory) {
  if (process.platform !== 'win32') return;
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$targets = @((Get-Item -LiteralPath $env:KEEPSEAM_TEST_DIRECTORY)) + @(Get-ChildItem -LiteralPath $env:KEEPSEAM_TEST_DIRECTORY -Recurse -Force)
foreach ($target in $targets) {
  $acl = Get-Acl -LiteralPath $target.FullName
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
  $acl.SetOwner($sid)
  foreach ($allowed in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($allowed)
    if ($target.PSIsContainer) { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') }
    else { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $target.FullName -AclObject $acl
}
`;
  execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'),
      KEEPSEAM_TEST_DIRECTORY: directory }, windowsHide: true, stdio: 'pipe', timeout: 30000 });
}
async function fixture(t) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'service-'));
  const value = await createServiceFixture(directory);
  restrictFixture(directory);
  t.after(async () => {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), await realpath(parent)); assert(basename(actual).startsWith('service-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { directory, ...value };
}
async function waitForStatus(statePath, predicate, timeout = 45000, processInfo) {
  const deadline = Date.now() + timeout;
  let lastStatus;
  while (Date.now() < deadline) {
    let status;
    try { status = JSON.parse(await readFile(join(statePath, serviceFiles.status), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (status && predicate(status)) return status;
    lastStatus = status;
    if (processInfo && (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null)) break;
    await delay(50);
  }
  // These fixtures contain fictional contracts only. Retain actionable failure
  // evidence before their cleanup instead of reporting every exit as a timeout.
  let log;
  try { log = (await readFile(join(statePath, serviceFiles.log), 'utf8')).slice(-4096); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  throw new Error(`Worker did not reach the expected observable lifecycle state: ${JSON.stringify({ lastStatus,
    exitCode: processInfo?.child.exitCode, signal: processInfo?.child.signalCode, stderr: processInfo?.stderr().slice(-4096), log })}`);
}
function launch(configPath) {
  const child = spawn(process.execPath, [cli, 'worker-service', 'run', '--config', configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  return { child, exited, stderr: () => stderr };
}

test('real foreground service prevents concurrent ownership, resumes durable evidence and drains a run-scoped stop', async t => {
  const item = await fixture(t);
  const config = await loadWorkerServiceConfig(item.configPath);
  let active;
  t.after(async () => { if (active && active.child.exitCode === null && active.child.signalCode === null) { active.child.kill(); await active.exited; } });
  active = launch(item.configPath);
  const first = await waitForStatus(item.statePath, value => value.state === 'running' && value.cycles >= 1, 45000, active);
  assert.equal(first.pid, active.child.pid);
  const contender = launch(item.configPath);
  assert.equal((await contender.exited)[0], 2);
  assert.match(contender.stderr(), /already owns this state/);
  assert.equal(requestWorkerServiceStop(config).runId, first.runId);
  assert.equal((await active.exited)[0], 0, active.stderr());
  const stopped = await waitForStatus(item.statePath, value => value.state === 'stopped');
  assert.equal(stopped.runId, first.runId);
  const before = await listSourceObservations({ statePath: item.statePath });
  active = launch(item.configPath);
  const second = await waitForStatus(item.statePath, value => value.state === 'running' && value.runId !== first.runId && value.cycles >= 1, 45000, active);
  assert.notEqual(second.pid, first.pid);
  // The old stop marker must not terminate this new instance; unchanged evidence is not duplicated.
  await waitForStatus(item.statePath, value => value.runId === second.runId && value.cycles >= 2, 45000, active);
  assert.equal((await listSourceObservations({ statePath: item.statePath })).length, before.length);
  requestWorkerServiceStop(config);
  assert.equal((await active.exited)[0], 0, active.stderr());
});

test('forced process loss releases singleton ownership without deleting a stale PID file', async t => {
  const item = await fixture(t);
  let active = launch(item.configPath);
  t.after(async () => { if (active.child.exitCode === null && active.child.signalCode === null) { active.child.kill(); await active.exited; } });
  const first = await waitForStatus(item.statePath, value => value.state === 'running');
  active.child.kill('SIGKILL'); await active.exited;
  active = launch(item.configPath);
  await waitForStatus(item.statePath, value => value.state === 'running' && value.runId !== first.runId);
  requestWorkerServiceStop(await loadWorkerServiceConfig(item.configPath));
  assert.equal((await active.exited)[0], 0, active.stderr());
});

test('cancellation waits for an active observer and never authorizes execution or writes untrusted evidence into logs', async t => {
  const item = await fixture(t);
  const config = await loadWorkerServiceConfig(item.configPath);
  const controller = new AbortController();
  let release; const pending = new Promise(resolveStep => { release = resolveStep; });
  let entered; const started = new Promise(resolveStep => { entered = resolveStep; });
  let finished = false;
  const run = runWorkerService(config, { signal: controller.signal, dependencies: { observeSources: async options => {
    entered(); await pending;
    assert(options.signal.aborted);
    return { schemaVersion: 1, results: [{ status: 'failed', reason: 'SECRET source contents must not be logged' }] };
  } } }).then(result => { finished = true; return result; });
  await started; controller.abort(); await delay(10); assert.equal(finished, false);
  release(); assert.equal((await run).state, 'stopped');
  const log = await readFile(join(item.statePath, serviceFiles.log), 'utf8');
  assert.doesNotMatch(log, /SECRET|source contents/);
  assert.match(log, /"failed":1/);
});

test('repeated failures back off while observation remains local and logs stay bounded', async t => {
  const item = await fixture(t);
  const config = await loadWorkerServiceConfig(item.configPath);
  const controller = new AbortController();
  let calls = 0;
  const result = await runWorkerService(config, { signal: controller.signal, dependencies: { observeSources: async () => {
    calls += 1; if (calls === 2) controller.abort();
    throw new Error('never leak this untrusted error');
  } } });
  assert.equal(result.state, 'stopped'); assert.equal(calls, 2);
  const observations = (await readFile(join(item.statePath, serviceFiles.log), 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.event === 'observation');
  assert.deepEqual(observations.map(row => row.retryAfterMs), [2000, 4000]);
  for (let i = 0; i < 140; i++) appendServiceLog(item.statePath, { event: 'bounded-fixture', data: 'x'.repeat(8192) });
  assert((await readFile(join(item.statePath, serviceFiles.log))).byteLength <= 1024 * 1024);
  assert((await readFile(join(item.statePath, serviceFiles.archive))).byteLength <= 1024 * 1024);
  assert.doesNotMatch(await readFile(join(item.statePath, serviceFiles.archive), 'utf8'), /never leak/);
});

test('service refuses writable configuration and public private-state permissions on Unix', async t => {
  if (process.platform === 'win32') {
    const item = await fixture(t);
    const broad = join(item.directory, 'unrestricted');
    await mkdir(broad);
    // Grant another identity read access: Windows mode bits cannot detect this exposure.
    execFileSync('icacls.exe', [broad, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
    await assert.rejects(runWorkerService({ schemaVersion: 1, statePath: broad, sources: {} }), /restricted native ACLs/);
    return;
  }
  const item = await fixture(t);
  await chmod(item.configPath, 0o666);
  await assert.rejects(loadWorkerServiceConfig(item.configPath), /must not be group/);
  await chmod(item.configPath, 0o600);
  await chmod(item.statePath, 0o755);
  await assert.rejects(runWorkerService(await loadWorkerServiceConfig(item.configPath)), /must be private/);
});

test('invalid service CLI options cannot start a process or hide a configuration error', async () => {
  const result = spawn(process.execPath, [cli, 'worker-service', 'run', '--config', 'missing.json', '--http'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; result.stderr.on('data', chunk => { output += chunk; });
  assert.equal((await once(result, 'exit'))[0], 2);
  assert.match(output, /SERVICE_FAILED|INVALID_INPUT/);
});

test('native failure diagnostics expose only allowlisted codes and operations without evaluating getters', () => {
  const native = Object.assign(new Error('SECRET path and payload'), { code: 'EACCES', syscall: 'rename', path: '/SECRET', dest: '/SECRET' });
  assert.deepEqual(serviceFailureDetails(native), { systemCode: 'EACCES', operation: 'rename' });
  assert.deepEqual(serviceFailureDetails(Object.assign(new Error('SECRET'), { code: 'SECRET', syscall: 'SECRET' })), {});
  const accessor = new Error('SECRET');
  Object.defineProperties(accessor, { code: { get() { assert.fail('Do not evaluate an error code accessor'); } },
    syscall: { get() { assert.fail('Do not evaluate an operation accessor'); } } });
  assert.deepEqual(serviceFailureDetails(accessor), {});
  assert.deepEqual(serviceFailureDetails({ code: 'EACCES', syscall: 'rename', message: 'SECRET' }), {});
  assert.deepEqual(serviceFailureDetails(new Proxy(native, { getOwnPropertyDescriptor() { throw new Error('SECRET'); } })), {});
});

test('service CLI reports a native filesystem error without revealing its private path', async () => {
  let output = '', errors = '';
  const privatePath = resolve('work/service-private-missing/SECRET-never-log.json');
  assert.equal(await runWorkerServiceCli(['worker-service', 'run', '--config', privatePath], {
    stdout: text => { output += text; }, stderr: text => { errors += text; },
  }), 2);
  assert.equal(output, '');
  const result = JSON.parse(errors).error;
  assert.equal(result.code, 'SERVICE_FAILED');
  assert.equal(result.systemCode, 'ENOENT');
  assert.equal(result.operation, 'lstat');
  assert.doesNotMatch(errors, /SECRET|service-private-missing|stack/);
});

test('failed status persistence retains an independent sanitized failure log', async t => {
  const item = await fixture(t);
  const config = await loadWorkerServiceConfig(item.configPath);
  await assert.rejects(runWorkerService(config, { dependencies: { observeSources: async () => {
    await mkdir(join(item.statePath, `${serviceFiles.status}.next`));
    return { schemaVersion: 1, results: [{ status: 'unchanged' }] };
  } } }), /Service runtime files cannot be links or special files/);
  const entries = (await readFile(join(item.statePath, serviceFiles.log), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.at(-1).event, 'failed');
  assert.equal(entries.at(-1).reason, 'local-operation-failed');
  assert.deepEqual(Object.keys(entries.at(-1)).sort(), ['event', 'reason', 'runId', 'timestamp']);
  assert.equal(JSON.parse(await readFile(join(item.statePath, serviceFiles.status), 'utf8')).state, 'starting');
});
