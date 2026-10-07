import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerLocalSubscription, observeOnce } from '../dist/worker.js';
import { openWorkerStore } from '../dist/worker-store.js';
import { consumeApproval, inspectApproval } from '../dist/approval-store.js';
import { persistValidationOutcome } from '../dist/validation-outcome.js';
import { approveJobValidation, listJobExecutions, prepareJobValidation, queueJobValidation, recoverApprovedJobs, runApprovedJobsOnce } from '../dist/job-validation.js';

const root = resolve(import.meta.dirname, '..');
const work = join(root, 'work/test-job-validation');
const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');

async function fixture(t) {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const consumerRoot = join(directory, 'consumer');
  await cp(join(root, 'fixtures/validation-consumer'), consumerRoot, { recursive: true });
  const sourcePath = join(directory, 'provider.json');
  await cp(join(root, 'fixtures/orders-v2.json'), sourcePath);
  const statePath = join(directory, 'state');
  await registerLocalSubscription({ statePath, sourcePath, baselinePath: join(root, 'fixtures/orders-v1.json'),
    consumerRoot, enginePath, providerBaseUrl: 'https://orders.example.invalid' });
  const jobId = (await observeOnce({ statePath, enginePath })).results[0].jobId;
  assert.ok(jobId);
  const recipe = JSON.parse(await readFile(join(root, 'fixtures/validation-recipe.json'), 'utf8'));
  const input = { statePath, jobId, enginePath, recipe, testPaths: ['orders.test.mjs'] };
  return { input, consumerRoot, sourcePath };
}

async function approved(input) {
  const request = await prepareJobValidation(input);
  const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
  return { request, receipt, intent: queued.intent };
}

function bindings(context, value) {
  return { statePath: context.input.statePath, consumerRoot: context.consumerRoot, receiptId: value.receipt.id,
    planId: value.request.plan.id, executionDigest: value.request.executionDigest, policyDigest: value.request.policyDigest };
}

async function claimAndExpire(input, intent) {
  const store = await openWorkerStore(input.statePath);
  try { assert.equal(store.claimExecution(intent.id).intent.id, intent.id); }
  finally { store.close(); }
  const db = new DatabaseSync(join(input.statePath, 'worker.sqlite3'));
  try { db.prepare('UPDATE execution_intents SET expires_at=? WHERE id=?').run(Date.now() - 1000, intent.id); }
  finally { db.close(); }
}

function blockedResult(request, receipt) {
  return { schemaVersion: 1, requestId: request.id, receiptId: receipt.id, status: 'blocked',
    baseline: { status: 'blocked', exitCode: null, cleanup: 'not-created', stdout: '', stderr: '', reason: 'Controlled unavailable runtime' },
    consumerModified: false, publication: 'not-authorized' };
}

test('a job review, explicit approval and idempotent queue remain separate from execution', async t => {
  const context = await fixture(t);
  const { input } = context;
  const original = await readFile(join(context.consumerRoot, 'orders.mjs'), 'utf8');
  const request = await prepareJobValidation(input);
  await assert.rejects(approveJobValidation({ ...input, expectedRequestId: 'f'.repeat(64), origin: 'explicit-sdk-caller' }), /review the current/);
  assert.deepEqual(await readdir(input.statePath), ['worker.sqlite3']);
  const value = await approved(input);
  const repeated = await queueJobValidation({ ...input, receiptId: value.receipt.id });
  assert.equal(repeated.created, false);
  assert.equal(repeated.intent.id, value.intent.id);
  assert.equal(repeated.intent.requestId, request.id);
  assert.equal(repeated.intent.status, 'queued');
  assert.deepEqual(await readdir(join(input.statePath, 'attempts')), []);
  assert.equal((await listJobExecutions(input)).length, 1);
  await inspectApproval(bindings(context, value));
  assert.equal(await readFile(join(context.consumerRoot, 'orders.mjs'), 'utf8'), original);
});

