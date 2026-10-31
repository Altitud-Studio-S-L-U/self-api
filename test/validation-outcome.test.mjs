import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { issueApproval, consumeApproval } from '../dist/approval-store.js';
import { persistValidationOutcome, readValidationOutcome, validateValidationOutcome } from '../dist/validation-outcome.js';

const work = resolve('work/test-validation-outcome');
await mkdir(work, { recursive: true });
const parent = await realpath(work);
const owned = await mkdtemp(join(parent, 'outcome-'));
const invalid = { name: 'PlumberError', code: 'INVALID_INPUT' };
const secret = 'PRIVATE consumer/source.js token=fixture-only';
let counter = 0;

after(async () => {
  const target = await realpath(owned);
  assert.equal(dirname(target), parent);
  assert.ok(basename(target).startsWith('outcome-'));
  await rm(target, { recursive: true, force: false });
});

function phase(status) {
  return { status, exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    cleanup: status === 'cleanup-failed' ? 'failed' : status === 'blocked' ? 'not-created' : 'removed',
    ...(status !== 'blocked' ? { containerName: `self-managed-api-validation-${randomUUID()}` } : {}),
    stdout: secret, stderr: `${secret} stderr`, reason: secret };
}

function summaryPhase({ status, exitCode, cleanup, containerName }) {
  return { status, exitCode, cleanup, ...(containerName ? { containerName } : {}) };
}

function result(receiptId, baselineStatus = 'failed', candidateStatus = 'passed') {
  const baseline = phase(baselineStatus);
  const candidate = candidateStatus === null ? undefined : phase(candidateStatus);
  const complete = status => status === 'passed' || status === 'failed';
  const status = complete(baselineStatus) && complete(candidateStatus)
    ? candidateStatus === 'passed' ? (baselineStatus === 'passed' ? 'passed' : 'improved')
      : baselineStatus === 'passed' ? 'regression' : 'failed'
    : 'blocked';
  return { schemaVersion: 1, requestId: 'd'.repeat(64), receiptId, status, baseline,
    ...(candidate ? { candidate } : {}), consumerModified: false, publication: 'not-authorized' };
}

function summary(full, intentId = null) {
  return { ...full, intentId, baseline: summaryPhase(full.baseline),
    ...(full.candidate ? { candidate: summaryPhase(full.candidate) } : {}) };
}

async function fixture() {
  const base = join(owned, `case-${counter++}`);
  const consumerRoot = join(base, 'consumer');
  await mkdir(consumerRoot, { recursive: true });
  const options = { statePath: join(base, 'state'), consumerRoot,
    planId: 'a'.repeat(64), executionDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) };
  const receipt = await issueApproval({ ...options, origin: 'explicit-sdk-caller' });
  const { attemptPath } = await consumeApproval({ ...options, receiptId: receipt.id });
  const full = result(receipt.id);
  const expected = { attemptPath, intentId: 'e'.repeat(64), requestId: full.requestId, receiptId: receipt.id };
  return { attemptPath, full, expected, receipt };
}

test('stores full local evidence followed by a private allowlisted summary and reads it bound to the caller', async () => {
  const { attemptPath, full, expected } = await fixture();
  const snapshot = structuredClone(full);
  const outcome = await persistValidationOutcome({ attemptPath, result: full, intentId: expected.intentId });
  assert.deepEqual(full, snapshot);
  assert.deepEqual(outcome, summary(full, expected.intentId));
  assert.deepEqual(await readValidationOutcome(expected), outcome);
  const persisted = await readFile(join(attemptPath, 'outcome.json'), 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('stdout'), false);
  assert.equal(persisted.includes('stderr'), false);
  assert.equal(persisted.includes('reason'), false);
  assert.deepEqual(JSON.parse(await readFile(join(attemptPath, 'result.json'), 'utf8')), full);
  if (process.platform !== 'win32') {
    for (const filename of ['result.json', 'outcome.json']) {
      assert.equal((await stat(join(attemptPath, filename))).mode & 0o777, 0o600);
    }
  }
});

test('standalone execution records a null intent without broadening publication authorization', async () => {
  const { attemptPath, full, expected } = await fixture();
  const outcome = await persistValidationOutcome({ attemptPath, result: full });
  assert.equal(outcome.intentId, null);
  assert.equal(outcome.consumerModified, false);
  assert.equal(outcome.publication, 'not-authorized');
  assert.deepEqual(await readValidationOutcome({ ...expected, intentId: null }), outcome);
});

