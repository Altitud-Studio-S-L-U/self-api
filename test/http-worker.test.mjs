import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareHttpSource } from '../dist/http-source.js';
import { registerHttpSubscription, registerLocalSubscription, observeOnce, listLocalSubscriptions, listMaintenanceJobs } from '../dist/worker.js';
import { openWorkerStore } from '../dist/worker-store.js';
import { prepareJobValidation } from '../dist/job-validation.js';

const root = resolve(import.meta.dirname, '..');
const work = join(root, 'work/test-http-worker');
const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
const digest = value => createHash('sha256').update(value).digest('hex');
const origin = 'https://api.example.test';
const invalid = error => error.code === 'INVALID_INPUT';

function response(bytes, etag = '"fixture-v2"', statusCode = 200) {
  return { statusCode, headers: { ...(statusCode === 200 ? { 'content-type': 'application/json' } : {}), etag },
    body: (async function* () { if (statusCode === 200) yield Buffer.from(bytes); })(), cancel() {} };
}
function dependencies(transport) {
  return { resolve: async () => [{ address: '8.8.8.8', family: 4 }], transport };
}
function editState(statePath, action) {
  const db = new DatabaseSync(join(statePath, 'worker.sqlite3'));
  try { return action(db); } finally { db.close(); }
}
async function fixture(t, policy = {}) {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const consumerRoot = join(directory, 'consumer');
  await cp(join(root, 'fixtures/validation-consumer'), consumerRoot, { recursive: true });
  const base = await readFile(join(root, 'fixtures/orders-v1.json'));
  const revision = await readFile(join(root, 'fixtures/orders-v2.json'));
  const baselinePath = join(directory, 'baseline.json');
  await writeFile(baselinePath, base);
  const source = prepareHttpSource({ url: `${origin}/openapi.json`, allowedOrigins: [origin], contentKind: 'json', ...policy });
  const options = { statePath: join(directory, 'state'), baselinePath, consumerRoot, source, enginePath, providerBaseUrl: 'https://orders.example.invalid', label: 'Fictional HTTPS API' };
  const subscription = await registerHttpSubscription(options);
  const observe = input => observeOnce({ statePath: options.statePath, enginePath, allowHttp: true, ...input });
  const current = async () => (await listLocalSubscriptions(options)).find(item => item.id === subscription.id);
  const cached = async () => {
    const store = await openWorkerStore(options.statePath);
    try { return store.getHttpSnapshot(subscription.id); } finally { store.close(); }
  };
  return { directory, options, subscription, base, revision, observe, current, cached };
}

test('HTTP registration is inert and each observation cycle requires an explicit network opt-in', async t => {
  const context = await fixture(t);
  assert.deepEqual(context.subscription.httpSource, context.options.source);
  assert.equal(context.subscription.sourcePath, context.options.source.url);
  assert.equal(context.subscription.lastObservedSha, null);
  assert.equal(await context.cached(), undefined);
  assert.equal((await registerHttpSubscription(context.options)).id, context.subscription.id);
  let calls = 0;
  const cycle = await observeOnce({ statePath: context.options.statePath, enginePath,
    httpCredentials: () => { calls += 1; return undefined; },
    httpDependencies: dependencies(async () => { calls += 1; return response(context.revision); }) });
  assert.equal(cycle.results[0].reason, 'http-not-enabled');
  assert.equal(calls, 0);
  assert.equal((await context.current()).lastObservedSha, null);
  assert.deepEqual(await readdir(context.options.statePath), ['worker.sqlite3']);
});