test('provider rollback invalidates queued evidence before consuming approval', async t => {
  const context = await fixture(t);
  const value = await approved(context.input);
  await cp(join(root, 'fixtures/orders-v1.json'), context.sourcePath);
  await assert.rejects(queueJobValidation({ ...context.input, receiptId: value.receipt.id }), /no longer matches/);
  const cycle = await runApprovedJobsOnce(context.input);
  assert.equal(cycle.results[0].status, 'blocked');
  assert.equal(cycle.results[0].reason, 'stale-evidence');
  await inspectApproval(bindings(context, value));
  assert.deepEqual(await readdir(join(context.input.statePath, 'attempts')), []);
});

test('human source or test changes block a queued migration and are preserved', async t => {
  const context = await fixture(t);
  const value = await approved(context.input);
  const path = join(context.consumerRoot, 'orders.test.mjs');
  const changed = `${await readFile(path, 'utf8')}\n// human edit after approval\n`;
  await writeFile(path, changed);
  const cycle = await runApprovedJobsOnce(context.input);
  assert.equal(cycle.results[0].reason, 'stale-evidence');
  assert.equal(await readFile(path, 'utf8'), changed);
  await inspectApproval(bindings(context, value));
  assert.deepEqual((await runApprovedJobsOnce(context.input)).results, []);
});

test('approval expiry while queued does not create an attempt or authorize a retry', async t => {
  const context = await fixture(t);
  const value = await approved(context.input);
  const expired = { ...value.receipt, issuedAt: new Date(Date.now() - 31 * 60_000).toISOString(), expiresAt: new Date(Date.now() - 16 * 60_000).toISOString() };
  // Preserve the exact validity interval while placing it entirely in the past.
  expired.expiresAt = new Date(Date.parse(expired.issuedAt) + 15 * 60_000).toISOString();
  await writeFile(join(context.input.statePath, 'receipts', `${value.receipt.id}.json`), JSON.stringify(expired));
  const cycle = await runApprovedJobsOnce(context.input);
  assert.equal(cycle.results[0].status, 'blocked');
  assert.equal(cycle.results[0].reason, 'approval-invalid');
  assert.deepEqual(await readdir(join(context.input.statePath, 'attempts')), []);
});

test('a receipt already consumed by another caller is recovered without running it again', async t => {
  const context = await fixture(t);
  const value = await approved(context.input);
  await consumeApproval(bindings(context, value));
  const cycle = await runApprovedJobsOnce(context.input);
  assert.equal(cycle.results[0].status, 'interrupted');
  const recovery = await recoverApprovedJobs(context.input);
  assert.equal(recovery.results[0].reason, 'execution-interrupted');
  assert.deepEqual((await runApprovedJobsOnce(context.input)).results, []);
  await assert.rejects(inspectApproval(bindings(context, value)), /already has an execution attempt/);
});

test('recovery reconciles a durable result after a process dies before its database commit', async t => {
  const context = await fixture(t);
  const value = await approved(context.input);
  await claimAndExpire(context.input, value.intent);
  const { attemptPath } = await consumeApproval(bindings(context, value));
  const outcome = await persistValidationOutcome({ attemptPath, intentId: value.intent.id, result: blockedResult(value.request, value.receipt) });
  await rm(context.sourcePath);
  const recovery = await recoverApprovedJobs(context.input);
  assert.equal(recovery.results[0].status, 'completed');
  assert.deepEqual(recovery.results[0].outcome, outcome);
  assert.deepEqual((await listJobExecutions(context.input))[0].outcome, outcome);
  assert.deepEqual((await runApprovedJobsOnce({ ...context.input, enginePath: 'must-not-run' })).results, []);
});

test('a crash after claiming but before consumption is interrupted without creating an attempt', async t => {
  const context = await fixture(t);
  const value = await approved(context.input);
  await claimAndExpire(context.input, value.intent);
  const recovery = await recoverApprovedJobs(context.input);
  assert.equal(recovery.results[0].reason, 'execution-interrupted');
  assert.deepEqual(await readdir(join(context.input.statePath, 'attempts')), []);
  assert.deepEqual((await runApprovedJobsOnce(context.input)).results, []);
  await inspectApproval(bindings(context, value));
});

