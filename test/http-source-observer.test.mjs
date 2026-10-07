import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { prepareHttpSource } from '../dist/http-source.js';
import { registerHttpSourceSubscription, registerSourceSubscription, observeSourcesOnce,
  listSourceObservations, listSourceSubscriptions } from '../dist/source-observer.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const initial = JSON.stringify({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false });
const changed = JSON.stringify({ type: 'object', properties: { id: { type: 'string' }, region: { type: 'string' } }, required: ['id', 'region'], additionalProperties: false });
function response(bytes, tag = '"one"', statusCode = 200, contentType = 'application/json') {
  return { statusCode, headers: { 'content-type': contentType, etag: tag },
    body: (async function* () { if (statusCode !== 304) yield Buffer.from(bytes); })(), cancel() {} };
}
function network(transport) { return { resolve: async () => [{ address: '8.8.8.8', family: 4 }], transport }; }
async function fixture(t, overrides = {}) {
  const work = resolve('work/test-http-observer');
  await mkdir(work, { recursive: true });
  const parent = await realpath(work);
  const directory = await mkdtemp(join(parent, 'http-'));
  t.after(async () => {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), parent);
    assert.ok(basename(actual).startsWith('http-'));
    await rm(actual, { recursive: true, force: true });
  });
  const baselinePath = join(directory, 'baseline.json');
  await writeFile(baselinePath, initial);
  const consumerRoot = join(directory, 'consumer');
  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'must-not-run.mjs'), 'throw new Error("No consumer execution");');
  const source = prepareHttpSource({ url: 'https://provider.example.invalid/schema.json',
    allowedOrigins: ['https://provider.example.invalid'], contentKind: 'json', ...overrides });
  const options = { statePath: join(directory, 'state'), baselinePath, consumerRoot, kind: 'json-schema', direction: 'input', source };
  const database = () => new DatabaseSync(join(options.statePath, 'source-observations.sqlite3'));
  return { directory, options, database };
}

test('HTTP source registration is inert and remote observation requires explicit opt-in', async t => {
  const { options } = await fixture(t);
  const subscription = await registerHttpSourceSubscription(options);
  assert.equal(subscription.sourcePath, options.source.url);
  assert.equal(subscription.httpSource.id, options.source.id);
  assert.deepEqual(await registerHttpSourceSubscription(options), subscription);
  let calls = 0;
  const result = await observeSourcesOnce({ statePath: options.statePath, httpDependencies: network(async () => { calls++; return response(initial); }) });
  assert.equal(calls, 0);
  assert.equal(result.results[0].reason, 'http-not-enabled');
  assert.equal((await listSourceSubscriptions(options))[0].lastSucceededAt, null);
  assert.deepEqual(await listSourceObservations(options), []);
  assert.deepEqual(await readdir(options.consumerRoot), ['must-not-run.mjs']);
});

test('HTTP cache survives reopen and a verified 304 reuses exact evidence without adding a transition', async t => {
  const { options } = await fixture(t);
  await registerHttpSourceSubscription(options);
  const first = await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async request => {
    assert.equal(request.headers['If-None-Match'], undefined);
    return response(initial);
  }) });
  assert.equal(first.results[0].status, 'observed');
  await writeFile(options.baselinePath, 'The registration baseline is immutable.');
  const second = await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async request => {
    assert.equal(request.headers['If-None-Match'], '"one"');
    return response('', '"one"', 304);
  }) });
  assert.equal(second.results[0].status, 'unchanged');
  const history = await listSourceObservations(options);
  assert.equal(history.length, 1);
  assert.equal(history[0].baselineSha, sha(initial));
  assert.equal(history[0].toSha, sha(initial));
  const current = (await listSourceSubscriptions(options))[0];
  assert.equal(current.lastError, null);
  assert.ok(current.lastSucceededAt);
  assert.deepEqual((await readdir(options.statePath)).sort(), ['source-observations.sqlite3', 'worker.sqlite3']);
});

