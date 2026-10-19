import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeWorkerSetup, createCloudTransport, diagnoseWorker, initWorkerSetup, normalizeWorkerServiceConfig, readWorkerPublicIdentity,
  runWorkerSetupCli, supportedNode, workerSetupFiles } from '../dist/index.js';

const posix = process.platform !== 'win32';
const projectId = 'b'.repeat(64), clientSecret = 'c'.repeat(64);
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'keepseam-setup-'));
  if (posix) await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const enrollmentFor = (identity, overrides = {}) => ({ baseUrl: 'https://keepseam.com', installationId: identity.installationId, projectId, clientSecret, ...overrides });
const mode = async path => (await stat(path)).mode & 0o777;
const stdin = (text, isTTY = false) => Object.assign((async function* () { yield Buffer.from(text); })(), { isTTY });

test('init creates a private directory and returns only the public half of a freshly generated key', async t => {
  const directory = join(await workspace(t), 'worker');
  const identity = await initWorkerSetup({ directory });
  assert.match(identity.installationId, /^[a-f0-9]{64}$/u); assert.match(identity.fingerprint, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(Object.keys(identity.publicJwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.ok(!JSON.stringify(identity).includes('"d"'));
  if (posix) { assert.equal(await mode(directory), 0o700); assert.equal(await mode(join(directory, workerSetupFiles.pending)), 0o600); }
  const pending = JSON.parse(await readFile(join(directory, workerSetupFiles.pending), 'utf8'));
  assert.equal(pending.cloudOrigin, 'https://keepseam.com'); assert.equal(pending.statePath, join(directory, 'state'));
  assert.deepEqual(await readWorkerPublicIdentity({ directory }), identity);
  // A second key is never generated over an existing setup.
  await assert.rejects(initWorkerSetup({ directory }), /new or empty private directory/u);
  assert.equal(existsSync(join(directory, workerSetupFiles.lock)), false);
});

test('init rejects unsafe locations and non-HTTPS Cloud origins before generating anything', async t => {
  const root = await workspace(t);
  for (const cloudOrigin of ['http://keepseam.com', 'https://user:pass@keepseam.com', 'https://keepseam.com/path', 'keepseam.com']) {
    await assert.rejects(initWorkerSetup({ directory: join(root, `bad-${Math.random()}`), cloudOrigin }), /HTTPS origin/u);
  }
  await assert.rejects(initWorkerSetup({ directory: 'relative/worker' }));
  const directory = join(root, 'same');
  await assert.rejects(initWorkerSetup({ directory, statePath: directory }), /own directory/u);
  const occupied = join(root, 'occupied'); await mkdir(occupied, { mode: 0o700 }); await writeFile(join(occupied, 'notes.txt'), 'x');
  await assert.rejects(initWorkerSetup({ directory: occupied }), /new or empty/u);
  if (posix) {
    const open = join(root, 'open'); await mkdir(open); await chmod(open, 0o755);
    await assert.rejects(initWorkerSetup({ directory: open }));
    const real = join(root, 'real'); await mkdir(real, { mode: 0o700 }); await symlink(real, join(root, 'alias'));
    await assert.rejects(initWorkerSetup({ directory: join(root, 'alias', 'worker') }), /links/u);
    // Rejected before the first write: nothing was created behind the link.
    assert.equal(existsSync(join(real, 'worker')), false);
    await assert.rejects(initWorkerSetup({ directory: join(root, 'fresh'), statePath: join(root, 'alias', 'state') }), /links/u);
    assert.equal(existsSync(join(real, 'state')), false); assert.equal(existsSync(join(root, 'fresh')), false);
  }
  await assert.rejects(initWorkerSetup({ directory: join(root, 'missing-parent', 'worker') }), /parent of a setup directory/u);
});

test('complete binds the enrollment to the local key and writes observation-only configuration', async t => {
  const directory = join(await workspace(t), 'worker');
  const identity = await initWorkerSetup({ directory });
  const result = await completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) });
  assert.equal(result.fingerprint, identity.fingerprint);
  assert.equal(existsSync(join(directory, workerSetupFiles.pending)), false);
  const credentials = JSON.parse(await readFile(result.credentialsPath, 'utf8'));
  assert.deepEqual(Object.keys(credentials), ['baseUrl', 'installationId', 'projectId', 'clientSecret', 'privateJwk']);
  assert.doesNotThrow(() => createCloudTransport(credentials));
  const config = normalizeWorkerServiceConfig(JSON.parse(await readFile(result.configPath, 'utf8')));
  assert.equal(config.allowHttp, false); assert.equal(config.sources.intervalMs, 900000);
  assert.equal(config.cloud, undefined); assert.equal(config.openApi, undefined); assert.equal(config.models, undefined);
  assert.ok(!(await readFile(result.configPath, 'utf8')).includes(clientSecret));
  if (posix) for (const path of [result.credentialsPath, result.configPath]) assert.equal(await mode(path), 0o600);
  if (posix) assert.equal(await mode(result.statePath), 0o700);
  assert.deepEqual(await readWorkerPublicIdentity({ directory }), identity);
  await assert.rejects(completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) }), /already complete/u);
});