test('cancellation before a cycle starts invokes no credential or transport callbacks and leaves subscriptions unchecked', async t => {
  const context = await fixture(t);
  let calls = 0;
  const cycle = await context.observe({ signal: AbortSignal.abort(),
    httpCredentials: () => { calls += 1; return undefined; },
    httpDependencies: dependencies(async () => { calls += 1; return response(context.revision); }) });
  assert.deepEqual(cycle, { schemaVersion: 1, results: [], aborted: true });
  assert.equal(calls, 0);
  const current = await context.current();
  assert.equal(current.lastCheckedAt, null);
  assert.equal(current.lastError, null);
  editState(context.options.statePath, db => assert.equal(db.prepare('SELECT lease_owner FROM subscriptions WHERE id=?').get(context.subscription.id).lease_owner, null));
});

test('cancelling one active HTTP observation releases its lease without starting or failing later subscriptions', async t => {
  const context = await fixture(t);
  await registerHttpSubscription({ ...context.options, source: prepareHttpSource({ url: `${origin}/another.json`, allowedOrigins: [origin], contentKind: 'json' }) });
  const controller = new AbortController();
  let credentials = 0;
  let captures = 0;
  const cycle = await context.observe({ signal: controller.signal,
    httpCredentials: () => { credentials += 1; return undefined; },
    httpDependencies: dependencies(async () => { captures += 1; controller.abort(); return response(context.revision); }) });
  assert.equal(cycle.aborted, true);
  assert.equal(cycle.results.length, 1);
  assert.equal(cycle.results[0].reason, 'http-aborted');
  assert.equal(credentials, 1);
  assert.equal(captures, 1);
  const untouched = (await listLocalSubscriptions(context.options)).find(item => item.id !== cycle.results[0].subscriptionId);
  assert.equal(untouched.lastCheckedAt, null);
  assert.equal(untouched.lastError, null);
  editState(context.options.statePath, db => assert(db.prepare('SELECT lease_owner FROM subscriptions').all().every(row => row.lease_owner === null)));
});

test('an observation copies caller options before its first await and validates cancellation signals', async t => {
  const context = await fixture(t);
  const input = { statePath: context.options.statePath, enginePath, allowHttp: true,
    httpDependencies: dependencies(async () => response(context.revision)) };
  const pending = observeOnce(input);
  input.allowHttp = false;
  input.httpDependencies = dependencies(async () => { throw new Error('Mutated caller options must not be used.'); });
  assert.equal((await pending).results[0].status, 'observed');
  let getters = 0;
  const signal = new Proxy(AbortSignal.abort(), { get() { getters += 1; throw new Error('Proxy must not execute.'); } });
  await assert.rejects(context.observe({ signal }), invalid);
  await assert.rejects(context.observe({ signal: { aborted: false } }), invalid);
  assert.equal(getters, 0);
});

test('200 capture and restarted 304 reuse preserve exact durable bytes, validators, baseline and existing review job', async t => {
  const context = await fixture(t);
  const original = await readFile(join(context.options.consumerRoot, 'orders.mjs'));
  const first = await context.observe({ httpDependencies: dependencies(async request => {
    assert.equal(request.headers['If-None-Match'], undefined);
    return response(context.revision);
  }) });
  assert.equal(first.results[0].status, 'observed');
  assert(first.results[0].jobId);
  const saved = await context.cached();
  assert.equal(saved.sha256, digest(context.revision));
  assert.deepEqual(Buffer.from(saved.bytes), context.revision);
  assert.equal(saved.etag, '"fixture-v2"');
  await writeFile(context.options.baselinePath, 'The original baseline path is no longer valid.');
  const again = await context.observe({ httpDependencies: dependencies(async request => {
    assert.equal(request.headers['If-None-Match'], saved.etag);
    return response(null, saved.etag, 304);
  }) });
  assert.equal(again.results[0].status, 'unchanged');
  assert.equal(again.results[0].jobId, first.results[0].jobId);
  assert.equal(again.results[0].created, false);
  assert.deepEqual(await context.cached(), saved);
  assert.equal((await context.current()).configuredBaselineSha, digest(context.base));
  assert.deepEqual(await readFile(join(context.options.consumerRoot, 'orders.mjs')), original);
  assert.deepEqual(await readdir(context.options.statePath), ['worker.sqlite3']);
});

