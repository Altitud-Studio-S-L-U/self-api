import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { issueApproval, consumeApproval } from '../dist/approval-store.js';

const work = resolve('work/test-approval-store');
await mkdir(work, { recursive: true });
const parent = await realpath(work);
const owned = await mkdtemp(join(parent, 'approval-'));
let counter = 0;
const invalidInput = { name: 'PlumberError', code: 'INVALID_INPUT' };
const ttl = 15 * 60 * 1000;

after(async () => {
  const target = await realpath(owned);
  assert.equal(dirname(target), parent);
  assert.ok(basename(target).startsWith('approval-'));
  await rm(target, { recursive: true, force: false });
});

async function fixture() {
  const base = join(owned, `case-${counter++}`);
  const consumerRoot = join(base, 'consumer');
  const statePath = join(base, 'state');
  await mkdir(consumerRoot, { recursive: true });
  return { statePath, consumerRoot, planId: 'a'.repeat(64), executionDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64), origin: 'explicit-sdk-caller' };
}

function consumeOptions(options, receipt) {
  const { origin: _origin, ...bindings } = options;
  return { ...bindings, receiptId: receipt.id };
}

async function replaceReceipt(options, receipt) {
  await writeFile(join(options.statePath, 'receipts', `${receipt.id}.json`), JSON.stringify(receipt));
}

test('issues a bounded local receipt and consumes it exactly once', async () => {
  const options = await fixture();
  const before = Date.now();
  const receipt = await issueApproval(options);
  assert.equal(receipt.schemaVersion, 1);
  assert.match(receipt.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(receipt.consumerRootId, /^[0-9a-f]{64}$/);
  assert.match(receipt.stateRootId, /^[0-9a-f]{64}$/);
  assert.equal(receipt.planId, options.planId);
  assert.equal(receipt.executionDigest, options.executionDigest);
  assert.equal(receipt.policyDigest, options.policyDigest);
  assert.equal(receipt.origin, options.origin);
  assert.ok(Date.parse(receipt.issuedAt) >= before && Date.parse(receipt.issuedAt) <= Date.now());
  assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt), ttl);
  assert.deepEqual(JSON.parse(await readFile(join(options.statePath, 'receipts', `${receipt.id}.json`), 'utf8')), receipt);
  const consumed = await consumeApproval(consumeOptions(options, receipt));
  assert.deepEqual(consumed.receipt, receipt);
  assert.equal(consumed.attemptPath, join(await realpath(options.statePath), 'attempts', receipt.id));
  await access(join(consumed.attemptPath, 'marker.json'));
  await assert.rejects(consumeApproval(consumeOptions(options, receipt)), invalidInput);
});

test('concurrent consumers admit one attempt and preserve consumption after downstream failure', async () => {
  const options = await fixture();
  const receipt = await issueApproval(options);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeApproval(consumeOptions(options, receipt))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'INVALID_INPUT'));
  // An executor may fail after admission; the store must never clear that claim for it.
  await writeFile(join(options.statePath, 'attempts', receipt.id, 'executor-failed.txt'), 'controlled fixture failure');
  await assert.rejects(consumeApproval(consumeOptions(options, receipt)), invalidInput);
});

test('rejects changed evidence without consuming an otherwise valid receipt', async () => {
  const options = await fixture();
  const receipt = await issueApproval(options);
  for (const key of ['planId', 'executionDigest', 'policyDigest']) {
    await assert.rejects(consumeApproval({ ...consumeOptions(options, receipt), [key]: 'd'.repeat(64) }), invalidInput);
  }
  const otherRoot = join(dirname(options.consumerRoot), 'other-consumer');
  await mkdir(otherRoot);
  await assert.rejects(consumeApproval({ ...consumeOptions(options, receipt), consumerRoot: otherRoot }), invalidInput);
  await assert.rejects(access(join(options.statePath, 'attempts', receipt.id)), { code: 'ENOENT' });
  await consumeApproval(consumeOptions(options, receipt));
});

test('rejects a receipt copied to another state directory', async () => {
  const first = await fixture();
  const receipt = await issueApproval(first);
  const second = await fixture();
  await issueApproval(second);
  await replaceReceipt(second, receipt);
  await assert.rejects(consumeApproval({ ...consumeOptions(first, receipt), statePath: second.statePath }), invalidInput);
});

test('rejects expired, future-dated and extended receipts using the actual clock', async () => {
  for (const kind of ['expired', 'future', 'extended']) {
    const options = await fixture();
    const receipt = await issueApproval(options);
    const issueTime = Date.now() + (kind === 'future' ? ttl : -2 * ttl);
    const changed = { ...receipt, issuedAt: new Date(issueTime).toISOString(), expiresAt: new Date(issueTime + (kind === 'extended' ? 4 * ttl : ttl)).toISOString() };
    await replaceReceipt(options, changed);
    await assert.rejects(consumeApproval({ ...consumeOptions(options, receipt), now: new Date(issueTime + 1) }), invalidInput);
    await assert.rejects(access(join(options.statePath, 'attempts', receipt.id)), { code: 'ENOENT' });
  }
});