test('complete rejects a foreign, downgraded or malformed enrollment without writing anything', async t => {
  const directory = join(await workspace(t), 'worker');
  const identity = await initWorkerSetup({ directory });
  for (const overrides of [{ installationId: 'd'.repeat(64) }, { baseUrl: 'https://keepseam.example' }, { baseUrl: 'http://keepseam.com' },
    { clientSecret: 'not-hex' }, { projectId: 'B'.repeat(64) }, { privateJwk: {} }, { allowLocalHttp: true }]) {
    await assert.rejects(completeWorkerSetup({ directory, enrollment: enrollmentFor(identity, overrides) }), error => !String(error.message).includes(clientSecret));
    assert.equal(existsSync(join(directory, workerSetupFiles.credentials)), false);
    assert.equal(existsSync(join(directory, workerSetupFiles.pending)), true);
  }
});

test('an interrupted completion resumes only with the identical enrollment and keeps the key until both files verify', async t => {
  const directory = join(await workspace(t), 'worker');
  const identity = await initWorkerSetup({ directory });
  const obstacle = join(directory, workerSetupFiles.config);
  await mkdir(obstacle);
  await assert.rejects(completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) }));
  assert.equal(existsSync(join(directory, workerSetupFiles.credentials)), true);
  assert.equal(existsSync(join(directory, workerSetupFiles.pending)), true);
  const interrupted = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} });
  assert.equal(interrupted.checks.find(check => check.id === 'enrollment').code, 'SETUP_INTERRUPTED');
  await rm(obstacle, { recursive: true });
  await assert.rejects(completeWorkerSetup({ directory, enrollment: enrollmentFor(identity, { clientSecret: 'e'.repeat(64) }) }), /differs from this enrollment/u);
  assert.equal(existsSync(join(directory, workerSetupFiles.pending)), true);
  await completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) });
  assert.equal(existsSync(join(directory, workerSetupFiles.pending)), false);
});

test('commands on one directory are serialized and a stale lock is reported rather than broken', async t => {
  const directory = join(await workspace(t), 'worker');
  const identity = await initWorkerSetup({ directory });
  const results = await Promise.allSettled([1, 2, 3].map(() => completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(existsSync(join(directory, workerSetupFiles.pending)), false);
  await writeFile(join(directory, workerSetupFiles.lock), '{}', { mode: 0o600 });
  const report = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} });
  assert.equal(report.checks.find(check => check.id === 'lock').code, 'SETUP_LOCKED'); assert.equal(report.ok, false);
  await assert.rejects(readWorkerPublicIdentity({ directory }).then(() => completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) })), /setup\.lock/u);
});

test('a hard-linked key or credentials file is refused', async t => {
  const root = await workspace(t), directory = join(root, 'worker');
  const identity = await initWorkerSetup({ directory });
  await link(join(directory, workerSetupFiles.pending), join(root, 'copy.json'));
  await assert.rejects(completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) }), /singly linked/u);
});

