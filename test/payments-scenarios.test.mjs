import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createMigrationPlan, prepareMigrationValidation } from '../dist/index.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const fixtureRoot = join(root, 'fixtures/payments');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const recipe = JSON.parse(await readFile(join(fixtureRoot, 'payment-recipe.json'), 'utf8'));
const options = { basePath: join(fixtureRoot, 'payments-v1.json'), revisionPath: join(fixtureRoot, 'payments-v2.json'),
  consumerRoot: join(fixtureRoot, 'consumer'), providerBaseUrl: 'http://127.0.0.1:43127', recipe,
  enginePath: join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff') };

test('payment fixtures prove real HTTP behavior before and after the exact SDK proposal', { timeout: 45_000 }, async t => {
  const work = join(root, 'work/payments-scenarios');
  await mkdir(work, { recursive: true });
  const parent = await realpath(work), directory = await mkdtemp(join(parent, 'payments-'));
  t.after(async () => {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), parent);
    assert.ok(basename(actual).startsWith('payments-'));
    await rm(actual, { recursive: true, force: false });
  });
  await cp(options.consumerRoot, directory, { recursive: true });
  const beforeTests = await readFile(join(directory, 'payments-v2.test.mjs'));
  const environment = { ...process.env };
  // A standalone child test runner must not inherit the parent's test-worker protocol.
  delete environment.NODE_TEST_CONTEXT;
  const run = testPath => execute(process.execPath, ['--test', '--test-reporter=tap', testPath], {
    cwd: directory, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 512 * 1024, encoding: 'utf8', env: environment,
  });
  const first = await run('payments-v1.test.mjs');
  assert.match(first.stdout, /# fail 0/u);
  await assert.rejects(run('payments-v2.test.mjs'), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /not ok \d+ - the migrated request/u);
    assert.match(error.stdout, /not ok \d+ - the parser independently/u);
    assert.doesNotMatch(error.stdout, /EADDRINUSE|testTimeoutFailure/u);
    return true;
  });
  const plan = await createMigrationPlan({ ...options, consumerRoot: directory });
  assert.equal(plan.status, 'ready-for-review');
  assert.equal(plan.authorization, 'not-granted');
  assert.equal(plan.impact.comparison.status, 'breaking-changes');
  const affectedCalls = new Set(plan.impact.matches.flatMap(match => match.callIds));
  assert.ok(plan.impact.inventory.calls.some(call => call.location.file === 'payments.mjs' && affectedCalls.has(call.id)));
  assert.deepEqual(plan.files.map(file => file.path), ['payments.mjs']);
  assert.equal(plan.files[0].after, await readFile(join(fixtureRoot, 'payments-v2.mjs'), 'utf8'));
  // This is an owned synthetic test copy, never a customer checkout or an unapproved SDK execution.
  await writeFile(join(directory, 'payments.mjs'), plan.files[0].after);
  const candidate = await run('payments-v2.test.mjs');
  assert.match(candidate.stdout, /# fail 0/u);
  assert.match(candidate.stdout, /# tests 25/u);
  assert.deepEqual(await readFile(join(directory, 'payments-v2.test.mjs')), beforeTests);
  assert.equal(hash(await readFile(join(options.consumerRoot, 'payments.mjs'))), recipe.files[0].sha256);
});

test('unknown payment units prevent validation rather than guessing a conversion', async () => {
  const unanswered = structuredClone(recipe);
  delete unanswered.decisions.find(decision => decision.id === 'amount-units').answer;
  const plan = await createMigrationPlan({ ...options, recipe: unanswered });
  assert.equal(plan.status, 'requires-decision');
  assert.equal(plan.validation, 'not-run');
  assert.equal(plan.authorization, 'not-granted');
  await assert.rejects(prepareMigrationValidation({ ...options, recipe: unanswered, testPaths: ['payments-v2.test.mjs'] }), {
    code: 'INVALID_INPUT', message: 'Resolve migration decisions and provide a nonempty proposal before requesting validation.',
  });
});

test('the selected payment provider and assertions cannot be edited to manufacture a passing migration', async () => {
  const weakened = structuredClone(recipe);
  const text = await readFile(join(options.consumerRoot, 'payments-v2.test.mjs'), 'utf8');
  weakened.files.push({ path: 'payments-v2.test.mjs', sha256: hash(text), edits: [{ before: text, after: "import { test } from 'node:test'; test('synthetic fake success', () => {});\n" }] });
  await assert.rejects(prepareMigrationValidation({ ...options, recipe: weakened, testPaths: ['payments-v2.test.mjs'] }), {
    code: 'INVALID_INPUT', message: 'This profile preserves selected tests; a recipe cannot edit them.',
  });
});