test('an outcome without its full result is rejected and never establishes validation success', async t => {
  const context = await fixture(t);
  const value = await approved(context.input);
  await claimAndExpire(context.input, value.intent);
  const { attemptPath } = await consumeApproval(bindings(context, value));
  await persistValidationOutcome({ attemptPath, intentId: value.intent.id, result: blockedResult(value.request, value.receipt) });
  await rm(join(attemptPath, 'result.json'));
  const recovery = await recoverApprovedJobs(context.input);
  assert.equal(recovery.results[0].status, 'interrupted');
  assert.equal(recovery.results[0].reason, 'invalid-outcome');
  assert.equal((await listJobExecutions(context.input))[0].outcome, null);
});

test('recovery can reconcile a late durable outcome after an earlier interrupted classification', async t => {
  const context = await fixture(t);
  const value = await approved(context.input);
  await claimAndExpire(context.input, value.intent);
  const { attemptPath } = await consumeApproval(bindings(context, value));
  assert.equal((await recoverApprovedJobs(context.input)).results[0].reason, 'execution-interrupted');
  const outcome = await persistValidationOutcome({ attemptPath, intentId: value.intent.id, result: blockedResult(value.request, value.receipt) });
  const recovered = await recoverApprovedJobs(context.input);
  assert.deepEqual(recovered.results[0].outcome, outcome);
  assert.equal(recovered.results[0].status, 'completed');
  assert.deepEqual((await runApprovedJobsOnce(context.input)).results, []);
});

test('recovery rotates past unresolved cleanup so another expired intent can progress', async t => {
  const context = await fixture(t);
  const oldest = await approved(context.input);
  const next = await approved(context.input);
  const { attemptPath } = await consumeApproval(bindings(context, oldest));
  await writeFile(join(attemptPath, 'marker.json'), '{');
  const store = await openWorkerStore(context.input.statePath);
  try {
    const claim = store.claimExecution(oldest.intent.id);
    store.interruptExecution({ claim, reason: 'cleanup-unresolved' });
  } finally { store.close(); }
  await claimAndExpire(context.input, next.intent);
  const db = new DatabaseSync(join(context.input.statePath, 'worker.sqlite3'));
  try {
    const past = Date.now() - 10_000;
    const timestamp = db.prepare('UPDATE execution_intents SET created_at=?,updated_at=? WHERE id=?');
    timestamp.run(past - 1000, past - 1000, oldest.intent.id);
    timestamp.run(past, past, next.intent.id);
  } finally { db.close(); }

  const first = await recoverApprovedJobs(context.input);
  assert.deepEqual(first.results, [{ intentId: oldest.intent.id, status: 'interrupted', reason: 'cleanup-unresolved' }]);
  const second = await recoverApprovedJobs(context.input);
  assert.deepEqual(second.results, [{ intentId: next.intent.id, status: 'interrupted', reason: 'execution-interrupted' }]);
  const intents = await listJobExecutions(context.input);
  assert.equal(intents.find(intent => intent.id === oldest.intent.id).reason, 'cleanup-unresolved');
  assert.equal(intents.find(intent => intent.id === next.intent.id).reason, 'execution-interrupted');
  assert.deepEqual(await readdir(join(context.input.statePath, 'attempts')), [oldest.receipt.id]);
  await inspectApproval(bindings(context, next));
  assert.deepEqual((await runApprovedJobsOnce(context.input)).results, []);
});

test('job passes reject unbounded work before accessing storage', async () => {
  for (const limit of [0, 11, -1, NaN, 1.5]) {
    await assert.rejects(runApprovedJobsOnce({ statePath: 'must-not-create', enginePath: 'must-not-run', limit }), /between 1 and 10/);
    await assert.rejects(recoverApprovedJobs({ statePath: 'must-not-create', limit }), /between 1 and 10/);
  }
});
