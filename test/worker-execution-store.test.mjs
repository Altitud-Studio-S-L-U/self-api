import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { openWorkerStore } from '../dist/worker-store.js';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const work = resolve('work/test-worker-execution-store');
await mkdir(work, { recursive: true });
const parent = await realpath(work);
const owned = await mkdtemp(join(parent, 'execution-store-'));
let sequence = 0;
const invalid = { name: 'PlumberError', code: 'INVALID_INPUT' };
const leaseLost = { name: 'PlumberError', code: 'LEASE_LOST' };

after(async () => {
  const target = await realpath(owned);
  assert.equal(dirname(target), parent);
  assert.ok(basename(target).startsWith('execution-store-'));
  await rm(target, { recursive: true, force: false });
});

function snapshot(version) {
  const bytes = Buffer.from(JSON.stringify({ openapi: '3.0.3', info: { title: 'Controlled fixture', version }, paths: {} }));
  return { bytes, metadata: { sha256: hash(bytes), byteLength: bytes.length, specificationVersion: '3.0.3', apiVersion: version } };
}
const baseline = snapshot('baseline');
const revision = snapshot('revision');
function report() {
  return {
    schemaVersion: 1, comparison: { schemaVersion: 1, engine: { name: 'oasdiff', version: '1.33.0' },
      base: baseline.metadata, revision: revision.metadata, contentChanged: true, status: 'no-breaking-changes', changes: [],
      coverage: 'structural-contract-only', consumerImpact: 'not-analyzed' },
    inventory: { schemaVersion: 1, digest: hash('controlled consumer'), files: [], calls: [], imports: [], issues: [], skipped: [], packages: [],
      validationCandidates: [], coverage: 'bounded-native-fetch-syntax', codeExecuted: false },
    provider: { origin: 'https://orders.example.invalid', basePath: '' }, matches: [], unmappedChangeIndexes: [], unresolvedCallIds: [],
    conclusion: 'review-required', coverage: 'potential-operation-impact',
  };
}
async function fixture(t) {
  const directory = join(owned, `case-${sequence++}`);
  const consumerRoot = join(directory, 'consumer');
  await mkdir(consumerRoot, { recursive: true });
  const sourcePath = join(consumerRoot, 'source.json');
  await writeFile(sourcePath, revision.bytes);
  const statePath = join(directory, 'state');
  const store = await openWorkerStore(statePath);
  t.after(() => store.close());
  const subscription = store.register({ id: hash(directory), label: 'Controlled fixture', sourcePath, consumerRoot,
    providerBaseUrl: 'https://orders.example.invalid', baseline });
  const { job } = store.completeObservation({ lease: store.claim(subscription.id), snapshot: revision, report: report() });
  return { store, statePath, subscription, job };
}
function input(job, overrides = {}) {
  return { jobId: job.id, receiptId: randomUUID(), requestId: hash('request'), planId: hash('plan'),
    executionDigest: hash('execution'), policyDigest: hash('policy'),
    recipeJson: JSON.stringify({ schemaVersion: 1, summary: 'Controlled recipe', decisions: [], files: [] }),
    testPaths: ['orders.test.mjs'], ...overrides };
}
function outcome(intent, overrides = {}) {
  return { schemaVersion: 1, intentId: intent.id, requestId: intent.requestId, receiptId: intent.receiptId, status: 'passed',
    baseline: { status: 'passed', exitCode: 0, cleanup: 'removed' },
    candidate: { status: 'passed', exitCode: 0, cleanup: 'removed' },
    consumerModified: false, publication: 'not-authorized', ...overrides };
}
function editState(statePath, action) {
  const database = new DatabaseSync(join(statePath, 'worker.sqlite3'));
  try { return action(database); } finally { database.close(); }
}
function expire(statePath, id) {
  editState(statePath, db => db.prepare('UPDATE execution_intents SET expires_at=? WHERE id=?').run(Date.now() - 1, id));
}

