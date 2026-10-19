import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { after, test } from 'node:test';
import { loadLocalJson, readLocalBytes } from '../dist/local-file.js';

const temporaryParent = resolve('work/test-local-file');
await mkdir(temporaryParent, { recursive: true });
const resolvedParent = await realpath(temporaryParent);
const temporaryDirectory = await mkdtemp(join(resolvedParent, 'local-file-'));
let fixtureNumber = 0;
const recipeLimit = 1024 * 1024;
const invalidInput = { name: 'PlumberError', code: 'INVALID_INPUT' };

after(async () => {
  const target = await realpath(temporaryDirectory);
  assert.equal(dirname(target), resolvedParent);
  assert.ok(basename(target).startsWith('local-file-'));
  await rm(target, { recursive: true, force: false });
});

async function fixture(contents, name = 'recipe.json') {
  const path = join(temporaryDirectory, `${fixtureNumber++}-${name}`);
  await writeFile(path, contents);
  return path;
}

test('reads original bytes without imposing JSON or UTF-8 semantics', async () => {
  const original = Buffer.from([0x00, 0xff, 0xc3, 0x28]);
  const path = await fixture(original, 'binary with spaces.bin');
  const captured = await readLocalBytes(path, original.length);
  assert.deepEqual(captured, original);
  await writeFile(path, Buffer.from('new bytes'));
  assert.deepEqual(captured, original);
  assert.deepEqual(await readLocalBytes(await fixture(''), 1), Buffer.alloc(0));
});

test('bounds bytes inclusively and validates its caller-supplied limit', async () => {
  const path = await fixture('é');
  assert.equal((await readLocalBytes(path, 2)).length, 2);
  await assert.rejects(readLocalBytes(path, 1), invalidInput);
  for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 4 * 1024 * 1024 + 1]) {
    await assert.rejects(readLocalBytes(path, limit), invalidInput);
  }
  const exact = `"${'x'.repeat(recipeLimit - 2)}"`;
  const recipe = await fixture(exact);
  assert.equal((await loadLocalJson(recipe, recipeLimit)).length, recipeLimit - 2);
  await writeFile(recipe, `${exact} `);
  await assert.rejects(loadLocalJson(recipe, recipeLimit), invalidInput);
});

test('loads recipe-shaped data without executing instructions or resolving references', async () => {
  const marker = join(temporaryDirectory, 'must-not-exist');
  const recipe = {
    id: 'synthetic-recipe',
    command: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
    $ref: 'https://example.invalid/private-schema.json',
    note: 'envío 🚰',
  };
  assert.deepEqual(await loadLocalJson(await fixture(`\ufeff${JSON.stringify(recipe)}\r\n`), recipeLimit), recipe);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  for (const value of [null, true, 42, 'a string', ['a']]) {
    assert.deepEqual(await loadLocalJson(await fixture(JSON.stringify(value)), recipeLimit), value);
  }
});

test('rejects malformed JSON and UTF-8 without exposing input data in errors', async () => {
  for (const contents of [
    '', '{"secret":"private-fixture-value",',
    'export default { secret: "private-fixture-value" };',
    Buffer.concat([Buffer.from('private-fixture-value'), Buffer.from([0xc3, 0x28])]),
  ]) {
    await assert.rejects(loadLocalJson(await fixture(contents), recipeLimit), error => {
      assert.equal(error.name, 'PlumberError');
      assert.equal(error.code, 'INVALID_INPUT');
      assert.equal(error.message.includes('private-fixture-value'), false);
      assert.equal(error.message.includes(temporaryDirectory), false);
      return true;
    });
  }
});

test('enforces nesting 128 before parsing and ignores escaped brackets in strings', async () => {
  const atLimit = `${'['.repeat(128)}0${']'.repeat(128)}`;
  assert.deepEqual(await loadLocalJson(await fixture(atLimit), recipeLimit), JSON.parse(atLimit));
  const overLimit = `${'['.repeat(129)}0${']'.repeat(129)}`;
  await assert.rejects(loadLocalJson(await fixture(overLimit), recipeLimit), invalidInput);
  const quoted = { note: `${'[{'.repeat(256)}"\\${'}]'.repeat(256)}` };
  assert.deepEqual(await loadLocalJson(await fixture(JSON.stringify(quoted)), recipeLimit), quoted);
});

test('rejects remote, device, missing, and directory inputs', async () => {
  for (const path of [
    '', ' ', '-', 'https://example.invalid/recipe.json', 'file:///recipe.json',
    'main:recipe.json', 'C:recipe.json', '\\\\server\\share\\recipe.json',
    '//server/share/recipe.json', '\\\\?\\C:\\recipe.json', '\\\\.\\pipe\\plumber',
    'NUL', 'CON', 'COM1.json', 'recipe.json:stream', 'recipe\0.json',
    temporaryDirectory, parse(temporaryDirectory).root, join(temporaryDirectory, 'missing.json'),
  ]) {
    await assert.rejects(readLocalBytes(path, recipeLimit), invalidInput);
  }
});

// POSIX only: Windows has no FIFOs at ordinary paths. No writer ever opens it, so a blocking open would hang until the timeout.
test('rejects a FIFO without blocking on it', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const path = join(temporaryDirectory, `${fixtureNumber++}-fifo.json`);
  execFileSync('mkfifo', ['-m', '0600', path]);
  await assert.rejects(readLocalBytes(path, recipeLimit), invalidInput);
  await assert.rejects(loadLocalJson(path, recipeLimit), invalidInput);
});

test('rejects linked files and ancestor junctions without reading their targets', async () => {
  const target = join(temporaryDirectory, 'target');
  const linked = join(temporaryDirectory, 'linked');
  await mkdir(target);
  await writeFile(join(target, 'recipe.json'), '{"private":"fixture-value"}');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadLocalJson(join(linked, 'recipe.json'), recipeLimit), invalidInput);
  if (process.platform !== 'win32') {
    const linkedFile = join(temporaryDirectory, 'linked-recipe.json');
    await symlink(join(target, 'recipe.json'), linkedFile, 'file');
    await assert.rejects(loadLocalJson(linkedFile, recipeLimit), invalidInput);
  }
});
