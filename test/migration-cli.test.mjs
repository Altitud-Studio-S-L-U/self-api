import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'dist/cli.js');
const engine = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
const args = ['plan', 'fixtures/orders-v1.json', 'fixtures/orders-v2.json', '--consumer', 'fixtures/migration-consumer', '--provider-base-url', 'https://orders.example.invalid', '--engine', engine];
function invoke(extra) {
  const result = spawnSync(process.execPath, [cli, ...args, ...extra], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  return result;
}

test('plan CLI provides an exact local proposal without granting execution permission', async () => {
  const before = await readFile(join(root, 'fixtures/migration-consumer/orders.ts'));
  const result = invoke(['--recipe', 'fixtures/orders-migration.json', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.authorization, 'not-granted');
  assert.equal(plan.status, 'ready-for-review');
  assert.equal(plan.files[0].before, before.toString('utf8'));
  assert.match(plan.files[0].after, /total: order\.amount/);
  assert.deepEqual(await readFile(join(root, 'fixtures/migration-consumer/orders.ts')), before);
});

test('plan CLI reports missing decisions with exit one and no proposed files', async t => {
  const work = join(root, 'work/test-plan-cli');
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const recipe = JSON.parse(await readFile(join(root, 'fixtures/orders-migration.json'), 'utf8'));
  delete recipe.decisions[0].answer;
  const path = join(directory, 'recipe.json');
  await writeFile(path, JSON.stringify(recipe));
  const result = invoke(['--recipe', path, '--json']);
  assert.equal(result.status, 1);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.status, 'requires-decision');
  assert.deepEqual(plan.files, []);
  assert.equal(plan.requirements[0].id, 'amount-meaning');
});

test('plan requires an explicit recipe and its text output does not dump source', () => {
  const missing = invoke([]);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr).error.code, 'INVALID_INPUT');
  const text = invoke(['--recipe', 'fixtures/orders-migration.json']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Authorization: not-granted/);
  assert.match(text.stdout, /Proposed file: orders\.ts/);
  assert.doesNotMatch(text.stdout, /export async function|const response/);
});