test('rejects malformed or unknown receipt fields and oversized JSON', async () => {
  for (const change of [
    receipt => ({ ...receipt, unexpected: 'value' }),
    receipt => ({ ...receipt, schemaVersion: 2 }),
    receipt => ({ ...receipt, origin: 'automatic-agent' }),
    receipt => ({ ...receipt, origin: ['local-cli'] }),
    receipt => ({ ...receipt, issuedAt: 'not-a-date' }),
    receipt => ({ ...receipt, expiresAt: 0 }),
    receipt => ({ ...receipt, planId: 'malformed' }),
    receipt => ({ ...receipt, id: '00000000-0000-4000-8000-000000000000' }),
    () => null,
  ]) {
    const options = await fixture();
    const receipt = await issueApproval(options);
    await writeFile(join(options.statePath, 'receipts', `${receipt.id}.json`), JSON.stringify(change(receipt)));
    await assert.rejects(consumeApproval(consumeOptions(options, receipt)), invalidInput);
  }
  for (const contents of ['{ malformed', ' '.repeat(16 * 1024), Buffer.from([0xff])]) {
    const options = await fixture();
    const receipt = await issueApproval(options);
    await writeFile(join(options.statePath, 'receipts', `${receipt.id}.json`), contents);
    await assert.rejects(consumeApproval(consumeOptions(options, receipt)), invalidInput);
  }
});

test('rejects path-shaped receipt IDs and malformed binding digests before creating attempts', async () => {
  const options = await fixture();
  const receipt = await issueApproval(options);
  for (const receiptId of ['../escape', receipt.id + '/other', receipt.id + ':stream', '', receipt.id.toUpperCase()]) {
    await assert.rejects(consumeApproval({ ...consumeOptions(options, receipt), receiptId }), invalidInput);
  }
  for (const key of ['planId', 'executionDigest', 'policyDigest']) {
    await assert.rejects(issueApproval({ ...options, [key]: 'not-a-hash' }), invalidInput);
  }
  await assert.rejects(issueApproval({ ...options, origin: 'agent' }), invalidInput);
});

test('state cannot equal, contain, or live inside the consumer checkout', async () => {
  const options = await fixture();
  for (const statePath of [options.consumerRoot, join(options.consumerRoot, 'state'), dirname(options.consumerRoot)]) {
    await assert.rejects(issueApproval({ ...options, statePath }), invalidInput);
  }
  await assert.rejects(access(join(options.consumerRoot, 'state')), { code: 'ENOENT' });
});

test('rejects symlinked state or consumer roots and their ancestors', async () => {
  const options = await fixture();
  const base = dirname(options.consumerRoot);
  const target = join(base, 'target');
  const link = join(base, 'linked');
  await mkdir(target);
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(issueApproval({ ...options, statePath: link }), invalidInput);
  await assert.rejects(issueApproval({ ...options, statePath: join(link, 'state') }), invalidInput);
  await assert.rejects(issueApproval({ ...options, consumerRoot: link }), invalidInput);
  await mkdir(join(target, 'consumer'));
  await assert.rejects(issueApproval({ ...options, consumerRoot: join(link, 'consumer') }), invalidInput);
});

test('rejects linked receipt directories and linked attempt directories', async () => {
  for (const name of ['receipts', 'attempts']) {
    const options = await fixture();
    await mkdir(options.statePath, { mode: 0o700 });
    const target = join(dirname(options.statePath), 'linked-target');
    await mkdir(target);
    await symlink(target, join(options.statePath, name), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(issueApproval(options), invalidInput);
  }
  const options = await fixture();
  const receipt = await issueApproval(options);
  const target = join(dirname(options.statePath), 'attempt-target');
  await mkdir(target);
  await symlink(target, join(options.statePath, 'attempts', receipt.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(consumeApproval(consumeOptions(options, receipt)), invalidInput);
});

test('storage failures fail closed without exposing paths in errors', async () => {
  const options = await fixture();
  await mkdir(options.statePath, { mode: 0o700 });
  await writeFile(join(options.statePath, 'receipts'), 'not a directory');
  await assert.rejects(issueApproval(options), error => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.equal(error.message.includes(options.statePath), false);
    return true;
  });
  for (const statePath of ['', '-', 'https://example.invalid/state', 'state:stream', '//server/share/state', 'NUL']) {
    await assert.rejects(issueApproval({ ...options, statePath }), invalidInput);
  }
});

test('creates private files and directories with ordinary POSIX modes where available', async () => {
  const options = await fixture();
  const receipt = await issueApproval(options);
  const result = await consumeApproval(consumeOptions(options, receipt));
  if (process.platform !== 'win32') {
    for (const path of [options.statePath, join(options.statePath, 'receipts'), join(options.statePath, 'attempts'), result.attemptPath]) {
      assert.equal((await stat(path)).mode & 0o777, 0o700);
    }
    for (const path of [join(options.statePath, 'receipts', `${receipt.id}.json`), join(result.attemptPath, 'marker.json')]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  }
});