test('doctor reports stable codes and never echoes secret values', async t => {
  const directory = join(await workspace(t), 'worker');
  const identity = await initWorkerSetup({ directory });
  assert.equal((await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} })).checks.find(check => check.id === 'enrollment').code, 'SETUP_INCOMPLETE');
  await completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) });
  const token = 'ghp_synthetic_value_that_must_not_leak';
  const healthy = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: { GH_TOKEN: token } });
  assert.equal(healthy.ok, true);
  const codes = Object.fromEntries(healthy.checks.map(check => [check.id, [check.status, check.code]]));
  assert.deepEqual(codes['cloud-sharing'], ['warn', 'OBSERVATION_ONLY']); assert.deepEqual(codes['github-token'], ['ok', 'GH_TOKEN_PRESENT']);
  const credentials = JSON.parse(await readFile(join(directory, workerSetupFiles.credentials), 'utf8'));
  for (const secret of [clientSecret, credentials.privateJwk.d, token]) assert.ok(!JSON.stringify(healthy).includes(secret));
  const elsewhere = await diagnoseWorker({ directory, platform: 'darwin', nodeVersion: '22.1.0', environment: {} });
  assert.deepEqual(elsewhere.checks.slice(0, 2).map(check => check.code), ['PLATFORM_UNSUPPORTED', 'NODE_UNSUPPORTED']);
  assert.equal(elsewhere.checks.find(check => check.id === 'github-token').code, 'GH_TOKEN_ABSENT');
  if (posix) {
    await chmod(join(directory, workerSetupFiles.credentials), 0o644);
    assert.equal((await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} })).checks.find(check => check.id === 'credentials').code, 'CREDENTIALS_INVALID');
    await chmod(join(directory, workerSetupFiles.credentials), 0o600);
  }
  await writeFile(join(directory, workerSetupFiles.credentials), '{"baseUrl":"https://keepseam.com"}');
  assert.equal((await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} })).checks.find(check => check.id === 'credentials').code, 'CREDENTIALS_INVALID');
});

test('the optional network check reaches only the liveness endpoint of the chosen origin', async t => {
  const directory = join(await workspace(t), 'worker');
  const identity = await initWorkerSetup({ directory });
  await completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) });
  const calls = [];
  const reachable = async (url, init) => { calls.push([url, init.method, init.redirect]); return new Response('ok', { status: 200 }); };
  const report = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {}, online: true, fetch: reachable });
  assert.deepEqual(calls, [['https://keepseam.com/api/health/live', 'GET', 'error']]);
  assert.equal(report.checks.find(check => check.id === 'cloud-network').status, 'ok');
  const down = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {}, online: true, fetch: async () => new Response('', { status: 503 }) });
  assert.equal(down.checks.find(check => check.id === 'cloud-network').code, 'CLOUD_UNREACHABLE');
  assert.equal((await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} })).checks.some(check => check.id === 'cloud-network'), false);
});

test('the command line reads the enrollment only from a pipe and keeps secrets out of its output', async t => {
  const directory = join(await workspace(t), 'worker');
  const out = [], err = [];
  const io = { stdout: text => out.push(text), stderr: text => err.push(text), platform: 'linux' };
  assert.equal(await runWorkerSetupCli(['setup', 'init', '--dir', directory], io), 0);
  const identity = JSON.parse(out.pop());
  assert.ok(!JSON.stringify(identity).includes('"d"'));
  const enrollment = JSON.stringify(enrollmentFor(identity));
  assert.equal(await runWorkerSetupCli(['setup', 'complete', '--dir', directory], { ...io, stdin: stdin(enrollment, true) }), 2);
  assert.match(err.pop(), /Pipe the enrollment JSON/u);
  assert.equal(await runWorkerSetupCli(['setup', 'complete', '--dir', directory], { ...io, stdin: stdin(' '.repeat(16 * 1024 + 1)) }), 2);
  assert.match(err.pop(), /16 KiB/u);
  assert.equal(await runWorkerSetupCli(['setup', 'complete', '--dir', directory, '--interval-ms', '5'], { ...io, stdin: stdin(enrollment) }), 2);
  assert.equal(await runWorkerSetupCli(['setup', 'complete', '--dir', directory], { ...io, stdin: stdin(enrollment) }), 0);
  // The exit code depends on this host's Node line; the report shape and secrecy do not.
  assert.ok([0, 1].includes(await runWorkerSetupCli(['doctor', '--dir', directory, '--json'], io)));
  assert.ok(JSON.parse(out.at(-1)).checks.some(check => check.id === 'credentials' && check.status === 'ok'));
  for (const text of [...out, ...err]) assert.ok(!text.includes(clientSecret));
  assert.equal(await runWorkerSetupCli(['setup', 'init', '--dir', directory], { ...io, platform: 'win32' }), 2);
  assert.match(err.pop(), /Linux hosts only/u);
});

