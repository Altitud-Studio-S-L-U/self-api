import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createMigrationPlan } from '../dist/migration-plan.js';

const root = resolve(import.meta.dirname, '..');
const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
const options = {
  basePath: join(root, 'fixtures/orders-v1.json'),
  revisionPath: join(root, 'fixtures/orders-v2.json'),
  consumerRoot: join(root, 'fixtures/migration-consumer'),
  providerBaseUrl: 'https://orders.example.invalid',
  enginePath,
};
const sourcePath = join(options.consumerRoot, 'orders.ts');
async function recipe() { return JSON.parse(await readFile(join(root, 'fixtures/orders-migration.json'), 'utf8')); }

test('migration planning binds explicit edits to captured evidence and does not mutate or execute the consumer', async () => {
  const before = await readFile(sourcePath);
  const plan = await createMigrationPlan({ ...options, recipe: await recipe() });
  assert.equal(plan.status, 'ready-for-review');
  assert.equal(plan.summary, (await recipe()).summary);
  assert.deepEqual(plan.decisions, (await recipe()).decisions);
  assert.equal(plan.authorization, 'not-granted');
  assert.equal(plan.validation, 'syntax-only');
  assert.equal(plan.consumerModified, false);
  assert.equal(plan.consumerExecuted, false);
  assert.match(plan.id, /^[a-f0-9]{64}$/);
  assert.equal(plan.files[0].beforeSha256, createHash('sha256').update(before).digest('hex'));
  assert.match(plan.files[0].after, /total: order\.amount/);
  assert.match(plan.files[0].after, /encodeURIComponent\(context\.region\)/);
  assert.deepEqual(await readFile(sourcePath), before);
  assert.equal((await createMigrationPlan({ ...options, recipe: await recipe() })).id, plan.id);
  const changed = await recipe();
  changed.decisions[0].answer += ' Reviewed explicitly.';
  assert.notEqual((await createMigrationPlan({ ...options, recipe: changed })).id, plan.id);
});

test('missing business decisions produce requirements and no ready patch', async () => {
  const incomplete = await recipe();
  delete incomplete.decisions[1].answer;
  const plan = await createMigrationPlan({ ...options, recipe: incomplete });
  assert.equal(plan.status, 'requires-decision');
  assert.equal(plan.validation, 'not-run');
  assert.equal(plan.authorization, 'not-granted');
  assert.equal(plan.requirements[0].id, 'region-source');
  assert.deepEqual(plan.files, []);
});

test('a stale recipe cannot silently migrate changed consumer content', async t => {
  const work = join(root, 'work/test-migration-plan');
  await mkdir(work, { recursive: true });
  const consumerRoot = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, consumerRoot);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(consumerRoot, { recursive: true, force: true });
  });
  await writeFile(join(consumerRoot, 'orders.ts'), `${await readFile(sourcePath, 'utf8')}\n// human change\n`);
  await assert.rejects(createMigrationPlan({ ...options, consumerRoot, recipe: await recipe() }), error => error.code === 'INVALID_INPUT');
});

// Only this repository's fictional fixture is executed here; the product planner never imports a consumer.
async function runControlledFixture(source, version) {
  const javascript = stripTypeScriptTypes(source);
  const fixture = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://orders.example.invalid');
    assert.equal(url.pathname, '/orders/example');
    if (version === 'B') assert.equal(url.searchParams.get('region'), 'fixture-region', 'required region missing');
    return { json: async () => version === 'A' ? { id: 'example', total: 125 } : { id: 'example', amount: 125 } };
  };
  try { return await fixture.getOrder('example', { region: 'fixture-region' }); }
  finally { globalThis.fetch = previousFetch; }
}

test('the controlled fixture proves both call and parser edits preserve the internal contract', async () => {
  const original = await readFile(sourcePath, 'utf8');
  const mapping = await recipe();
  const expected = { reference: 'example', total: 125 };
  assert.deepEqual(await runControlledFixture(original, 'A'), expected);
  await assert.rejects(runControlledFixture(original, 'B'), /required region missing/);
  const queryEdit = mapping.files[0].edits[1];
  const callOnly = original.replace(queryEdit.before, queryEdit.after);
  assert.notDeepEqual(await runControlledFixture(callOnly, 'B'), expected);
  const plan = await createMigrationPlan({ ...options, recipe: mapping });
  assert.deepEqual(await runControlledFixture(plan.files[0].after, 'B'), expected);
  assert.equal(await readFile(sourcePath, 'utf8'), original);
});