test('job evidence returns retained exact contract bytes independent of current observations and caller mutation', async t => {
  const { store, job, subscription } = await fixture(t);
  const retained = store.getJobEvidence(job.id);
  assert.deepEqual(retained.job, job);
  assert.equal(retained.subscription.id, subscription.id);
  assert.deepEqual(Buffer.from(retained.baseline.bytes), baseline.bytes);
  assert.deepEqual(Buffer.from(retained.revision.bytes), revision.bytes);
  retained.revision.bytes.fill(0);
  retained.baseline.metadata.apiVersion = 'changed local copy';
  retained.job.report.inventory.digest = hash('unrelated');
  const reverted = report();
  reverted.comparison.revision = baseline.metadata;
  reverted.comparison.contentChanged = false;
  store.completeObservation({ lease: store.claim(subscription.id), snapshot: baseline, report: reverted });
  const again = store.getJobEvidence(job.id);
  assert.deepEqual(Buffer.from(again.revision.bytes), revision.bytes);
  assert.equal(again.baseline.metadata.apiVersion, 'baseline');
  assert.equal(again.job.consumerDigest, report().inventory.digest);
  assert.equal(again.subscription.lastObservedSha, baseline.metadata.sha256);
  assert.throws(() => store.getJobEvidence(hash('missing')), invalid);
});

test('queue survives reopening, normalizes object order, and never creates an approval or an attempt', async t => {
  const { store, job, statePath } = await fixture(t);
  const queued = input(job);
  const first = store.enqueueExecution(queued);
  assert.equal(first.created, true);
  assert.equal(first.intent.id, hash(queued.receiptId));
  assert.equal(first.intent.status, 'queued');
  assert.equal(first.intent.owner, null);
  assert.equal(first.intent.generation, 0);
  assert.equal(first.intent.outcome, null);
  const reordered = '{ "files": [], "decisions": [], "summary": "Controlled recipe", "schemaVersion": 1 }';
  assert.deepEqual(store.enqueueExecution({ ...queued, recipeJson: reordered }), { intent: first.intent, created: false });
  await assert.rejects(readFile(join(statePath, 'receipts', `${queued.receiptId}.json`)), { code: 'ENOENT' });
  store.close();
  const reopened = await openWorkerStore(statePath);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.listExecutionIntents(), [first.intent]);
  const copy = reopened.listExecutionIntents()[0];
  copy.testPaths[0] = 'changed.test.mjs';
  assert.deepEqual(reopened.listExecutionIntents()[0].testPaths, queued.testPaths);
});

test('one receipt cannot be rebound to another job, request, plan, recipe, policy, execution, or test selection', async t => {
  const { store, job, subscription } = await fixture(t);
  const queued = input(job);
  store.enqueueExecution(queued);
  const changedConsumer = report();
  changedConsumer.inventory.digest = hash('another captured consumer');
  const other = store.completeObservation({ lease: store.claim(subscription.id), snapshot: revision, report: changedConsumer });
  for (const change of [
    { jobId: hash('missing') }, { jobId: other.job.id }, { requestId: hash('other request') }, { planId: hash('other plan') },
    { recipeJson: '{"different":true}' }, { executionDigest: hash('other execution') },
    { policyDigest: hash('other policy') }, { testPaths: ['different.test.mjs'] },
  ]) assert.throws(() => store.enqueueExecution({ ...queued, ...change }), invalid);
  assert.equal(store.listExecutionIntents().length, 1);
});