test('the supported Node line matches the package engines', async () => {
  const engines = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).engines.node;
  assert.equal(engines, `>=${supportedNode.major}.${supportedNode.minor}.0 <${supportedNode.major + 1}`);
});

test('a key whose private scalar does not match its public coordinates is refused everywhere', async t => {
  const root = await workspace(t), other = await initWorkerSetup({ directory: join(root, 'other') });
  const otherKey = JSON.parse(await readFile(join(root, 'other', workerSetupFiles.pending), 'utf8')).privateJwk;
  for (const [name, d] of [['mixed', otherKey.d], ['zero', Buffer.alloc(32).toString('base64url')],
    ['order', Buffer.from('FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551', 'hex').toString('base64url')]]) {
    const directory = join(root, name), identity = await initWorkerSetup({ directory });
    const pendingPath = join(directory, workerSetupFiles.pending), pending = JSON.parse(await readFile(pendingPath, 'utf8'));
    await rm(pendingPath); await writeFile(pendingPath, JSON.stringify({ ...pending, privateJwk: { ...pending.privateJwk, d } }), { mode: 0o600 });
    await assert.rejects(readWorkerPublicIdentity({ directory }), /P-256 key|does not match/u);
    await assert.rejects(completeWorkerSetup({ directory, enrollment: enrollmentFor(identity) }), /P-256 key|does not match/u);
    assert.equal(existsSync(join(directory, workerSetupFiles.credentials)), false);
    // Enrolled credentials carrying such a key fail the doctor without the key entering the report.
    const credentialsPath = join(directory, workerSetupFiles.credentials);
    await writeFile(credentialsPath, JSON.stringify({ ...enrollmentFor(identity), privateJwk: { ...pending.privateJwk, d } }), { mode: 0o600 });
    await rm(pendingPath);
    const report = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} });
    assert.equal(report.checks.find(check => check.id === 'credentials').code, 'CREDENTIALS_INVALID');
    for (const secret of [d, pending.privateJwk.x, clientSecret]) assert.ok(!JSON.stringify(report).includes(secret));
  }
  assert.ok(other.fingerprint);
});

test('the setup lock is released only when it is still the file and token this command created', async t => {
  const { withSetupLock } = await import('../dist/worker-setup.js');
  const directory = join(await workspace(t), 'worker'); await mkdir(directory, { mode: 0o700 });
  const lock = join(directory, workerSetupFiles.lock);
  assert.equal(await withSetupLock(directory, async () => 'done'), 'done');
  assert.equal(existsSync(lock), false);
  // A replaced lock is kept and reported, whether the command succeeded or failed; the original failure stays visible.
  await assert.rejects(withSetupLock(directory, async () => { await rm(lock); await writeFile(lock, '{"token":"someone-else"}', { mode: 0o600 }); return 'done'; }),
    /could not be released safely/u);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'someone-else');
  await rm(lock);
  await assert.rejects(withSetupLock(directory, async () => {
    await rm(lock); await writeFile(lock, '{"token":"someone-else"}', { mode: 0o600 });
    await completeWorkerSetup({ directory: join(directory, 'absent'), enrollment: {} });
  }), error => /could not be released safely/u.test(error.message) && error.message.length > 'setup.lock could not be released safely.'.length);
  assert.equal(existsSync(lock), true);
});