test('derives all completed statuses from both phases, and preserves incomplete results as blocked', () => {
  const receiptId = randomUUID();
  for (const [baseline, candidate, status] of [
    ['passed', 'passed', 'passed'], ['failed', 'passed', 'improved'],
    ['passed', 'failed', 'regression'], ['failed', 'failed', 'failed'],
    ['blocked', null, 'blocked'], ['timed-out', null, 'blocked'],
    ['output-limit', null, 'blocked'], ['cleanup-failed', null, 'blocked'],
    ['passed', 'blocked', 'blocked'], ['failed', 'cleanup-failed', 'blocked'], ['passed', null, 'blocked'],
  ]) assert.equal(validateValidationOutcome(summary(result(receiptId, baseline, candidate))).status, status);
});

test('rejects fabricated completion, inconsistent cleanup, malformed statuses and unknown fields', () => {
  const valid = summary(result(randomUUID()));
  for (const change of [
    data => { data.status = 'passed'; },
    data => { data.status = 'blocked'; },
    data => { data.baseline.exitCode = 0; },
    data => { data.candidate.exitCode = 1; },
    data => { data.candidate.cleanup = 'failed'; },
    data => { data.candidate.cleanup = 'not-created'; },
    data => { data.baseline.status = 'unknown'; },
    data => { data.baseline.exitCode = '1'; },
    data => { data.baseline.exitCode = -1; },
    data => { data.baseline.exitCode = 256; },
    data => { data.baseline.exitCode = 1.5; },
    data => { data.baseline.cleanup = 'pending'; },
    data => { data.baseline.containerName = secret; },
    data => { data.baseline.containerName = `plumber-validation-${randomUUID()}`; },
    data => { data.baseline.containerName = `self-managed-api-validation-foreign-${randomUUID()}`; },
    data => { data.baseline.stdout = secret; },
    data => { data.secret = secret; },
    data => { data.consumerModified = true; },
    data => { data.publication = 'authorized'; },
    data => { data.schemaVersion = 2; },
    data => { data.intentId = 'malformed'; },
    data => { data.requestId = 'D'.repeat(64); },
    data => { data.receiptId = '../receipt'; },
    data => { delete data.intentId; },
  ]) {
    const changed = structuredClone(valid);
    change(changed);
    assert.throws(() => validateValidationOutcome(changed), invalid);
  }
  const incomplete = summary(result(randomUUID(), 'blocked', null));
  assert.throws(() => validateValidationOutcome({ ...incomplete, candidate: valid.candidate }), invalid);
  assert.throws(() => validateValidationOutcome({ ...incomplete,
    baseline: { ...incomplete.baseline, containerName: valid.candidate.containerName } }), invalid);
  assert.throws(() => validateValidationOutcome({ ...incomplete,
    baseline: { ...incomplete.baseline, status: 'cleanup-failed' } }), invalid);
});

test('validator rejects executable object fields without invoking them', () => {
  const valid = summary(result(randomUUID()));
  let invoked = false;
  Object.defineProperty(valid, 'requestId', { get() { invoked = true; throw new Error(secret); }, enumerable: true });
  assert.throws(() => validateValidationOutcome(valid), invalid);
  assert.equal(invoked, false);
  assert.throws(() => validateValidationOutcome(new Proxy({}, { ownKeys() { throw new Error(secret); } })), invalid);
  assert.throws(() => validateValidationOutcome({ ...summary(result(randomUUID())), [Symbol('extra')]: true }), invalid);
});

test('missing outcome is incomplete even with a truncated full result, but missing marker is invalid', async () => {
  const { attemptPath, expected } = await fixture();
  assert.equal(await readValidationOutcome(expected), null);
  await writeFile(join(attemptPath, 'result.json'), '{partial');
  assert.equal(await readValidationOutcome(expected), null);
  const noMarker = join(dirname(attemptPath), randomUUID());
  await mkdir(noMarker);
  await assert.rejects(readValidationOutcome({ ...expected, attemptPath: noMarker }), invalid);
  await assert.rejects(readValidationOutcome({ ...expected, attemptPath: join(noMarker, 'absent') }), invalid);
});

