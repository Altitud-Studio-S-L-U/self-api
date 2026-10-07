import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { issueApproval, inspectApproval, consumeApproval } from '../dist/approval-store.js';

const work = resolve('work/test-approval-inspection');
await mkdir(work, { recursive: true });
const parent = await realpath(work);
const owned = await mkdtemp(join(parent, 'inspection-'));
let counter = 0;
const invalid = { name: 'PlumberError', code: 'INVALID_INPUT' };

after(async () => {
  const target = await realpath(owned);
  assert.equal(dirname(target), parent);
  assert.ok(basename(target).startsWith('inspection-'));
  await rm(target, { recursive: true, force: false });
});

async function fixture() {
  const path = join(owned, `case-${counter++}`);
  const consumerRoot = join(path, 'consumer');
  await mkdir(consumerRoot, { recursive: true });
  const binding = { statePath: join(path, 'state'), consumerRoot,
    planId: 'a'.repeat(64), executionDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) };
  const receipt = await issueApproval({ ...binding, origin: 'explicit-sdk-caller' });
  return { options: { ...binding, receiptId: receipt.id }, receipt,
    file: join(binding.statePath, 'receipts', `${receipt.id}.json`),
    attempt: join(binding.statePath, 'attempts', receipt.id) };
}

test('inspection preserves stored bytes and leaves consumption available', async () => {
  const { options, receipt, file } = await fixture();
  const before = await readFile(file);
  for (let index = 0; index < 3; index++) assert.deepEqual(await inspectApproval(options), receipt);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(join(options.statePath, 'attempts')), []);
  assert.deepEqual((await consumeApproval(options)).receipt, receipt);
  await assert.rejects(inspectApproval(options), /already has an execution attempt/);
});

test('inspection rejects every existing attempt, including an empty or incomplete claim', async () => {
  for (const kind of ['empty', 'incomplete-marker', 'file', 'junction']) {
    const { options, attempt } = await fixture();
    if (kind === 'file') await writeFile(attempt, 'incomplete');
    else if (kind === 'junction') {
      const target = join(dirname(options.statePath), 'linked-attempt');
      await mkdir(target);
      await symlink(target, attempt, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await mkdir(attempt);
      if (kind === 'incomplete-marker') await writeFile(join(attempt, 'marker.json'), '{');
    }
    await assert.rejects(inspectApproval(options), /already has an execution attempt/);
    await assert.rejects(consumeApproval(options), /already has an execution attempt/);
  }
});

test('inspection rechecks all bindings and rejects a different root or copied state', async () => {
  const { options, receipt } = await fixture();
  for (const key of ['planId', 'executionDigest', 'policyDigest']) {
    await assert.rejects(inspectApproval({ ...options, [key]: 'd'.repeat(64) }), invalid);
  }
  const other = await fixture();
  await assert.rejects(inspectApproval({ ...options, consumerRoot: other.options.consumerRoot }), invalid);
  await writeFile(join(other.options.statePath, 'receipts', `${receipt.id}.json`), JSON.stringify(receipt));
  await assert.rejects(inspectApproval({ ...options, statePath: other.options.statePath }), invalid);
  assert.deepEqual(await readdir(join(options.statePath, 'attempts')), []);
});

test('inspection validates validity interval, real clock, and receipt structure without an attempt', async () => {
  const ttl = 15 * 60 * 1000;
  for (const kind of ['expired', 'future', 'extended', 'unknown-field', 'malformed']) {
    const { options, receipt, file } = await fixture();
    const issuedAt = Date.now() + (kind === 'future' ? ttl : -2 * ttl);
    const changed = kind === 'unknown-field' ? { ...receipt, extra: true }
      : { ...receipt, issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(issuedAt + (kind === 'extended' ? 4 * ttl : ttl)).toISOString() };
    await writeFile(file, kind === 'malformed' ? '{' : JSON.stringify(changed));
    await assert.rejects(inspectApproval(options), invalid);
    assert.deepEqual(await readdir(join(options.statePath, 'attempts')), []);
  }
});

test('inspection never creates missing storage and rejects linked ancestors', async () => {
  const { options } = await fixture();
  const absent = join(dirname(options.statePath), 'absent');
  await assert.rejects(inspectApproval({ ...options, statePath: absent }), error => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.equal(error.message.includes(absent), false);
    return true;
  });
  await assert.rejects(readdir(absent), { code: 'ENOENT' });
  const linked = join(dirname(options.statePath), 'linked');
  await symlink(options.statePath, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectApproval({ ...options, statePath: linked }), invalid);
  for (const receiptId of ['../other', '', 'malformed']) {
    await assert.rejects(inspectApproval({ ...options, receiptId }), invalid);
  }
});
