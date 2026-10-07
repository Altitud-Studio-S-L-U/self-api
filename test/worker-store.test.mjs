import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { openWorkerStore } from '../dist/worker-store.js';

const execute = promisify(execFile);
const hash = input => createHash('sha256').update(input).digest('hex');
const work = resolve('work/test-worker-store');
await mkdir(work, { recursive: true });
const parent = await realpath(work);
const owned = await mkdtemp(join(parent, 'worker-store-'));
let sequence = 0;
const invalid = { name: 'PlumberError', code: 'INVALID_INPUT' };
const leaseLost = { name: 'PlumberError', code: 'LEASE_LOST' };

after(async () => {
  const target = await realpath(owned);
  assert.equal(dirname(target), parent);
  assert.ok(basename(target).startsWith('worker-store-'));
  await rm(target, { recursive: true, force: false });
});

function snapshot(version) {
  const bytes = Buffer.from(JSON.stringify({ openapi: '3.0.3', info: { title: 'Controlled fixture', version }, paths: {} }));
  return { bytes, metadata: { sha256: hash(bytes), byteLength: bytes.length, specificationVersion: '3.0.3', apiVersion: version } };
}
const A = snapshot('A');
const B = snapshot('B');
const C = snapshot('C');

function report(revision, consumerDigest = 'e'.repeat(64), engineVersion = '1.33.0') {
  return {
    schemaVersion: 1,
    comparison: { schemaVersion: 1, engine: { name: 'oasdiff', version: engineVersion }, base: A.metadata, revision: revision.metadata,
      contentChanged: revision.metadata.sha256 !== A.metadata.sha256, status: 'no-breaking-changes', changes: [],
      coverage: 'structural-contract-only', consumerImpact: 'not-analyzed' },
    inventory: { schemaVersion: 1, digest: consumerDigest, files: [], calls: [], imports: [], issues: [], skipped: [], packages: [], validationCandidates: [], coverage: 'bounded-native-fetch-syntax', codeExecuted: false },
    provider: { origin: 'https://orders.example.invalid', basePath: '' }, matches: [], unmappedChangeIndexes: [], unresolvedCallIds: [],
    conclusion: 'review-required', coverage: 'potential-operation-impact',
  };
}

async function fixture(t) {
  const directory = join(owned, `case-${sequence++}`);
  const consumerRoot = join(directory, 'consumer');
  await mkdir(consumerRoot, { recursive: true });
  const sourcePath = join(consumerRoot, 'source.json');
  await writeFile(sourcePath, A.bytes);
  const statePath = join(directory, 'state');
  const store = await openWorkerStore(statePath);
  t.after(() => store.close());
  const input = { id: hash(directory), label: 'Controlled fixture', sourcePath, consumerRoot, providerBaseUrl: 'https://orders.example.invalid', baseline: A };
  return { directory, statePath, store, input };
}

function observe(store, id, observed, evidence = report(observed)) {
  const lease = store.claim(id);
  assert.ok(lease);
  return store.completeObservation({ lease, snapshot: observed, report: evidence });
}

