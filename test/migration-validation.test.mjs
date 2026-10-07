import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { prepareMigrationValidation, approveMigrationValidation, executeMigrationValidation } from '../dist/migration-validation.js';
import { consumeApproval } from '../dist/approval-store.js';

const root = resolve(import.meta.dirname, '..');
const work = join(root, 'work/test-migration-validation');
const hash = text => createHash('sha256').update(text).digest('hex');

async function fixture(t) {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const consumerRoot = join(directory, 'consumer');
  const statePath = join(directory, 'state');
  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'orders.ts'), await readFile(join(root, 'fixtures/migration-consumer/orders.ts')));
  await writeFile(join(consumerRoot, 'orders.test.mjs'), "throw new Error('This untrusted module must never execute during inspection or approval');\n");
  const basePath = join(directory, 'base.json');
  const revisionPath = join(directory, 'revision.json');
  await writeFile(basePath, await readFile(join(root, 'fixtures/orders-v1.json')));
  await writeFile(revisionPath, await readFile(join(root, 'fixtures/orders-v2.json')));
  const options = {
    basePath, revisionPath, consumerRoot,
    providerBaseUrl: 'https://orders.example.invalid',
    enginePath: join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff'),
    recipe: JSON.parse(await readFile(join(root, 'fixtures/orders-migration.json'), 'utf8')),
    testPaths: ['orders.test.mjs'],
  };
  return { options, statePath };
}

test('validation requests bind exact tests and policy without running consumer modules or granting approval', async t => {
  const { options, statePath } = await fixture(t);
  const request = await prepareMigrationValidation(options);
  assert.equal(request.plan.authorization, 'not-granted');
  assert.deepEqual(request.spec.testPaths, options.testPaths);
  assert.deepEqual(request.spec.actions, ['baseline', 'candidate']);
  assert.match(request.id, /^[a-f0-9]{64}$/);
  assert.equal((await prepareMigrationValidation(options)).id, request.id);
  await assert.rejects(readdir(statePath), { code: 'ENOENT' });
  const original = await readFile(join(options.consumerRoot, 'orders.ts'), 'utf8');
  assert.equal(hash(original), request.plan.files[0].beforeSha256);
});

test('validation requires explicit captured tests and preserves their approved bytes', async t => {
  const { options, statePath } = await fixture(t);
  await writeFile(join(options.consumerRoot, 'orders[edge].test.mjs'), 'export {};');
  for (const testPaths of [[], ['../outside.mjs'], ['orders.test.mjs', 'orders.test.mjs'], ['missing.mjs'], ['/orders.test.mjs'], ['orders.test.mjs\n'], ['orders[edge].test.mjs']]) {
    await assert.rejects(prepareMigrationValidation({ ...options, testPaths }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(readdir(statePath), { code: 'ENOENT' });
  const before = await readFile(join(options.consumerRoot, 'orders.test.mjs'), 'utf8');
  options.recipe.files.push({ path: 'orders.test.mjs', sha256: hash(before), edits: [{ before, after: 'export {};\n' }] });
  await assert.rejects(prepareMigrationValidation(options), /preserves selected tests/);
});

test('unresolved decisions cannot be approved and a changed review ID cannot mint a receipt', async t => {
  const { options, statePath } = await fixture(t);
  await assert.rejects(approveMigrationValidation({ options, statePath, expectedRequestId: '0'.repeat(64), origin: 'explicit-sdk-caller' }), /review the current proposal/);
  await assert.rejects(readdir(statePath), { code: 'ENOENT' });
  delete options.recipe.decisions[0].answer;
  await assert.rejects(prepareMigrationValidation(options), /Resolve migration decisions/);
});

test('approval alone does not stage or execute code and stale test evidence prevents consumption', async t => {
  const { options, statePath } = await fixture(t);
  const request = await prepareMigrationValidation(options);
  const receipt = await approveMigrationValidation({ options, statePath, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  assert.equal(receipt.planId, request.plan.id);
  assert.equal(receipt.executionDigest, request.executionDigest);
  const oldTest = await readFile(join(options.consumerRoot, 'orders.test.mjs'), 'utf8');
  await writeFile(join(options.consumerRoot, 'orders.test.mjs'), `${oldTest}\n// changed after approval\n`);
  await assert.rejects(executeMigrationValidation({ options, statePath, receiptId: receipt.id }), { code: 'INVALID_INPUT' });
  await writeFile(join(options.consumerRoot, 'orders.test.mjs'), oldTest);
  // Failed freshness checks did not consume the still-matching original approval.
  await consumeApproval({ statePath, consumerRoot: options.consumerRoot, receiptId: receipt.id,
    planId: request.plan.id, executionDigest: request.executionDigest, policyDigest: request.policyDigest });
  await assert.rejects(executeMigrationValidation({ options, statePath, receiptId: receipt.id }), { code: 'INVALID_INPUT' });
});

test('provider evidence changed after approval cannot run an old request', async t => {
  const { options, statePath } = await fixture(t);
  const request = await prepareMigrationValidation(options);
  const receipt = await approveMigrationValidation({ options, statePath, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  const revision = JSON.parse(await readFile(options.revisionPath, 'utf8'));
  revision.info.version = 'changed-after-approval';
  await writeFile(options.revisionPath, JSON.stringify(revision));
  await assert.rejects(executeMigrationValidation({ options, statePath, receiptId: receipt.id }), { code: 'INVALID_INPUT' });
});