test('queue rejects malformed and excessive inputs without partial writes or executing array accessors', async t => {
  const { store, job } = await fixture(t);
  const queued = input(job);
  for (const change of [
    { receiptId: '../receipt' }, { requestId: 'short' }, { recipeJson: 'null' }, { recipeJson: '[]' },
    { recipeJson: '{invalid' }, { recipeJson: '{"number":1e999}' }, { recipeJson: `{"nested":${'['.repeat(70)}0${']'.repeat(70)}}` },
    { testPaths: [] }, { testPaths: Array(2) }, { testPaths: ['../escape.test.mjs'] },
    { testPaths: ['C:/escape.test.mjs'] }, { testPaths: ['/absolute.test.mjs'] },
    { testPaths: ['same.test.mjs', 'same.test.mjs'] }, { testPaths: Array.from({ length: 21 }, (_, n) => `${n}.test.mjs`) },
  ]) assert.throws(() => store.enqueueExecution({ ...queued, ...change }), invalid);
  let calls = 0;
  const paths = [];
  Object.defineProperty(paths, 0, { enumerable: true, get() { calls++; return 'test.mjs'; } });
  assert.throws(() => store.enqueueExecution({ ...queued, testPaths: paths }), invalid);
  assert.equal(calls, 0);
  assert.throws(() => store.enqueueExecution({ ...queued, recipeJson: JSON.stringify({ text: 'x'.repeat(1024 * 1024) }) }), { code: 'STATE_LIMIT' });
  assert.deepEqual(store.listExecutionIntents(), []);
});

test('two independent processes claim an execution once and only queued work is eligible', async t => {
  const { store, job, statePath } = await fixture(t);
  const { intent } = store.enqueueExecution(input(job));
  const moduleUrl = new URL('../dist/worker-store.js', import.meta.url).href;
  const script = `import { openWorkerStore } from ${JSON.stringify(moduleUrl)}; const s=await openWorkerStore(process.argv[1]); try { process.stdout.write(JSON.stringify(s.claimExecution(process.argv[2]))); } finally { s.close(); }`;
  const children = await Promise.all(Array.from({ length: 2 }, () => execute(process.execPath,
    ['--input-type=module', '-e', script, statePath, intent.id], { timeout: 15_000 })));
  const claims = children.map(child => JSON.parse(child.stdout));
  assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean);
  assert.equal(claim.intent.status, 'running');
  assert.ok(Date.parse(claim.intent.expiresAt) > Date.now() + 9 * 60_000);
  assert.equal(store.claimExecution(intent.id), null);
  assert.equal(store.claimExecution(), null);
  store.assertExecutionOwnership(claim);
  assert.throws(() => store.assertRecoveryOwnership(claim), leaseLost);
  store.blockExecution({ claim, reason: 'approval-invalid' });
  assert.equal(store.claimExecution(intent.id), null);
  assert.equal(store.claimRecovery(intent.id), null);
});

test('a completion requires matching outcomes and genuine completed phases with confirmed cleanup', async t => {
  const { store, job } = await fixture(t);
  const { intent } = store.enqueueExecution(input(job));
  const claim = store.claimExecution(intent.id);
  for (const change of [
    { intentId: hash('other') }, { intentId: null }, { requestId: hash('other') }, { receiptId: randomUUID() },
    { candidate: { status: 'passed', exitCode: 0, cleanup: 'failed' } },
    { candidate: { status: 'passed', exitCode: 1, cleanup: 'removed' } }, { candidate: undefined },
    { stdout: 'private logs must not enter the database' },
  ]) assert.throws(() => store.completeExecution({ claim, outcome: outcome(intent, change) }), invalid);
  assert.equal(store.listExecutionIntents()[0].status, 'running');
  assert.throws(() => store.completeExecution({ claim, outcome: outcome(intent, {
    status: 'blocked', candidate: { status: 'cleanup-failed', exitCode: 0, cleanup: 'failed' },
  }) }), invalid);
  const result = outcome(intent);
  store.completeExecution({ claim, outcome: result });
  const completed = store.listExecutionIntents()[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.owner, null);
  assert.equal(completed.expiresAt, null);
  assert.deepEqual(completed.outcome, result);
  assert.throws(() => store.completeExecution({ claim, outcome: result }), leaseLost);
  assert.equal(store.claimExecution(intent.id), null);
  assert.equal(store.getJobEvidence(job.id).subscription.adopted, 'unknown');
});