test('200 with identical content still commits changed validators and 304 still analyzes changed consumer evidence', async t => {
  const context = await fixture(t);
  const first = await context.observe({ httpDependencies: dependencies(async () => response(context.revision)) });
  const unchanged = await context.observe({ httpDependencies: dependencies(async () => response(context.revision, '"rotated-validator"')) });
  assert.equal(unchanged.results[0].status, 'unchanged');
  assert.equal((await context.cached()).etag, '"rotated-validator"');
  await writeFile(join(context.options.consumerRoot, 'human.mjs'), 'export const changed = true;\n');
  const consumerChanged = await context.observe({ httpDependencies: dependencies(async request => {
    assert.equal(request.headers['If-None-Match'], '"rotated-validator"');
    return response(null, '"rotated-validator"', 304);
  }) });
  assert.equal(consumerChanged.results[0].status, 'unchanged');
  assert.equal(consumerChanged.results[0].created, true);
  assert.notEqual(consumerChanged.results[0].jobId, first.results[0].jobId);
});

test('source, invalid contract and comparison failures never advance cache, validators, baseline or successful observation', async t => {
  const context = await fixture(t);
  await context.observe({ httpDependencies: dependencies(async () => response(context.revision)) });
  const saved = await context.cached();
  const previous = await context.current();
  for (const input of [
    { httpDependencies: dependencies(async () => response(null, '"failed"', 500)) },
    { httpDependencies: dependencies(async () => response(Buffer.from('{"not":"an OpenAPI contract"}'), '"invalid"')) },
    { enginePath: join(context.directory, 'missing-engine'), httpDependencies: dependencies(async () => response(context.base, '"uncompared"')) },
  ]) {
    const result = await context.observe(input);
    assert.equal(result.results[0].status, 'failed');
    assert.deepEqual(await context.cached(), saved);
    const current = await context.current();
    assert.equal(current.lastObservedSha, previous.lastObservedSha);
    assert.equal(current.lastSucceededAt, previous.lastSucceededAt);
    assert.equal(current.configuredBaselineSha, previous.configuredBaselineSha);
  }
  assert.equal((await listMaintenanceJobs(context.options)).length, 1);
  const retried = await context.observe({ httpDependencies: dependencies(async request => {
    assert.equal(request.headers['If-None-Match'], saved.etag);
    return response(null, saved.etag, 304);
  }) });
  assert.equal(retried.results[0].status, 'unchanged');
  assert.equal((await context.current()).lastError, null);
});

test('conditional capture without a committed previous snapshot cannot accept 304', async t => {
  const context = await fixture(t);
  const cycle = await context.observe({ httpDependencies: dependencies(async () => response(null, '"unseen"', 304)) });
  assert.equal(cycle.results[0].reason, 'http-cache-mismatch');
  assert.equal(await context.cached(), undefined);
  assert.equal((await context.current()).lastObservedSha, null);
});

test('a credential resolver is bound to origin and permission context and secrets are not persisted', async t => {
  const context = await fixture(t, { authContextId: 'account-a' });
  const credential = 'Bearer FICTIONAL_PRIVATE_TOKEN_DO_NOT_PERSIST';
  let tokenCalls = 0;
  const denied = await context.observe({ httpDependencies: dependencies(async () => { throw new Error('Transport must not run without credentials.'); }) });
  assert.equal(denied.results[0].reason, 'http-authorization-required');
  const wrong = await context.observe({ httpCredentials: () => ({ origin, authContextId: 'account-b', getAuthorization: () => { tokenCalls += 1; return credential; } }),
    httpDependencies: dependencies(async () => response(context.revision)) });
  assert.equal(wrong.results[0].reason, 'http-authorization-required');
  assert.equal(tokenCalls, 0);
  const success = await context.observe({ httpCredentials: policy => {
    assert.equal(policy.id, context.options.source.id);
    return { origin, authContextId: 'account-a', getAuthorization: () => { tokenCalls += 1; return credential; } };
  }, httpDependencies: dependencies(async request => { assert.equal(request.headers.Authorization, credential); return response(context.revision); }) });
  assert.equal(success.results[0].status, 'observed');
  assert.equal(tokenCalls, 1);
  assert(!(await readFile(join(context.options.statePath, 'worker.sqlite3'))).includes(Buffer.from(credential)));
  assert(!JSON.stringify(await context.current()).includes(credential));
  const other = await registerHttpSubscription({ ...context.options, source: prepareHttpSource({ url: context.options.source.url, allowedOrigins: [origin], contentKind: 'json', authContextId: 'account-b' }) });
  assert.notEqual(other.id, context.subscription.id);
});