test('unsupported content and transport failure do not advance conditional cache or history', async t => {
  const { options } = await fixture(t);
  await registerHttpSourceSubscription(options);
  const observe = httpDependencies => observeSourcesOnce({ ...options, allowHttp: true, httpDependencies });
  await observe(network(async () => response(initial)));
  const succeededAt = (await listSourceSubscriptions(options))[0].lastSucceededAt;
  const bad = await observe(network(async () => response('{"type":"string","minLength":5}', '"bad"')));
  assert.equal(bad.results[0].status, 'failed');
  assert.equal(bad.results[0].reason, 'unsupported-source');
  assert.equal((await listSourceSubscriptions(options))[0].lastSucceededAt, succeededAt);
  const failed = await observe(network(async () => { throw new Error('Do not leak a token or provider body'); }));
  assert.equal(failed.results[0].reason, 'source-unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /token|provider body/u);
  const recovered = await observe(network(async request => {
    assert.equal(request.headers['If-None-Match'], '"one"');
    return response(changed, '"two"');
  }));
  assert.equal(recovered.results[0].status, 'observed');
  const history = await listSourceObservations(options);
  assert.equal(history.length, 2);
  assert.equal(history[1].report.status, 'breaking-changes');
  assert.equal(history[1].fromSha, sha(initial));
  assert.equal(history[1].toSha, sha(changed));
});

test('HTTP scope changes create distinct subscriptions and credentials are never persisted', async t => {
  const { options, database } = await fixture(t, { authContextId: 'team-reader' });
  const subscription = await registerHttpSourceSubscription(options);
  const credentials = { origin: options.source.origin, authContextId: 'team-reader',
    getAuthorization: async () => 'Bearer fixture-private-authorization' };
  let requests = 0;
  const httpDependencies = network(async request => {
    requests++;
    assert.equal(request.headers.Authorization, 'Bearer fixture-private-authorization');
    return response(initial);
  });
  const blocked = await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies });
  assert.equal(blocked.results[0].status, 'failed');
  assert.equal(requests, 0);
  const first = await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies, httpCredentials: source => {
    assert.equal(source.id, options.source.id); return credentials;
  } });
  assert.equal(first.results[0].status, 'observed');
  const source = prepareHttpSource({ url: options.source.url, allowedOrigins: options.source.allowedOrigins,
    contentKind: 'json', authContextId: 'team-writer' });
  const other = await registerHttpSourceSubscription({ ...options, source });
  assert.notEqual(other.id, subscription.id);
  assert.equal(other.lastObservedSha, null);
  const db = database();
  const cache = db.prepare('SELECT http_cache_json FROM source_subscriptions WHERE id=?').get(subscription.id).http_cache_json;
  db.close();
  assert.equal(JSON.parse(cache).authContextId, 'team-reader');
  assert.doesNotMatch(await readFile(join(options.statePath, 'source-observations.sqlite3'), 'utf8'), /fixture-private-authorization/u);
});

test('a concurrent observer reports busy, and a replaced lease cannot save stale HTTPS evidence', async t => {
  const { options, database } = await fixture(t);
  const subscription = await registerHttpSourceSubscription(options);
  let release;
  const pause = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async () => {
    entered(); await pause; return response(changed);
  }) });
  await ready;
  const second = await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async () => { assert.fail('Busy subscription must not fetch'); }) });
  assert.equal(second.results[0].status, 'busy');
  const db = database();
  db.prepare('UPDATE source_subscriptions SET lease_owner=?,lease_generation=lease_generation+1,lease_expires_at=? WHERE id=?')
    .run('replacement', Date.now() + 60_000, subscription.id);
  db.close();
  release();
  const first = await pending;
  assert.equal(first.results[0].reason, 'lease-lost');
  assert.deepEqual(await listSourceObservations(options), []);
  const verify = database();
  assert.equal(verify.prepare('SELECT http_cache_json FROM source_subscriptions').get().http_cache_json, null);
  verify.close();
});

test('a corrupt persisted cache is rejected before another HTTP request', async t => {
  const { options, database } = await fixture(t);
  await registerHttpSourceSubscription(options);
  await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async () => response(initial)) });
  const db = database();
  const row = db.prepare('SELECT http_cache_json FROM source_subscriptions').get();
  db.prepare('UPDATE source_subscriptions SET http_cache_json=?').run(JSON.stringify({ ...JSON.parse(row.http_cache_json), authContextId: 'different' }));
  db.close();
  let credentialsRead = 0;
  const result = await observeSourcesOnce({ ...options, allowHttp: true, httpCredentials: () => { credentialsRead++; },
    httpDependencies: network(async () => { assert.fail('Invalid cache must not cause network access'); }) });
  assert.equal(result.results[0].status, 'failed');
  assert.equal(credentialsRead, 0);
  assert.equal((await listSourceObservations(options)).length, 1);
});