test('expired execution is fenced and recoverable but is never admitted to execution again', async t => {
  const { store, job, statePath } = await fixture(t);
  const { intent } = store.enqueueExecution(input(job));
  const previous = store.claimExecution(intent.id);
  assert.equal(store.claimRecovery(intent.id), null);
  expire(statePath, intent.id);
  assert.equal(store.claimExecution(), null);
  assert.equal(store.claimExecution(intent.id), null);
  assert.equal(store.listExpiredExecutions()[0].id, intent.id);
  assert.throws(() => store.assertExecutionOwnership(previous), leaseLost);
  assert.throws(() => store.completeExecution({ claim: previous, outcome: outcome(intent) }), leaseLost);
  assert.throws(() => store.blockExecution({ claim: previous, reason: 'execution-failed' }), leaseLost);
  const recovery = store.claimRecovery(intent.id);
  assert.equal(recovery.intent.status, 'interrupted');
  assert.equal(recovery.generation, previous.generation + 1);
  assert.notEqual(recovery.owner, previous.owner);
  store.assertRecoveryOwnership(recovery);
  assert.throws(() => store.assertExecutionOwnership(recovery), leaseLost);
  assert.equal(store.claimRecovery(intent.id), null);
  store.reconcileExecution({ claim: recovery, reason: 'execution-interrupted' });
  assert.equal(store.listExecutionIntents()[0].status, 'interrupted');
  assert.equal(store.listExecutionIntents()[0].reason, 'execution-interrupted');
  assert.deepEqual(store.listExpiredExecutions(), []);
  assert.equal(store.claimExecution(intent.id), null);
  const reconciliationOnly = store.claimRecovery(intent.id);
  assert.ok(reconciliationOnly);
  assert.throws(() => store.assertExecutionOwnership(reconciliationOnly), leaseLost);
  store.reconcileExecution({ claim: reconciliationOnly, reason: 'execution-interrupted' });
});

test('recovery can reconcile a persisted result without readmitting execution and cannot use stale ownership', async t => {
  const { store, job, statePath } = await fixture(t);
  const { intent } = store.enqueueExecution(input(job));
  store.claimExecution(intent.id);
  expire(statePath, intent.id);
  const abandoned = store.claimRecovery(intent.id);
  expire(statePath, intent.id);
  const replacement = store.claimRecovery(intent.id);
  assert.equal(replacement.generation, abandoned.generation + 1);
  assert.throws(() => store.reconcileExecution({ claim: abandoned, outcome: outcome(intent) }), leaseLost);
  assert.throws(() => store.assertRecoveryOwnership(abandoned), leaseLost);
  assert.throws(() => store.reconcileExecution({ claim: replacement, outcome: outcome(intent, { receiptId: randomUUID() }) }), invalid);
  assert.throws(() => store.reconcileExecution({ claim: replacement }), invalid);
  assert.throws(() => store.reconcileExecution({ claim: replacement, outcome: outcome(intent), reason: 'cleanup-unresolved' }), invalid);
  store.reconcileExecution({ claim: replacement, outcome: outcome(intent) });
  assert.equal(store.listExecutionIntents()[0].status, 'completed');
  assert.deepEqual(store.listExpiredExecutions(), []);
  assert.equal(store.claimExecution(intent.id), null);
});