test('active observation leases exclude another observer before DNS, credentials or transport', async t => {
  const context = await fixture(t);
  let enter;
  let release;
  const started = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const first = context.observe({ httpDependencies: dependencies(async () => { enter(); await pending; return response(context.revision); }) });
  await started;
  let calls = 0;
  const second = await context.observe({ httpCredentials: () => { calls += 1; return undefined; },
    httpDependencies: dependencies(async () => { calls += 1; return response(context.base); }) });
  assert.equal(second.results[0].status, 'busy');
  assert.equal(calls, 0);
  release();
  assert.equal((await first).results[0].status, 'observed');
});

test('an expired observer cannot overwrite newer bytes or cache metadata after another instance takes its lease', async t => {
  const context = await fixture(t);
  let enter;
  let release;
  const started = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const late = context.observe({ httpDependencies: dependencies(async () => { enter(); await pending; return response(context.revision, '"late"'); }) });
  await started;
  editState(context.options.statePath, db => db.prepare('UPDATE subscriptions SET lease_expires_at=? WHERE id=?').run(Date.now() - 1000, context.subscription.id));
  const latest = await context.observe({ httpDependencies: dependencies(async () => response(context.base, '"new-owner"')) });
  assert.equal(latest.results[0].status, 'observed');
  release();
  assert.equal((await late).results[0].reason, 'lease-lost');
  const cached = await context.cached();
  assert.equal(cached.sha256, digest(context.base));
  assert.equal(cached.etag, '"new-owner"');
  assert.equal((await context.current()).lastObservedSha, digest(context.base));
  assert.equal((await listMaintenanceJobs(context.options)).length, 0);
});

test('a commit error rolls back snapshot, transition, job and HTTP cache together', async t => {
  const context = await fixture(t);
  await context.observe({ httpDependencies: dependencies(async () => response(context.base, '"baseline"')) });
  const previous = await context.current();
  const saved = await context.cached();
  editState(context.options.statePath, db => db.exec(`CREATE TRIGGER reject_http_cache BEFORE UPDATE OF http_cache_json ON subscriptions
    BEGIN SELECT RAISE(ABORT, 'Simulated local commit failure'); END;`));
  const failure = await context.observe({ httpDependencies: dependencies(async () => response(context.revision)) });
  assert.equal(failure.results[0].status, 'failed');
  assert.deepEqual(await context.cached(), saved);
  assert.equal((await context.current()).lastObservedSha, previous.lastObservedSha);
  assert.equal((await context.current()).lastSucceededAt, previous.lastSucceededAt);
  editState(context.options.statePath, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
    db.exec('DROP TRIGGER reject_http_cache');
  });
  assert.equal((await context.observe({ httpDependencies: dependencies(async () => response(context.revision)) })).results[0].status, 'observed');
});