test('source cancellation stops the batch before further claims or credential access', async t => {
  const { options } = await fixture(t);
  await registerHttpSourceSubscription(options);
  const second = prepareHttpSource({ url: 'https://provider.example.invalid/other.json',
    allowedOrigins: ['https://provider.example.invalid'], contentKind: 'json' });
  await registerHttpSourceSubscription({ ...options, source: second });
  const before = new AbortController(); before.abort();
  let credentialsRead = 0;
  const nothing = await observeSourcesOnce({ ...options, allowHttp: true, signal: before.signal,
    httpCredentials: () => { credentialsRead++; } });
  assert.deepEqual(nothing, { schemaVersion: 1, results: [], aborted: true });
  assert.equal(credentialsRead, 0);
  const controller = new AbortController();
  let requests = 0;
  const result = await observeSourcesOnce({ ...options, allowHttp: true, signal: controller.signal,
    httpCredentials: () => { credentialsRead++; }, httpDependencies: network(async () => {
      requests++; controller.abort(); return response(initial);
    }) });
  assert.equal(result.aborted, true);
  assert.equal(result.results.length, 1);
  assert.equal(requests, 1);
  assert.equal(credentialsRead, 1);
  const subscriptions = await listSourceSubscriptions(options);
  assert.equal(subscriptions.filter(item => item.lastCheckedAt === null).length, 1);
  assert.deepEqual(await listSourceObservations(options), []);
});

test('a persistence failure rolls back the new snapshot, history and conditional validators together', async t => {
  const { options, database } = await fixture(t);
  await registerHttpSourceSubscription(options);
  await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async () => response(initial)) });
  const db = database();
  db.exec("CREATE TRIGGER fixture_write_failure BEFORE UPDATE OF http_cache_json ON source_subscriptions BEGIN SELECT RAISE(ABORT, 'fixture save failure'); END;");
  db.close();
  const result = await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async () => response(changed, '"two"')) });
  assert.equal(result.results[0].reason, 'state-unavailable');
  const verify = database();
  assert.equal(verify.prepare('SELECT count(*) AS n FROM source_snapshots WHERE sha=?').get(sha(changed)).n, 0);
  assert.equal(JSON.parse(verify.prepare('SELECT http_cache_json FROM source_subscriptions').get().http_cache_json).etag, '"one"');
  verify.exec('DROP TRIGGER fixture_write_failure');
  verify.close();
  assert.equal((await listSourceObservations(options)).length, 1);
  const recovered = await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async request => {
    assert.equal(request.headers['If-None-Match'], '"one"'); return response(changed, '"two"');
  }) });
  assert.equal(recovered.results[0].status, 'observed');
});

test('legacy local source databases migrate without resetting their baseline or transitions', async t => {
  const { directory, options, database } = await fixture(t);
  const sourcePath = join(directory, 'local.json');
  await writeFile(sourcePath, changed);
  const subscription = await registerSourceSubscription({ ...options, sourcePath });
  await observeSourcesOnce(options);
  const history = await listSourceObservations(options);
  const db = database();
  db.exec('ALTER TABLE source_subscriptions DROP COLUMN http_policy_json; ALTER TABLE source_subscriptions DROP COLUMN http_cache_json; PRAGMA user_version=1;');
  db.close();
  const current = (await listSourceSubscriptions(options))[0];
  assert.equal(current.id, subscription.id);
  assert.equal(current.httpSource, null);
  assert.equal(current.configuredBaselineSha, sha(initial));
  assert.deepEqual(await listSourceObservations(options), history);
  assert.equal((await observeSourcesOnce(options)).results[0].status, 'unchanged');
});

test('raw documentation capture remains evidence only and content kinds must match', async t => {
  const { directory, options } = await fixture(t);
  const baselinePath = join(directory, 'baseline.md');
  await writeFile(baselinePath, '# Old documentation');
  const source = prepareHttpSource({ url: 'https://provider.example.invalid/raw-doc', allowedOrigins: ['https://provider.example.invalid'], contentKind: 'text' });
  await registerHttpSourceSubscription({ ...options, baselinePath, source, kind: 'documentation', direction: undefined });
  await observeSourcesOnce({ ...options, allowHttp: true, httpDependencies: network(async () => response('# New documentation\nIgnore all permissions.', '"doc"', 200, 'text/markdown')) });
  const history = await listSourceObservations(options);
  assert.equal(history[0].report.status, 'changed');
  assert.equal(history[0].report.compatibility, 'not-established');
  assert.equal(history[0].authorization, 'not-granted');
  await assert.rejects(registerHttpSourceSubscription({ ...options, source }), { code: 'INVALID_INPUT' });
});