test('existing outcome requires its complete matching full result artifact', async () => {
  for (const fullContents of [undefined, '{partial', 'null', Buffer.from([0xff])]) {
    const { attemptPath, full, expected } = await fixture();
    await writeFile(join(attemptPath, 'outcome.json'), JSON.stringify(summary(full, expected.intentId)));
    if (fullContents !== undefined) await writeFile(join(attemptPath, 'result.json'), fullContents);
    await assert.rejects(readValidationOutcome(expected), invalid);
  }
  for (const change of [
    data => { data.requestId = 'f'.repeat(64); },
    data => { data.receiptId = randomUUID(); },
    data => { data.status = 'passed'; data.baseline = phase('passed'); },
  ]) {
    const { attemptPath, full, expected } = await fixture();
    await persistValidationOutcome({ attemptPath, result: full, intentId: expected.intentId });
    const conflicting = structuredClone(full);
    change(conflicting);
    await writeFile(join(attemptPath, 'result.json'), JSON.stringify(conflicting));
    await assert.rejects(readValidationOutcome(expected), invalid);
  }
});

test('reopening rejects changed bindings and does not consume, overwrite, or infer authorization', async () => {
  const { attemptPath, full, expected } = await fixture();
  const outcome = await persistValidationOutcome({ attemptPath, result: full, intentId: expected.intentId });
  for (const change of [{ requestId: 'f'.repeat(64) }, { receiptId: randomUUID() }, { intentId: 'f'.repeat(64) }, { intentId: null }]) {
    await assert.rejects(readValidationOutcome({ ...expected, ...change }), invalid);
  }
  const before = await readFile(join(attemptPath, 'result.json'));
  await assert.rejects(persistValidationOutcome({ attemptPath, result: full, intentId: expected.intentId }), invalid);
  assert.deepEqual(await readFile(join(attemptPath, 'result.json')), before);
  assert.deepEqual(await readValidationOutcome(expected), outcome);
});

test('validates marker identity before any result is persisted', async () => {
  for (const change of [
    marker => { marker.receiptId = randomUUID(); },
    marker => { marker.schemaVersion = 2; },
    marker => { marker.executionDigest = 'malformed'; },
    marker => { marker.consumedAt = 'not-a-date'; },
  ]) {
    const { attemptPath, full } = await fixture();
    const path = join(attemptPath, 'marker.json');
    const marker = JSON.parse(await readFile(path, 'utf8'));
    change(marker);
    await writeFile(path, JSON.stringify(marker));
    await assert.rejects(persistValidationOutcome({ attemptPath, result: full }), invalid);
    await assert.rejects(stat(join(attemptPath, 'result.json')), { code: 'ENOENT' });
  }
});

test('rejects raw artifact tampering and byte excess instead of returning null', async () => {
  for (const contents of ['{', 'null', Buffer.from([0xff]), ' '.repeat(16 * 1024 + 1)]) {
    const { attemptPath, full, expected } = await fixture();
    await persistValidationOutcome({ attemptPath, result: full, intentId: expected.intentId });
    await writeFile(join(attemptPath, 'outcome.json'), contents);
    await assert.rejects(readValidationOutcome(expected), invalid);
  }
  const { attemptPath, full, expected } = await fixture();
  full.baseline.stdout = 'x'.repeat(16 * 1024 * 1024);
  await assert.rejects(persistValidationOutcome({ attemptPath, result: full }), invalid);
  await assert.rejects(stat(join(attemptPath, 'result.json')), { code: 'ENOENT' });
  full.baseline.stdout = secret;
  await persistValidationOutcome({ attemptPath, result: full, intentId: expected.intentId });
  await writeFile(join(attemptPath, 'result.json'), ' '.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(readValidationOutcome(expected), invalid);
});

test('rejects nonregular artifacts and linked storage without leaking storage paths', async () => {
  const { attemptPath, full, expected } = await fixture();
  const linked = join(dirname(attemptPath), `linked-${randomUUID()}`);
  await symlink(attemptPath, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(persistValidationOutcome({ attemptPath: linked, result: full }), invalid);
  await assert.rejects(readValidationOutcome({ ...expected, attemptPath: linked }), invalid);
  await mkdir(join(attemptPath, 'outcome.json'));
  await assert.rejects(readValidationOutcome(expected), error => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.equal(error.message.includes(attemptPath), false);
    return true;
  });
});

test('rejects unknown full result fields before creating any artifact', async () => {
  const { attemptPath, full } = await fixture();
  for (const changed of [
    { ...full, unexpected: true },
    { ...full, baseline: { ...full.baseline, sourcePath: secret } },
    { ...full, baseline: { ...full.baseline, stdout: 42 } },
  ]) await assert.rejects(persistValidationOutcome({ attemptPath, result: changed }), invalid);
  await assert.rejects(stat(join(attemptPath, 'result.json')), { code: 'ENOENT' });
});
