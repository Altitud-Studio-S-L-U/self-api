import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServiceFixture } from './service-fixture.mjs';
import { renderWorkerServiceManifest } from '../dist/worker-service-config.js';
import { listSourceSubscriptions, listSourceObservations } from '../dist/index.js';

// This acceptance test installs one temporary native service on a disposable
// hosted runner. It must never install a service on a developer's workstation.
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const repository = resolve(import.meta.dirname, '..');
const name = `keepseamci${randomBytes(6).toString('hex')}`;
const target = ({ win32: 'windows', linux: 'systemd', darwin: 'launchd' })[process.platform];
assert(target, 'Unsupported native supervisor');
const userScope = process.argv[2] === '--user';
assert.equal(process.argv.length, userScope ? 3 : 2, 'Only the explicit --user mode is supported');
assert(!userScope || target === 'systemd', 'User scope is supported only by systemd');
assert(!userScope || process.getuid() !== 0, 'The user manager must be non-root');
const directory = target === 'systemd' && !userScope ? `/opt/${name}` : join(repository, 'work', name);
assert.equal(basename(directory), name);
const environment = userScope ? {
  ...process.env,
  XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus`,
} : process.env;
const run = (file, args, allowFailure = false) => {
  try { return execFileSync(file, args, { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 200_000 }); }
  catch (error) {
    if (allowFailure) return '';
    throw new Error(`${basename(file)} ${args[0]} failed: ${String(error.stderr ?? error.message).slice(0, 3000)}`);
  }
};
const systemctl = (args, allowFailure = false) => userScope
  ? run('systemctl', ['--user', ...args], allowFailure)
  : run('sudo', ['systemctl', ...args], allowFailure);
let installed = false;
let directoryCreated = false;
let manifestPath;
let wrapper;
let fixture;
const started = Date.now();
async function until(predicate, message, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(250);
  }
  throw new Error(message);
}
const windowsStopped = () => until(() => run(wrapper, ['status']).trim() === 'Stopped', 'SCM did not complete the service stop', 180_000);
const assertOwned = () => {
  assert.equal(basename(directory), name);
  if (target === 'systemd' && !userScope) assert.equal(directory, `/opt/${name}`);
  else { const child = relative(join(repository, 'work'), directory); assert.equal(child, name); assert(!child.includes(sep)); }
};
try {
  // Hosted jobs need not originate in a login session. Provision their user
  // manager only on this disposable runner, without enabling linger.
  if (userScope) run('sudo', ['systemctl', 'start', `user@${process.getuid()}.service`]);
  if (target === 'systemd' && !userScope) {
    run('sudo', ['mkdir', '-m', '700', directory]);
    directoryCreated = true;
    run('sudo', ['chown', `${process.getuid()}:${process.getgid()}`, directory]);
  } else {
    await mkdir(join(repository, 'work'), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    directoryCreated = true;
  }
  if (target === 'windows') {
    run('icacls.exe', [directory, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-19:(OI)(CI)RX']);
  }
  // System scope hides home; user scope intentionally exercises read-only home.
  // Both use the exact generated sandbox with writes only to state directories.
  await cp(join(repository, 'dist'), join(directory, 'dist'), { recursive: true });
  await cp(join(repository, 'node_modules'), join(directory, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  await cp(join(repository, 'package.json'), join(directory, 'package.json'));
  fixture = await createServiceFixture(join(directory, 'fixture'));
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  if (target === 'windows') {
    run('icacls.exe', [fixture.statePath, '/grant:r', '*S-1-5-19:(OI)(CI)F', '/T']);
    run('icacls.exe', [directory, '/setowner', '*S-1-5-32-544', '/T']);
  }
  const manifest = userScope ? run(process.execPath, [join(directory, 'dist', 'cli.js'), 'worker-service', 'render', '--config', fixture.configPath,
    '--target', 'systemd', '--scope', 'user', '--node', process.execPath, '--cli', join(directory, 'dist', 'cli.js'), '--name', name])
    : renderWorkerServiceManifest({ config, configPath: fixture.configPath, target, nodePath: process.execPath,
      cliPath: join(directory, 'dist', 'cli.js'), name, ...(target === 'windows' ? {} : { user: userInfo().username }) });
  manifestPath = join(directory, target === 'systemd' ? `${name}.service` : target === 'launchd' ? `${name}.plist` : `${name}.xml`);
  await writeFile(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
  const statusPath = join(fixture.statePath, 'worker-service.status.json');
  async function status() { try { return JSON.parse(await readFile(statusPath, 'utf8')); } catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null; throw error; } }
  const running = oldRun => until(async () => {
    const value = await status();
    return value && value.state === 'running' && value.cycles > 0 && value.runId !== oldRun ? value : false;
  }, 'Native service did not complete a real observation cycle');
  async function start() {
    if (target === 'systemd') systemctl(['start', `${name}.service`]);
    else if (target === 'launchd') { run('sudo', ['launchctl', 'bootstrap', 'system', manifestPath]); installed = true; }
    else run(wrapper, ['start']);
  }
  async function stop() {
    if (target === 'systemd') systemctl(['stop', `${name}.service`]);
    else if (target === 'launchd') { run('sudo', ['launchctl', 'bootout', 'system', manifestPath]); installed = false; }
    else {
      run(wrapper, ['stop']);
      // WinSW's stop command returns during StopPending. A new start at that
      // point is ignored, so await the manager's completed transition first.
      await windowsStopped();
    }
  }
  if (target === 'systemd') {
    if (userScope) run('systemd-analyze', ['--user', 'verify', manifestPath]);
    else run('sudo', ['systemd-analyze', 'verify', manifestPath]);
    systemctl(['link', manifestPath]); installed = true;
    systemctl(['daemon-reload']);
    if (userScope) {
      systemctl(['enable', `${name}.service`]);
      assert.equal(systemctl(['is-enabled', `${name}.service`]).trim(), 'enabled');
    }
  } else if (target === 'launchd') {
    run('plutil', ['-lint', manifestPath]);
    run('sudo', ['chown', 'root:wheel', manifestPath]);
    run('sudo', ['chmod', '644', manifestPath]);
  } else {
    const response = await fetch('https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe', { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    // Pinned bytes from the official release asset, not an Authenticode claim.
    assert.equal(bytes.length, 655872);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f');
    wrapper = join(directory, `${name}.exe`); await writeFile(wrapper, bytes, { flag: 'wx' });
    run(wrapper, ['install']); installed = true;
  }
  // A stop issued before the application has produced its first status must
  // still return through the native manager, rather than wait on a missing PID.
  await start();
  await stop();
  await start();
  const first = await running();
  const initial = (await listSourceSubscriptions({ statePath: fixture.statePath })).find(item => item.id === fixture.subscriptionId);
  assert(initial?.lastSucceededAt && initial.lastError === null, 'The supervisor must run the real source observer');
  assert(Number.isSafeInteger(first.pid) && first.pid > 0 && first.pid !== process.pid);
  if (userScope) {
    assert(run('findmnt', ['--task', String(first.pid), '--target', fixture.sourcePath, '--noheadings', '--output', 'OPTIONS']).trim().split(',').includes('ro'), 'Consumer source must be mounted read-only');
    assert(run('findmnt', ['--task', String(first.pid), '--target', fixture.statePath, '--noheadings', '--output', 'OPTIONS']).trim().split(',').includes('rw'), 'Private state must remain writable');
  }
  // The PID is read only from this test's private, uniquely named state.
  if (target === 'systemd') systemctl(['kill', '--kill-whom=main', '--signal=SIGKILL', `${name}.service`]);
  else if (target === 'launchd') run('sudo', ['launchctl', 'kill', 'SIGKILL', `system/com.keepseam.${name}`]);
  else run('taskkill.exe', ['/PID', String(first.pid), '/F']);
  const recovered = await running(first.runId);
  assert.notEqual(recovered.pid, first.pid);
  await writeFile(fixture.sourcePath, JSON.stringify({ type: 'object', properties: { id: { type: 'string' }, region: { type: 'string' } }, required: ['id', 'region'] }));
  await until(async () => {
    const current = (await listSourceSubscriptions({ statePath: fixture.statePath })).find(item => item.id === fixture.subscriptionId);
    return current?.lastObservedSha !== initial.lastObservedSha && current?.lastError === null;
  }, 'Recovered service did not observe the changed contract');
  const observations = await listSourceObservations({ statePath: fixture.statePath, subscriptionId: fixture.subscriptionId });
  assert(observations.length > 0 && observations.every(item => item.authorization === 'not-granted'));
  await stop();
  const stopped = await until(async () => { const value = await status(); return value?.state === 'stopped' ? value : false; }, 'Native supervisor failed to drain the worker');
  assert.equal(stopped.runId, recovered.runId);
  await delay(userScope ? 35_000 : 1500);
  assert.equal((await status()).runId, stopped.runId);
  assert.equal((await status()).state, 'stopped');
  await start();
  const restarted = await running(stopped.runId);
  assert.notEqual(restarted.runId, stopped.runId);
  if (userScope) {
    // Only the disposable runner's manager is restarted. This asserts that the
    // enabled default.target unit starts again without a manual service start.
    run('sudo', ['systemctl', 'restart', `user@${process.getuid()}.service`]);
    const reactivated = await running(restarted.runId);
    assert.notEqual(reactivated.pid, restarted.pid);
    assert.equal(systemctl(['is-enabled', `${name}.service`]).trim(), 'enabled');
  }
  await stop();
  assert.equal((await status()).state, 'stopped');
  process.stdout.write(`Native ${target}${userScope ? ' user scope (including manager restart)' : ''}: real observation, crash recovery, graceful stop and explicit restart passed (${Math.round((Date.now() - started) / 1000)}s).\n`);
} catch (error) {
  // Only this credential-free, fictional fixture is diagnosed. Keep failures
  // visible before removing the disposable native service and its state.
  if (fixture) {
    for (const filename of ['worker-service.status.json', 'worker-service.log', `${name}.err.log`, `${name}.out.log`, `${name}.wrapper.log`]) {
      try {
        const contents = await readFile(join(fixture.statePath, filename), 'utf8');
        process.stderr.write(`${filename}:\n${contents.slice(-6000)}\n`);
      } catch (readError) { if (readError.code !== 'ENOENT') process.stderr.write(`${filename}: ${readError.code}\n`); }
    }
    if (target === 'windows' && wrapper) process.stderr.write(run(wrapper, ['status'], true));
    if (target === 'systemd' && installed) {
      process.stderr.write(systemctl(['show', `${name}.service`, '--property=ActiveState,SubState,Result,MainPID'], true));
      const journalArguments = ['journalctl', ...(userScope ? ['--user'] : []), '--unit', `${name}.service`, '--lines=30', '--no-pager'];
      process.stderr.write(userScope ? run(journalArguments[0], journalArguments.slice(1), true) : run('sudo', journalArguments, true));
    }
  }
  throw error;
} finally {
  assertOwned();
  if (target === 'systemd' && installed) {
    systemctl(['stop', `${name}.service`], true);
    systemctl(['disable', `${name}.service`]);
    systemctl(['daemon-reload']);
    systemctl(['reset-failed', `${name}.service`], true);
  } else if (target === 'launchd' && installed) run('sudo', ['launchctl', 'bootout', 'system', manifestPath]);
  else if (target === 'windows' && installed) {
    run(wrapper, ['stop'], true);
    await windowsStopped();
    run(wrapper, ['uninstall']);
  }
  if (directoryCreated) {
    if (target === 'windows') run('icacls.exe', [directory, '/grant:r', `${userInfo().username}:(OI)(CI)F`, '/T']);
    await rm(directory, { recursive: true, force: true });
  }
}
