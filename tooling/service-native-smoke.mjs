import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServiceFixture } from './service-fixture.mjs';
import { renderWorkerServiceManifest } from '../dist/worker-service-config.js';
import { listSourceSubscriptions, listSourceObservations } from '../dist/index.js';
import { provisionWindowsServiceFixture, readWindowsServiceEvidence } from './service-native-windows-fixture.mjs';

// This acceptance test installs one temporary native service on a disposable
// hosted runner. It must never install a service on a developer's workstation.
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const repository = resolve(import.meta.dirname, '..');
const name = `keepseamci${randomBytes(6).toString('hex')}`;
const target = ({ win32: 'windows', linux: 'systemd', darwin: 'launchd' })[process.platform];
assert(target, 'Unsupported native supervisor');
const userScope = process.argv[2] === '--user';
const expectNamespaceDenial = process.argv[3] === '--expect-namespace-denial';
assert.equal(process.argv.length, expectNamespaceDenial ? 4 : userScope ? 3 : 2, 'Unsupported native acceptance arguments');
assert(!expectNamespaceDenial || userScope, 'Namespace rejection requires explicit user scope');
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
    assertOwned();
    await provisionWindowsServiceFixture(directory, fixture);
  }
  const sourceSubscriptions = async () => target === 'windows'
    ? [(await readWindowsServiceEvidence(fixture.statePath, fixture.subscriptionId)).subscription]
    : listSourceSubscriptions({ statePath: fixture.statePath });
  const assertUnapprovedObservations = async () => {
    if (target === 'windows') {
      const evidence = await readWindowsServiceEvidence(fixture.statePath, fixture.subscriptionId);
      assert(evidence.observations.length > 0, 'The service must persist real observations');
      // Administrative read-only inspection must not create execution approval
      // or open the service's private store under the seeding runner's identity.
      assert.equal(evidence.jobs, 0);
      assert.equal(evidence.executionIntents, 0);
    } else {
      const observations = await listSourceObservations({ statePath: fixture.statePath, subscriptionId: fixture.subscriptionId });
      assert(observations.length > 0 && observations.every(item => item.authorization === 'not-granted'));
    }
  };
  const manifest = userScope ? run(process.execPath, [join(directory, 'dist', 'cli.js'), 'worker-service', 'render', '--config', fixture.configPath,
    '--target', 'systemd', '--scope', 'user', '--node', process.execPath, '--cli', join(directory, 'dist', 'cli.js'), '--name', name])
    : renderWorkerServiceManifest({ config, configPath: fixture.configPath, target, nodePath: process.execPath,
      cliPath: join(directory, 'dist', 'cli.js'), name, ...(target === 'windows' ? {} : { user: userInfo().username }) });
  manifestPath = join(directory, target === 'systemd' ? `${name}.service` : target === 'launchd' ? `${name}.plist` : `${name}.xml`);
  await writeFile(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
  const statusPath = join(fixture.statePath, 'worker-service.status.json');
  async function status() { try { return JSON.parse(await readFile(statusPath, 'utf8')); } catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null; throw error; } }
  const running = (oldRun, minimumCycles = 1) => until(async () => {
    const value = await status();
    return value && value.state === 'running' && value.cycles >= minimumCycles && value.runId !== oldRun ? value : false;
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
  if (expectNamespaceDenial) {
    assert.match(await readFile('/etc/os-release', 'utf8'), /^VERSION_ID="24\.04"$/m, 'Rejection acceptance targets the restricted Ubuntu 24.04 image');
    assert.equal(run('sysctl', ['--values', 'kernel.apparmor_restrict_unprivileged_userns']).trim(), '1');
    const result = spawnSync('systemctl', ['--user', 'start', `${name}.service`], {
      env: environment, encoding: 'utf8', timeout: 200_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, 'The restricted manager must refuse startup');
    const properties = Object.fromEntries(systemctl(['show', `${name}.service`, '--property=MainPID,ExecMainStatus,Result'])
      .trim().split('\n').map(line => line.split('=')));
    assert.equal(properties.MainPID, '0');
    assert.equal(properties.ExecMainStatus, '226', 'Only an explicit NAMESPACE failure is expected');
    assert.equal(properties.Result, 'exit-code');
    await stop();
    assert.equal(await status(), null, 'The rejected unit must never enter the worker runtime');
    const subscriptions = await listSourceSubscriptions({ statePath: fixture.statePath });
    assert.equal(subscriptions.find(item => item.id === fixture.subscriptionId)?.lastSucceededAt, null);
    assert.deepEqual(await listSourceObservations({ statePath: fixture.statePath, subscriptionId: fixture.subscriptionId }), []);
    process.stdout.write('Restricted systemd user manager: NAMESPACE rejection, no process, no status and no observations passed.\n');
    process.stdout.write(run('systemctl', ['--version']));
    process.stdout.write(run('sysctl', ['kernel.apparmor_restrict_unprivileged_userns'], true));
    const audit = run('sudo', ['dmesg', '--color=never'], true).split('\n').filter(line => /apparmor.*DENIED/u.test(line));
    process.stdout.write(`${audit.slice(-20).join('\n')}\n`);
  } else {
    // A stop issued before the application has produced its first status must
    // still return through the native manager, rather than wait on a missing PID.
    await start();
    await stop();
    await start();
    const first = await running();
    const initial = (await sourceSubscriptions()).find(item => item.id === fixture.subscriptionId);
    assert(initial?.lastSucceededAt && initial.lastError === null, 'The supervisor must run the real source observer');
    assert(Number.isSafeInteger(first.pid) && first.pid > 0 && first.pid !== process.pid);
    if (target === 'systemd') {
      const group = systemctl(['show', `${name}.service`, '--property=ControlGroup', '--value']).trim();
      assert(group.startsWith('/') && !group.split('/').includes('..') && basename(group) === `${name}.service`);
      const membership = (await readFile(`/proc/${first.pid}/cgroup`, 'utf8')).trim().split('\n');
      assert(membership.includes(`0::${group}`), 'Worker must belong to its own cgroup v2 service');
      const cgroup = `/sys/fs/cgroup${group}`;
      for (const [file, expected] of [['memory.high', '402653184'], ['memory.max', '536870912'],
        ['memory.swap.max', '0'], ['pids.max', '128']]) {
        assert.equal((await readFile(join(cgroup, file), 'utf8')).trim(), expected,
          `Kernel must enforce ${file}; a rendered directive alone is insufficient`);
      }
      const [quota, period] = (await readFile(join(cgroup, 'cpu.max'), 'utf8')).trim().split(/\s+/u).map(Number);
      assert(Number.isSafeInteger(quota) && quota > 0 && Number.isSafeInteger(period) && period > 0 && quota === period,
        'Kernel must enforce one CPU of quota for this service');
      assert.equal(systemctl(['show', `${name}.service`, '--property=OOMPolicy', '--value']).trim(), 'stop');
    }
    if (userScope) {
      const sourceMount = run('findmnt', ['--task', String(first.pid), '--target', fixture.sourcePath, '--noheadings', '--output', 'OPTIONS']).trim();
      const stateMount = run('findmnt', ['--task', String(first.pid), '--target', fixture.statePath, '--noheadings', '--output', 'OPTIONS']).trim();
      if (!sourceMount.split(',').includes('ro') || !stateMount.split(',').includes('rw')) {
        const mounts = (await readFile(`/proc/${first.pid}/mountinfo`, 'utf8')).split('\n').filter(line => {
          const target = line.split(' ')[4];
          return target && (target === '/' || fixture.sourcePath.startsWith(`${target}/`) || fixture.statePath === target || fixture.statePath.startsWith(`${target}/`));
        });
        process.stderr.write(`${JSON.stringify({ sourceMount, stateMount, mounts,
          workerNamespace: await readlink(`/proc/${first.pid}/ns/mnt`), testNamespace: await readlink('/proc/self/ns/mnt') })}\n`);
        process.stderr.write(systemctl(['show', `${name}.service`, '--property=ProtectHome,ProtectSystem,PrivateUsers,ReadWritePaths']));
        process.stderr.write(run('findmnt', ['--version']));
      }
      assert(sourceMount.split(',').includes('ro'), 'Consumer source must be mounted read-only');
      assert(stateMount.split(',').includes('rw'), 'Private state must remain writable');
      for (const path of ['/tmp', '/var/tmp']) {
        const temporaryMount = run('findmnt', ['--task', String(first.pid), '--target', path, '--noheadings', '--output', 'FSTYPE,OPTIONS']).trim();
        assert(temporaryMount.startsWith('tmpfs ') && temporaryMount.includes('size=65536k'), 'User temporary storage must be private bounded tmpfs');
      }
    }
    // The PID is read only from this test's private, uniquely named state.
    if (target === 'systemd') systemctl(['kill', '--kill-who=main', '--signal=SIGKILL', `${name}.service`]);
    else if (target === 'launchd') run('sudo', ['launchctl', 'kill', 'SIGKILL', `system/com.keepseam.${name}`]);
    else run('taskkill.exe', ['/PID', String(first.pid), '/F']);
    let recovered = await running(first.runId, target === 'windows' ? 2 : 1);
    assert.notEqual(recovered.pid, first.pid);
    await writeFile(fixture.sourcePath, JSON.stringify({ type: 'object', properties: { id: { type: 'string' }, region: { type: 'string' } }, required: ['id', 'region'] }));
    await until(async () => {
      const current = (await sourceSubscriptions()).find(item => item.id === fixture.subscriptionId);
      return current?.lastObservedSha !== initial.lastObservedSha && current?.lastError === null;
    }, 'Recovered service did not observe the changed contract');
    await assertUnapprovedObservations();
    if (target === 'windows') {
      // Both losses must recover; this is not a retry of a failed assertion.
      // Keep SCM's configured 30s/60s recovery schedule. A third forced failure
      // would correctly wait 300s, so this bounded acceptance stops at two.
      run('taskkill.exe', ['/PID', String(recovered.pid), '/F']);
      const secondRecovery = await running(recovered.runId, 2);
      assert.notEqual(secondRecovery.pid, recovered.pid);
      recovered = secondRecovery;
    }
    await stop();
    const stopped = await until(async () => { const value = await status(); return value?.state === 'stopped' ? value : false; }, 'Native supervisor failed to drain the worker');
    assert.equal(stopped.runId, recovered.runId);
    await delay(userScope ? 35_000 : 1500);
    assert.equal((await status()).runId, stopped.runId);
    assert.equal((await status()).state, 'stopped');
    await start();
    let restarted = await running(stopped.runId, target === 'windows' ? 2 : 1);
    assert.notEqual(restarted.runId, stopped.runId);
    if (target === 'windows') {
      // Exercise three clean restarts in total, including the one above. Every
      // start must persist multiple healthy cycles before the next stop.
      for (let restart = 1; restart < 3; restart++) {
        await stop();
        const stoppedAgain = await status();
        assert.equal(stoppedAgain?.state, 'stopped');
        assert.equal(stoppedAgain.runId, restarted.runId);
        await start();
        const next = await running(restarted.runId, 2);
        assert.notEqual(next.pid, restarted.pid);
        restarted = next;
      }
      await assertUnapprovedObservations();
      process.stdout.write('Windows recovery acceptance: two forced losses and three clean restarts each persisted multiple healthy cycles.\n');
    }
    if (userScope) {
      // Only the disposable runner's manager is restarted. This asserts that the
      // enabled default.target unit starts again without a manual service start.
      process.stdout.write(run('loginctl', ['show-user', String(process.getuid()), '--property=State,Sessions,Linger'], true));
      assert.equal(run('findmnt', ['--target', '/sys/fs/cgroup', '--noheadings', '--output', 'FSTYPE']).trim(), 'cgroup2');
      const managerControlGroup = run('sudo', ['systemctl', 'show', `user@${process.getuid()}.service`, '--property=ControlGroup', '--value']).trim();
      assert.equal(managerControlGroup, `/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service`);
      const managerCgroup = `/sys/fs/cgroup${managerControlGroup}`;
      assert((await lstat(managerCgroup)).isDirectory(), 'The running manager must own the expected cgroup');
      run('sudo', ['systemctl', 'stop', `user@${process.getuid()}.service`]);
      // systemd 249 failed EBUSY during an immediate manager restart in native
      // acceptance (also reported upstream in systemd#23163). Observe complete
      // teardown of the old delegated cgroup before creating its replacement,
      // without retrying a failed start or inserting an arbitrary grace period.
      await until(async () => {
        try { await lstat(managerCgroup); return false; }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      }, 'Stopped user manager did not release its delegated cgroup');
      assert((await lstat('/sys/fs/cgroup')).isDirectory());
      run('sudo', ['systemctl', 'start', `user@${process.getuid()}.service`]);
      const reactivated = await running(restarted.runId);
      assert.notEqual(reactivated.pid, restarted.pid);
      assert.equal(systemctl(['is-enabled', `${name}.service`]).trim(), 'enabled');
    }
    await stop();
    assert.equal((await status()).state, 'stopped');
    process.stdout.write(`Native ${target}${userScope ? ' user scope (including manager restart)' : ''}: real observation, crash recovery, graceful stop and explicit restart passed (${Math.round((Date.now() - started) / 1000)}s).\n`);
  }
} catch (error) {
  // Only this credential-free, fictional fixture is diagnosed. Keep failures
  // visible before removing the disposable native service and its state.
  process.stderr.write(`Original native acceptance failure: ${String(error.stack ?? error).slice(0, 4000)}\n`);
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
      if (userScope) {
        process.stderr.write(run('systemctl', ['--version']));
        process.stderr.write(run('sysctl', ['kernel.apparmor_restrict_unprivileged_userns'], true));
        process.stderr.write(run('sudo', ['journalctl', '--kernel', '--lines=20', '--no-pager', '--grep=apparmor.*DENIED'], true));
        process.stderr.write(run('loginctl', ['show-user', String(process.getuid()), '--property=State,Sessions,Linger'], true));
        process.stderr.write(run('sudo', ['journalctl', '--unit', `user@${process.getuid()}.service`, '--unit', 'systemd-logind.service', '--lines=40', '--no-pager'], true));
        // An exec child can fail before joining its unit's cgroup, so filtering
        // only by that unit omits the errno behind an EXIT_CGROUP failure.
        process.stderr.write(run('sudo', ['journalctl', '--since', `@${Math.floor(started / 1000)}`, '--priority=warning', '--lines=40', '--no-pager'], true));
        const cgroup = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service`;
        for (const filename of ['cgroup.type', 'cgroup.events', 'cgroup.procs', 'cgroup.subtree_control']) {
          try { process.stderr.write(`${filename}: ${await readFile(join(cgroup, filename), 'utf8')}`); }
          catch (readError) { process.stderr.write(`${filename}: ${readError.code}\n`); }
        }
      }
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