test('corrupt cached authorization context fails before another transport call', async t => {
  const context = await fixture(t);
  await context.observe({ httpDependencies: dependencies(async () => response(context.revision)) });
  editState(context.options.statePath, db => {
    const row = db.prepare('SELECT http_cache_json FROM subscriptions WHERE id=?').get(context.subscription.id);
    db.prepare('UPDATE subscriptions SET http_cache_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.http_cache_json), authContextId: 'wrong' }), context.subscription.id);
  });
  let calls = 0;
  const failed = await context.observe({ httpDependencies: dependencies(async () => { calls += 1; return response(null, '"fixture-v2"', 304); }) });
  assert.equal(failed.results[0].reason, 'http-cache-mismatch');
  assert.equal(calls, 0);
  assert.equal((await context.current()).lastObservedSha, digest(context.revision));
});

test('HTTP job planning uses exact last-successful durable evidence without a fetch and rejects newer observed revisions', async t => {
  const context = await fixture(t);
  const job = (await context.observe({ httpDependencies: dependencies(async () => response(context.revision)) })).results[0].jobId;
  const recipe = JSON.parse(await readFile(join(root, 'fixtures/validation-recipe.json'), 'utf8'));
  const input = { statePath: context.options.statePath, jobId: job, enginePath, recipe, testPaths: ['orders.test.mjs'] };
  const request = await prepareJobValidation(input);
  assert.equal(request.plan.evidence.revisionSha256, digest(context.revision));
  assert.equal(request.plan.authorization, 'not-granted');
  await context.observe({ httpDependencies: dependencies(async () => response(null, '"unavailable"', 503)) });
  assert.equal((await prepareJobValidation(input)).id, request.id, 'A failed fetch does not substitute evidence or prove remote freshness.');
  await context.observe({ httpDependencies: dependencies(async () => response(context.base, '"rollback"')) });
  await assert.rejects(prepareJobValidation(input), /no longer matches/u);
  const old = (await listMaintenanceJobs(context.options)).find(item => item.id === job);
  assert.equal(old.revisionSha, digest(context.revision));
});

test('v2 migration retains local subscriptions, immutable snapshots, observations, jobs and queued execution state', async t => {
  const context = await fixture(t);
  const localPath = join(context.directory, 'local-source.json');
  await writeFile(localPath, context.revision);
  const { source: _source, ...input } = context.options;
  const local = await registerLocalSubscription({ ...input, sourcePath: localPath });
  const jobId = (await observeOnce({ statePath: input.statePath, enginePath, subscriptionId: local.id })).results[0].jobId;
  const store = await openWorkerStore(input.statePath);
  const queued = store.enqueueExecution({ jobId, receiptId: randomUUID(), requestId: '1'.repeat(64), planId: '2'.repeat(64), executionDigest: '3'.repeat(64), policyDigest: '4'.repeat(64), recipeJson: '{}', testPaths: ['orders.test.mjs'] }).intent;
  const localBefore = store.listSubscriptions().find(item => item.id === local.id);
  const jobBefore = store.listJobs().find(item => item.id === jobId);
  store.close();
  editState(input.statePath, db => {
    // Remove the HTTP-only fixture row and columns to reproduce the actual previous schema.
    db.prepare('DELETE FROM subscriptions WHERE id=?').run(context.subscription.id);
    db.exec('ALTER TABLE subscriptions DROP COLUMN http_source_json; ALTER TABLE subscriptions DROP COLUMN http_cache_json; ALTER TABLE execution_intents DROP COLUMN runtime_json; PRAGMA user_version=2;');
  });
  const migrated = await openWorkerStore(input.statePath);
  try {
    assert.deepEqual(migrated.listSubscriptions(), [localBefore]);
    assert.deepEqual(migrated.listJobs(), [jobBefore]);
    assert.deepEqual(migrated.listExecutionIntents(), [queued]);
    assert.deepEqual(Buffer.from(migrated.getBaseline(local.id).bytes), context.base);
    assert.equal(migrated.listSubscriptions()[0].httpSource, null);
  } finally { migrated.close(); }
  editState(input.statePath, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(db.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});