test('unknown cleanup remains recoverable after restart and never grants execution permission', async t => {
  const { store, job, statePath } = await fixture(t);
  const { intent } = store.enqueueExecution(input(job));
  store.claimExecution(intent.id);
  expire(statePath, intent.id);
  const recovery = store.claimRecovery(intent.id);
  assert.throws(() => store.reconcileExecution({ claim: recovery, reason: 'arbitrary private diagnostic' }), invalid);
  store.reconcileExecution({ claim: recovery, reason: 'cleanup-unresolved' });
  store.close();
  const reopened = await openWorkerStore(statePath);
  t.after(() => reopened.close());
  assert.equal(reopened.listExpiredExecutions()[0].reason, 'cleanup-unresolved');
  assert.equal(reopened.claimExecution(intent.id), null);
  const next = reopened.claimRecovery(intent.id);
  assert.equal(next.generation, recovery.generation + 1);
  reopened.reconcileExecution({ claim: next, reason: 'invalid-outcome' });
  assert.deepEqual(reopened.listExpiredExecutions(), []);
  assert.equal(reopened.claimExecution(intent.id), null);
});

test('an explicitly discovered late outcome can complete an interrupted attempt without reexecution', async t => {
  for (const reason of ['execution-interrupted', 'invalid-outcome']) {
    const { store, job, statePath } = await fixture(t);
    const { intent } = store.enqueueExecution(input(job));
    const original = store.claimExecution(intent.id);
    expire(statePath, intent.id);
    const recovery = store.claimRecovery(intent.id);
    store.reconcileExecution({ claim: recovery, reason });
    assert.deepEqual(store.listExpiredExecutions(), []);
    assert.equal(store.claimExecution(intent.id), null);
    // The orchestration layer discovered a now-complete artifact from the original consumed attempt.
    const late = store.claimRecovery(intent.id);
    assert.equal(late.generation, recovery.generation + 1);
    assert.throws(() => store.assertExecutionOwnership(late), leaseLost);
    assert.throws(() => store.completeExecution({ claim: original, outcome: outcome(intent) }), leaseLost);
    assert.throws(() => store.reconcileExecution({ claim: late, outcome: outcome(intent, { receiptId: randomUUID() }) }), invalid);
    store.reconcileExecution({ claim: late, outcome: outcome(intent) });
    assert.equal(store.listExecutionIntents()[0].status, 'completed');
    assert.equal(store.claimExecution(intent.id), null);
    assert.equal(store.claimRecovery(intent.id), null);
  }
});

test('an active execution with uncertain cleanup can immediately recover without being executed again', async t => {
  const { store, job } = await fixture(t);
  const { intent } = store.enqueueExecution(input(job));
  const claim = store.claimExecution(intent.id);
  assert.throws(() => store.interruptExecution({ claim, reason: 'arbitrary error detail' }), invalid);
  store.interruptExecution({ claim, reason: 'cleanup-unresolved' });
  assert.equal(store.claimExecution(intent.id), null);
  assert.throws(() => store.assertExecutionOwnership(claim), leaseLost);
  assert.throws(() => store.interruptExecution({ claim, reason: 'cleanup-unresolved' }), leaseLost);
  const recovery = store.claimRecovery(intent.id);
  assert.ok(recovery);
  store.assertRecoveryOwnership(recovery);
  // The orchestrator has subsequently verified cleanup; the historical validation outcome stays blocked.
  const historical = outcome(intent, { status: 'blocked', candidate: { status: 'cleanup-failed', exitCode: 0, cleanup: 'failed' } });
  store.reconcileExecution({ claim: recovery, outcome: historical });
  assert.equal(store.listExecutionIntents()[0].status, 'completed');
  assert.equal(store.listExecutionIntents()[0].outcome.status, 'blocked');
  assert.equal(store.listExecutionIntents()[0].outcome.candidate.cleanup, 'failed');
  assert.equal(store.claimExecution(intent.id), null);
});

test('blocking uses fixed reasons and a queued receipt cannot be silently replaced after failure', async t => {
  const { store, job } = await fixture(t);
  const queued = input(job);
  const { intent } = store.enqueueExecution(queued);
  const claim = store.claimExecution(intent.id);
  assert.throws(() => store.blockExecution({ claim, reason: 'raw exception text' }), invalid);
  store.blockExecution({ claim, reason: 'stale-evidence' });
  assert.equal(store.enqueueExecution(queued).intent.status, 'blocked');
  assert.equal(store.enqueueExecution(queued).created, false);
  assert.equal(store.claimExecution(intent.id), null);
  assert.throws(() => store.blockExecution({ claim, reason: 'approval-invalid' }), leaseLost);
});

