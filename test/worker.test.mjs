import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { registerLocalSubscription, observeOnce, listLocalSubscriptions, listMaintenanceJobs } from '../dist/worker.js';
import { openWorkerStore } from '../dist/worker-store.js';

const root = resolve(import.meta.dirname, '..');
const work = join(root, 'work/test-local-worker');
const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, bom = false) {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const consumerRoot = join(directory, 'consumer');
  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'orders.ts'), await readFile(join(root, 'fixtures/consumer/orders.ts')));
  await writeFile(join(consumerRoot, 'untrusted.mjs'), "throw new Error('Observation must never execute this consumer');\n");
  const first = await readFile(join(root, 'fixtures/orders-v1.json'));
  const base = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), first]) : first;
  const revision = await readFile(join(root, 'fixtures/orders-v2.json'));
  const baselinePath = join(directory, 'baseline.json');
  const sourcePath = join(directory, 'provider.json');
  await writeFile(baselinePath, base);
  await writeFile(sourcePath, base);
  const options = { statePath: join(directory, 'state'), sourcePath, baselinePath, consumerRoot,
    providerBaseUrl: 'https://orders.example.invalid', enginePath, label: 'Fictional orders API' };
  return { options, base, revision };
}

test('local observations persist and deduplicate without moving the configured baseline or authorizing execution', async t => {
  const { options, base, revision } = await fixture(t);
  const subscription = await registerLocalSubscription(options);
  assert.equal(subscription.configuredBaselineSha, hash(base));
  assert.equal(subscription.lastObservedSha, null);
  assert.equal((await registerLocalSubscription(options)).id, subscription.id);
  await writeFile(options.baselinePath, '{original baseline file is no longer usable');
  const initial = await observeOnce(options);
  assert.equal(initial.results[0].status, 'observed');
  assert.equal(initial.results[0].jobId, undefined);
  await writeFile(options.sourcePath, revision);
  const changed = await observeOnce(options);
  assert.equal(changed.results[0].status, 'observed');
  assert.equal(changed.results[0].created, true);
  const duplicate = await observeOnce(options);
  assert.equal(duplicate.results[0].status, 'unchanged');
  assert.equal(duplicate.results[0].created, false);
  assert.equal(duplicate.results[0].jobId, changed.results[0].jobId);
  const jobs = await listMaintenanceJobs(options);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'review-required');
  assert.equal(jobs[0].report.conclusion, 'review-required');
  assert.ok(jobs[0].report.matches.length > 0);
  const current = (await listLocalSubscriptions(options))[0];
  assert.equal(current.configuredBaselineSha, hash(base));
  assert.equal(current.lastObservedSha, hash(revision));
  assert.equal(current.adopted, 'unknown');
  assert.equal(current.deployed, 'unknown');
  assert.equal(current.lastError, null);
  assert.ok(current.lastSucceededAt);
  assert.deepEqual((await readdir(options.statePath)).sort(), ['worker.sqlite3']);
});

test('consumer changes create new review evidence and provider rollback does not erase pending jobs', async t => {
  const { options, base, revision } = await fixture(t);
  await registerLocalSubscription(options);
  await writeFile(options.sourcePath, revision);
  const first = (await observeOnce(options)).results[0];
  await writeFile(join(options.consumerRoot, 'human-change.mjs'), 'export const humanChange = true;\n');
  const second = (await observeOnce(options)).results[0];
  assert.equal(second.created, true);
  assert.notEqual(first.jobId, second.jobId);
  await writeFile(options.sourcePath, base);
  const rollback = (await observeOnce(options)).results[0];
  assert.equal(rollback.status, 'observed');
  assert.equal(rollback.jobId, undefined);
  assert.equal((await listMaintenanceJobs(options)).length, 2);
  assert.equal((await listLocalSubscriptions(options))[0].configuredBaselineSha, hash(base));
});