test('import does not open SQLite, emit its warning, or start a worker', async () => {
  const moduleUrl = new URL('../dist/worker-store.js', import.meta.url).href;
  const result = await execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)}); process.stdout.write('imported');`]);
  assert.equal(result.stdout, 'imported');
  assert.equal(result.stderr, '');
});

test('registration is durable, immutable, idempotent and explicitly not adoption', async t => {
  const { statePath, store, input } = await fixture(t);
  const first = store.register(input);
  assert.deepEqual(store.register(input), first);
  assert.equal(first.configuredBaselineSha, A.metadata.sha256);
  assert.equal(first.lastObservedSha, null);
  assert.equal(first.adopted, 'unknown');
  assert.equal(first.deployed, 'unknown');
  for (const change of [{ label: 'changed' }, { sourcePath: join(input.consumerRoot, 'other.json') }, { baseline: B }, { providerBaseUrl: 'https://other.example.invalid' }]) {
    assert.throws(() => store.register({ ...input, ...change }), invalid);
  }
  store.close();
  const reopened = await openWorkerStore(statePath);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.listSubscriptions(), [first]);
  assert.deepEqual(Buffer.from(reopened.getBaseline(input.id).bytes), A.bytes);
  const mutable = reopened.getBaseline(input.id);
  mutable.bytes[0] = 0;
  mutable.metadata.apiVersion = 'changed copy';
  assert.deepEqual(Buffer.from(reopened.getBaseline(input.id).bytes), A.bytes);
  assert.equal(reopened.getBaseline(input.id).metadata.apiVersion, 'A');
});

test('preserves A-B-A transitions and deduplicates additive jobs without moving the configured baseline', async t => {
  const { store, input } = await fixture(t);
  store.register(input);
  assert.deepEqual(observe(store, input.id, A), { job: null, created: false, transition: true });
  const changed = observe(store, input.id, B);
  assert.equal(changed.created, true);
  assert.equal(changed.transition, true);
  assert.equal(changed.job.status, 'review-required');
  assert.equal(changed.job.report.comparison.changes.length, 0);
  const unchanged = observe(store, input.id, B);
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.transition, false);
  assert.equal(unchanged.job.id, changed.job.id);
  assert.deepEqual(observe(store, input.id, A), { job: null, created: false, transition: true });
  assert.equal(observe(store, input.id, B).job.id, changed.job.id);
  const current = store.listSubscriptions()[0];
  assert.equal(current.configuredBaselineSha, A.metadata.sha256);
  assert.equal(current.lastObservedSha, B.metadata.sha256);
  assert.equal(current.adopted, 'unknown');
  assert.equal(store.listJobs().length, 1);
  assert.equal(observe(store, input.id, C).job.baselineSha, A.metadata.sha256);
  assert.equal(store.listJobs().length, 2);
});

test('job identity includes captured consumer evidence and engine version', async t => {
  const { store, input } = await fixture(t);
  store.register(input);
  const first = observe(store, input.id, B);
  const second = observe(store, input.id, B, report(B, 'f'.repeat(64)));
  const third = observe(store, input.id, B, report(B, 'f'.repeat(64), '1.34.0'));
  assert.notEqual(first.job.id, second.job.id);
  assert.notEqual(second.job.id, third.job.id);
  assert.equal(second.transition, false);
  assert.equal(third.transition, false);
  assert.equal(store.listJobs().length, 3);
});

test('an invalid snapshot or report rolls back all changes and retains the lease', async t => {
  const { store, input } = await fixture(t);
  store.register(input);
  const lease = store.claim(input.id);
  for (const value of [{ ...B, bytes: A.bytes }, { ...B, metadata: { ...B.metadata, byteLength: 1 } }]) {
    assert.throws(() => store.completeObservation({ lease, snapshot: value, report: report(B) }), invalid);
  }
  const wrongBase = report(B);
  wrongBase.comparison.base = C.metadata;
  assert.throws(() => store.completeObservation({ lease, snapshot: B, report: wrongBase }), invalid);
  const wrongProvider = report(B);
  wrongProvider.provider.origin = 'https://unrelated.example.invalid';
  assert.throws(() => store.completeObservation({ lease, snapshot: B, report: wrongProvider }), invalid);
  assert.equal(store.listSubscriptions()[0].lastObservedSha, null);
  assert.deepEqual(store.listJobs(), []);
  assert.equal(store.claim(input.id), null);
  assert.equal(store.completeObservation({ lease, snapshot: B, report: report(B) }).created, true);
});

test('failures preserve previous observations and pending jobs and reject untyped reasons', async t => {
  const { store, input } = await fixture(t);
  store.register(input);
  observe(store, input.id, B);
  const before = store.listSubscriptions()[0];
  const jobs = store.listJobs();
  const lease = store.claim(input.id);
  assert.throws(() => store.failObservation({ lease, reason: 'private-error-detail' }), invalid);
  store.failObservation({ lease, reason: 'consumer-unavailable' });
  const after = store.listSubscriptions()[0];
  assert.equal(after.lastObservedSha, before.lastObservedSha);
  assert.equal(after.lastSucceededAt, before.lastSucceededAt);
  assert.equal(after.lastError, 'consumer-unavailable');
  assert.deepEqual(store.listJobs(), jobs);
  assert.throws(() => store.failObservation({ lease, reason: 'analysis-failed' }), leaseLost);
});

test('leases fence stale owners, survive reopen and recover only after expiry', async t => {
  const { store, input, statePath } = await fixture(t);
  store.register(input);
  const lease = store.claim(input.id);
  assert.match(lease.owner, /^[a-f0-9-]{36}$/);
  assert.ok(Date.parse(lease.expiresAt) > Date.now());
  store.close();
  const reopened = await openWorkerStore(statePath);
  t.after(() => reopened.close());
  assert.equal(reopened.claim(input.id), null);
  // A controlled persisted lease fixture represents a worker that stopped more than five minutes ago.
  const { DatabaseSync } = await import('node:sqlite');
  const state = new DatabaseSync(join(statePath, 'worker.sqlite3'));
  state.prepare('UPDATE subscriptions SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, input.id);
  state.close();
  const replacement = reopened.claim(input.id);
  assert.equal(replacement.generation, lease.generation + 1);
  assert.notEqual(replacement.owner, lease.owner);
  assert.throws(() => reopened.completeObservation({ lease, snapshot: B, report: report(B) }), leaseLost);
  assert.throws(() => reopened.failObservation({ lease, reason: 'analysis-failed' }), leaseLost);
  assert.equal(reopened.claim(input.id), null);
  assert.equal(reopened.completeObservation({ lease: replacement, snapshot: B, report: report(B) }).created, true);
});

test('two independent processes can claim a subscription only once', async t => {
  const { store, input, statePath } = await fixture(t);
  store.register(input);
  const moduleUrl = new URL('../dist/worker-store.js', import.meta.url).href;
  const script = `import { openWorkerStore } from ${JSON.stringify(moduleUrl)}; const store = await openWorkerStore(process.argv[1]); try { process.stdout.write(JSON.stringify(store.claim(process.argv[2]))); } finally { store.close(); }`;
  const children = await Promise.all(Array.from({ length: 2 }, () => execute(process.execPath, ['--input-type=module', '-e', script, statePath, input.id], { timeout: 15_000 })));
  const claims = children.map(result => JSON.parse(result.stdout));
  assert.equal(claims.filter(Boolean).length, 1);
  const competitors = Array.from({ length: 12 }, () => store.claim(input.id));
  assert.ok(competitors.every(value => value === null));
  store.failObservation({ lease: claims.find(Boolean), reason: 'analysis-failed' });
});

test('subscription and per-report quotas fail explicitly without deleting pending work', async t => {
  const { store, input } = await fixture(t);
  for (let index = 0; index < 100; index += 1) store.register({ ...input, id: hash(`quota-${index}`) });
  assert.throws(() => store.register({ ...input, id: hash('quota-overflow') }), { code: 'STATE_LIMIT' });
  const id = hash('quota-0');
  observe(store, id, B);
  const lease = store.claim(id);
  const oversized = report(C);
  oversized.comparison.changes = [{ id: 'controlled-fixture', level: 'warning', text: 'x'.repeat(4 * 1024 * 1024) }];
  assert.throws(() => store.completeObservation({ lease, snapshot: C, report: oversized }), { code: 'STATE_LIMIT' });
  assert.equal(store.listJobs().length, 1);
  assert.equal(store.listSubscriptions().find(value => value.id === id).lastObservedSha, B.metadata.sha256);
  store.failObservation({ lease, reason: 'state-limit' });
});

test('rejects future or foreign databases without changing their contents or permissions', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  for (const sql of ['PRAGMA application_id=1347179853; PRAGMA user_version=99;', 'CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'retained\');']) {
    const statePath = join(owned, `foreign-${sequence++}`);
    await mkdir(statePath, { mode: 0o700 });
    const path = join(statePath, 'worker.sqlite3');
    await writeFile(path, '', { flag: 'wx', mode: 0o600 });
    const database = new DatabaseSync(path);
    database.exec(sql);
    database.close();
    const bytes = await readFile(path);
    const stateMode = (await stat(statePath)).mode;
    const fileMode = (await stat(path)).mode;
    await assert.rejects(openWorkerStore(statePath), invalid);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await stat(statePath)).mode, stateMode);
    assert.equal((await stat(path)).mode, fileMode);
  }
});

if (process.platform !== 'win32') {
  test('rejects public POSIX state and database permissions without changing them', async () => {
    for (const publicDirectory of [true, false]) {
      const statePath = join(owned, `public-${sequence++}`);
      await mkdir(statePath, { mode: publicDirectory ? 0o755 : 0o700 });
      const path = join(statePath, 'worker.sqlite3');
      await writeFile(path, 'controlled fixture retained', { flag: 'wx', mode: 0o644 });
      await chmod(statePath, publicDirectory ? 0o755 : 0o700);
      await chmod(path, 0o644);
      const stateMode = (await stat(statePath)).mode;
      const fileMode = (await stat(path)).mode;
      await assert.rejects(openWorkerStore(statePath), /owner-only POSIX permissions/);
      assert.equal((await stat(statePath)).mode, stateMode);
      assert.equal((await stat(path)).mode, fileMode);
      assert.equal(await readFile(path, 'utf8'), 'controlled fixture retained');
    }
  });
}

test('rejects linked state ancestors and database journals before opening SQLite', async () => {
  const target = join(owned, `link-target-${sequence++}`);
  const linked = join(owned, `linked-${sequence++}`);
  await mkdir(target);
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openWorkerStore(linked), invalid);
  await assert.rejects(openWorkerStore(join(linked, 'nested')), invalid);
  for (const name of ['worker.sqlite3', 'worker.sqlite3-journal']) {
    const statePath = join(owned, `linked-db-${sequence++}`);
    await mkdir(statePath, { mode: 0o700 });
    await symlink(target, join(statePath, name), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(openWorkerStore(statePath), invalid);
  }
});

test('requires local dedicated state and keeps it outside the configured consumer in both directions', async t => {
  for (const path of ['', '-', 'https://example.invalid/state', '//server/share', 'state:stream', join(owned, 'arbitrary.sqlite3')]) {
    await assert.rejects(openWorkerStore(path), invalid);
  }
  const { store, input } = await fixture(t);
  for (const consumerRoot of [store.statePath, dirname(store.statePath), join(store.statePath, 'nested-consumer')]) {
    await mkdir(consumerRoot, { recursive: true });
    assert.throws(() => store.register({ ...input, consumerRoot }), invalid);
  }
  assert.deepEqual(store.listSubscriptions(), []);
});

test('new database files use private normal permissions and closed stores refuse operations', async t => {
  const { store, statePath } = await fixture(t);
  if (process.platform !== 'win32') {
    assert.equal((await stat(statePath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(statePath, 'worker.sqlite3'))).mode & 0o777, 0o600);
  }
  store.close();
  assert.throws(() => store.listJobs(), invalid);
  store.close();
});