test('v1 migration preserves snapshots, jobs, observations and an outstanding observation lease', async t => {
  const { store, job, statePath, subscription } = await fixture(t);
  const lease = store.claim(subscription.id);
  const expectedSubscription = store.listSubscriptions()[0];
  store.close();
  editState(statePath, db => db.exec('DROP TABLE execution_intents; PRAGMA user_version=1;'));
  const reopened = await openWorkerStore(statePath);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.listSubscriptions(), [expectedSubscription]);
  assert.deepEqual(reopened.listJobs(), [job]);
  assert.deepEqual(Buffer.from(reopened.getJobEvidence(job.id).revision.bytes), revision.bytes);
  assert.equal(reopened.claim(subscription.id), null);
  assert.deepEqual(reopened.listExecutionIntents(), []);
  editState(statePath, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
  });
  reopened.failObservation({ lease, reason: 'analysis-failed' });
  assert.equal(reopened.enqueueExecution(input(job)).created, true);
});

test('a migration error rolls back the new table and preserves v1 data and version', async t => {
  const { store, statePath, job } = await fixture(t);
  store.close();
  editState(statePath, db => db.exec(`DROP TABLE execution_intents; PRAGMA user_version=1;
    CREATE INDEX execution_intents_status ON jobs(created_at);`));
  await assert.rejects(openWorkerStore(statePath), invalid);
  editState(statePath, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='execution_intents'").get().n, 0);
    assert.equal(db.prepare('SELECT id FROM jobs').get().id, job.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
  });
});

test('concurrent processes can open and migrate the same v1 database without losing retained work', async t => {
  const { store, statePath, job } = await fixture(t);
  store.close();
  editState(statePath, db => db.exec('DROP TABLE execution_intents; PRAGMA user_version=1;'));
  const moduleUrl = new URL('../dist/worker-store.js', import.meta.url).href;
  const script = `import { openWorkerStore } from ${JSON.stringify(moduleUrl)}; const s=await openWorkerStore(process.argv[1]); try { process.stdout.write(JSON.stringify({jobs:s.listJobs().map(j=>j.id),intents:s.listExecutionIntents()})); } finally { s.close(); }`;
  const children = await Promise.all(Array.from({ length: 2 }, () => execute(process.execPath,
    ['--input-type=module', '-e', script, statePath], { timeout: 15_000 })));
  for (const child of children) assert.deepEqual(JSON.parse(child.stdout), { jobs: [job.id], intents: [] });
  editState(statePath, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2));
});

test('intent count limits preserve all pending work and leave existing enqueue idempotent', async t => {
  const { store, job, statePath } = await fixture(t);
  const queued = input(job);
  const { intent } = store.enqueueExecution(queued);
  // A controlled durable fixture models a full queue without executing any consumer work.
  editState(statePath, db => {
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare(`INSERT INTO execution_intents
      (id,job_id,receipt_id,request_id,plan_id,execution_digest,policy_digest,recipe_json,test_paths_json,status,created_at,updated_at)
      SELECT ?,job_id,?,request_id,plan_id,execution_digest,policy_digest,recipe_json,test_paths_json,status,created_at,updated_at
      FROM execution_intents WHERE id=?`);
    for (let n = 1; n < 1000; n++) {
      const receipt = randomUUID();
      insert.run(hash(receipt), receipt, intent.id);
    }
    db.exec('COMMIT');
  });
  assert.throws(() => store.enqueueExecution(input(job)), { code: 'STATE_LIMIT' });
  assert.equal(store.listExecutionIntents().length, 1000);
  assert.equal(store.enqueueExecution(queued).created, false);
  assert.equal(store.listJobs().length, 1);
});