test('failed source or engine observations preserve evidence and the same source can be retried', async t => {
  const { options, revision } = await fixture(t);
  await registerLocalSubscription(options);
  await writeFile(options.sourcePath, revision);
  const unavailable = await observeOnce({ ...options, enginePath: join(options.consumerRoot, 'missing-engine') });
  assert.equal(unavailable.results[0].status, 'failed');
  assert.equal(unavailable.results[0].reason, 'analysis-failed');
  assert.equal((await listLocalSubscriptions(options))[0].lastObservedSha, null);
  const retried = await observeOnce(options);
  assert.equal(retried.results[0].created, true);
  await writeFile(options.sourcePath, '{broken JSON');
  const broken = await observeOnce(options);
  assert.equal(broken.results[0].status, 'failed');
  assert.equal(broken.results[0].reason, 'invalid-contract');
  const current = (await listLocalSubscriptions(options))[0];
  assert.equal(current.lastObservedSha, hash(revision));
  assert.equal(current.lastError, 'invalid-contract');
  assert.equal((await listMaintenanceJobs(options)).length, 1);
  await writeFile(options.sourcePath, revision);
  const recovered = await observeOnce(options);
  assert.equal(recovered.results[0].created, false);
  assert.equal((await listLocalSubscriptions(options))[0].lastError, null);
});

test('bounded captured bytes preserve a UTF-8 BOM across persistence and comparison', async t => {
  const { options, base, revision } = await fixture(t, true);
  const subscription = await registerLocalSubscription(options);
  assert.equal(subscription.configuredBaselineSha, hash(base));
  await writeFile(options.sourcePath, revision);
  const result = await observeOnce(options);
  assert.equal(result.results[0].created, true);
  const job = (await listMaintenanceJobs(options))[0];
  assert.equal(job.report.comparison.base.sha256, hash(base));
});

test('consumer metadata failures are distinguished from provider contract failures and recover on the same revision', async t => {
  const { options, revision } = await fixture(t);
  await registerLocalSubscription(options);
  await writeFile(options.sourcePath, revision);
  const original = await observeOnce(options);
  const manifest = join(options.consumerRoot, 'package.json');
  await writeFile(manifest, JSON.stringify({ scripts: { test: null } }));
  const failure = await observeOnce(options);
  assert.equal(failure.results[0].reason, 'consumer-unavailable');
  assert.equal((await listLocalSubscriptions(options))[0].lastObservedSha, hash(revision));
  assert.equal((await listMaintenanceJobs(options))[0].id, original.results[0].jobId);
  await writeFile(manifest, JSON.stringify({ scripts: { test: "node --test" } }));
  const recovered = await observeOnce(options);
  assert.equal(recovered.results[0].created, true);
  assert.equal((await listLocalSubscriptions(options))[0].lastError, null);
});

test('an active lease reports busy without executing and a fresh owner can resume after release', async t => {
  const { options } = await fixture(t);
  const subscription = await registerLocalSubscription(options);
  const store = await openWorkerStore(options.statePath);
  try {
    const lease = store.claim(subscription.id);
    const busy = await observeOnce({ ...options, enginePath: 'must-not-run' });
    assert.equal(busy.results[0].status, 'busy');
    store.failObservation({ lease, reason: 'analysis-failed' });
  } finally { store.close(); }
  assert.equal((await observeOnce(options)).results[0].status, 'observed');
});

test('invalid state locations and unknown subscriptions do not silently create a working observer', async t => {
  const { options } = await fixture(t);
  await assert.rejects(registerLocalSubscription({ ...options, statePath: join(options.consumerRoot, 'state') }), { code: 'INVALID_INPUT' });
  await assert.rejects(readdir(join(options.consumerRoot, 'state')), { code: 'ENOENT' });
  await assert.rejects(observeOnce(options), { code: 'INVALID_INPUT' });
  await assert.rejects(readdir(options.statePath), { code: 'ENOENT' });
  await registerLocalSubscription(options);
  await assert.rejects(observeOnce({ ...options, subscriptionId: 'f'.repeat(64) }), { code: 'INVALID_INPUT' });
});
