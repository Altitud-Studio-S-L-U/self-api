import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { captureConsumer } from '../dist/consumer-files.js';

const temporaryParent = resolve('work/test-consumer-files');
await mkdir(temporaryParent, { recursive: true });
const resolvedParent = await realpath(temporaryParent);
const temporaryDirectory = await mkdtemp(join(resolvedParent, 'capture-'));
let fixtureNumber = 0;

after(async () => {
  const target = await realpath(temporaryDirectory);
  assert.equal(dirname(target), resolvedParent);
  assert.ok(basename(target).startsWith('capture-'));
  await rm(target, { recursive: true, force: false });
});

async function repository() {
  const root = join(temporaryDirectory, `repository-${fixtureNumber++}`);
  await mkdir(root);
  return root;
}

async function file(root, path, contents = '') {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  return destination;
}

const sha256 = contents => createHash('sha256').update(contents).digest('hex');
const invalidInput = { name: 'PlumberError', code: 'INVALID_INPUT' };

test('captures supported source types and package manifests as immutable UTF-8 snapshots', async () => {
  const root = await repository();
  const sourceNames = ['plain.ts', 'view.tsx', 'plain.js', 'view.jsx', 'module.mts', 'module.cts', 'module.mjs', 'module.cjs'];
  for (const name of sourceNames) await file(root, `src/${name}`, `export const fileName = ${JSON.stringify(name)};\r\n`);
  const original = '\ufeffexport const saludo = "envío 🚰";\r\n';
  await file(root, 'src/with spaces-ñ.ts', original);
  const packageText = '{"name":"example","dependencies":{"example-sdk":"1.2.3"}}\n';
  await file(root, 'package.json', packageText);
  await file(root, 'packages/client/package.json', '{"name":"client"}');
  const result = await captureConsumer(root);

  assert.deepEqual(result.files.map(item => item.path), [...sourceNames.map(name => `src/${name}`), 'src/with spaces-ñ.ts'].sort());
  assert.deepEqual(result.manifests.map(item => item.path), ['package.json', 'packages/client/package.json']);
  assert.equal(result.manifests[0].text, packageText);
  assert.equal(result.manifests[0].sha256, sha256(packageText));
  const unicode = result.files.find(item => item.path.endsWith('with spaces-ñ.ts'));
  assert.equal(unicode.text, original);
  assert.equal(unicode.sha256, sha256(Buffer.from(original)));
  assert.deepEqual(result.skipped, []);
  assert.throws(() => { result.files.push({}); }, TypeError);
  assert.throws(() => { unicode.text = 'changed'; }, TypeError);
  assert.throws(() => { result.digest = 'changed'; }, TypeError);
  await file(root, 'src/with spaces-ñ.ts', 'changed after capture');
  assert.equal(unicode.text, original);
});

test('does not execute source imports, configuration, or package scripts', async () => {
  const root = await repository();
  const marker = join(root, 'executed.txt');
  const executable = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nthrow new Error('must not execute');\n`;
  await file(root, 'index.mjs', executable);
  const packageText = JSON.stringify({ scripts: { postinstall: `node index.mjs`, test: `node index.mjs` }, plumber: { execute: 'node index.mjs' } });
  await file(root, 'package.json', packageText);
  await file(root, 'plumber.config.js', executable);
  const result = await captureConsumer(root);
  assert.equal(result.files.find(item => item.path === 'index.mjs').text, executable);
  assert.equal(result.manifests[0].text, packageText);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageText);
});

test('reports excluded and hidden entries without descending into them or reading environment files', async () => {
  const root = await repository();
  const excluded = ['node_modules', '.git', '.plumber', 'work', 'dist', 'build', 'coverage', 'vendor', '.next'];
  for (const directory of excluded) await file(root, `${directory}/secret.ts`, Buffer.from([0xff]));
  await file(root, '.private/secret.ts', Buffer.from([0xff]));
  await file(root, '.env', Buffer.from([0xff]));
  await file(root, '.env.local.js', Buffer.from([0xff]));
  await file(root, 'types.d.ts', Buffer.from([0xff]));
  await file(root, 'types.d.mts', Buffer.from([0xff]));
  await file(root, 'types.d.cts', Buffer.from([0xff]));
  await file(root, 'notes.txt', Buffer.from([0xff]));
  await file(root, 'src/valid.ts', 'const valid = true;');
  const result = await captureConsumer(root);
  assert.deepEqual(result.files.map(item => item.path), ['src/valid.ts']);
  const omissions = Object.fromEntries(result.skipped.map(item => [item.path, item.reason]));
  for (const directory of excluded) assert.equal(omissions[directory], 'excluded-directory');
  assert.equal(omissions['.private'], 'hidden-directory');
  assert.equal(omissions['.env'], 'hidden-file');
  assert.equal(omissions['.env.local.js'], 'hidden-file');
  for (const name of ['types.d.ts', 'types.d.mts', 'types.d.cts']) assert.equal(omissions[name], 'declaration-file');
  assert.equal(omissions['notes.txt'], 'unsupported-extension');
  assert.equal(result.skipped.some(item => item.path.includes('secret.ts')), false);
});

test('sorts paths deterministically and hashes the sorted path-and-content manifest', async () => {
  const left = await repository();
  const right = await repository();
  const entries = [['z.ts', 'z'], ['src/a.ts', 'á'], ['package.json', '{}']];
  for (const [path, contents] of entries) await file(left, path, contents);
  for (const [path, contents] of [...entries].reverse()) await file(right, path, contents);
  const first = await captureConsumer(left);
  const second = await captureConsumer(right);
  assert.deepEqual(first, second);
  const expected = entries.map(([path, contents]) => [path, sha256(contents)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  assert.equal(first.digest, sha256(JSON.stringify(expected)));
  await file(right, 'package.json', '{"version":"2"}');
  assert.notEqual((await captureConsumer(right)).digest, first.digest);
  const empty = await captureConsumer(await repository());
  assert.deepEqual(empty.files, []);
  assert.equal(empty.digest, sha256('[]'));
});

test('rejects invalid UTF-8 in eligible source and manifest files without reflecting content', async () => {
  for (const name of ['source.ts', 'package.json']) {
    const root = await repository();
    await file(root, name, Buffer.concat([Buffer.from('private-content-marker'), Buffer.from([0xc3, 0x28])]));
    await assert.rejects(captureConsumer(root), error => {
      assert.equal(error.code, 'INVALID_INPUT');
      assert.equal(error.message.includes('private-content-marker'), false);
      assert.equal(error.message.includes(root), false);
      return true;
    });
  }
});

test('enforces the inclusive 1 MiB per-file limit', async () => {
  const root = await repository();
  const bytes = Buffer.alloc(1024 * 1024, 0x61);
  await file(root, 'source.ts', bytes);
  const result = await captureConsumer(root);
  assert.equal(result.files[0].text.length, bytes.length);
  assert.equal(result.files[0].sha256, sha256(bytes));
  await file(root, 'source.ts', Buffer.alloc(bytes.length + 1, 0x61));
  await assert.rejects(captureConsumer(root), invalidInput);
});

test('enforces the inclusive 16 MiB total across source and manifest bytes', async () => {
  const root = await repository();
  const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
  for (let index = 0; index < 15; index++) await file(root, `source-${index}.ts`, oneMiB);
  await file(root, 'package.json', oneMiB);
  const result = await captureConsumer(root);
  assert.equal(result.files.length, 15);
  assert.equal(result.manifests.length, 1);
  await file(root, 'extra.ts', 'a');
  await assert.rejects(captureConsumer(root), invalidInput);
});

test('counts package manifests in the inclusive 500-file limit', async () => {
  const root = await repository();
  for (let batch = 0; batch < 5; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => file(root, `source-${batch * 100 + index}.ts`, '')));
  }
  assert.equal((await captureConsumer(root)).files.length, 500);
  await file(root, 'package.json', '{}');
  await assert.rejects(captureConsumer(root), invalidInput);
});

test('counts ignored entries toward the inclusive 2000-entry traversal limit', async () => {
  const root = await repository();
  for (let batch = 0; batch < 20; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => file(root, `ignored-${batch * 100 + index}.txt`, '')));
  }
  const result = await captureConsumer(root);
  assert.equal(result.files.length, 0);
  assert.equal(result.skipped.length, 2000);
  await file(root, 'one-more.txt', '');
  await assert.rejects(captureConsumer(root), invalidInput);
});

test('allows depth 20 and rejects deeper traversal instead of returning an incomplete capture', async () => {
  const root = await repository();
  const nested = Array(20).fill('d').join('/');
  await file(root, `${nested}/source.ts`, '');
  assert.equal((await captureConsumer(root)).files[0].path, `${nested}/source.ts`);
  await mkdir(join(root, nested, 'too-deep'));
  await assert.rejects(captureConsumer(root), invalidInput);
});

test('skips linked directories and rejects symlinked roots or ancestors', async () => {
  const root = await repository();
  const target = await repository();
  await file(target, 'private.ts', 'must not be captured');
  await file(root, 'public.ts', 'public');
  const linked = join(root, 'linked');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await captureConsumer(root);
  assert.deepEqual(result.files.map(item => item.path), ['public.ts']);
  assert.deepEqual(result.skipped, [{ path: 'linked', reason: 'symbolic-link' }]);
  await assert.rejects(captureConsumer(linked), invalidInput);
  await mkdir(join(target, 'nested'));
  await assert.rejects(captureConsumer(join(linked, 'nested')), invalidInput);
  if (process.platform !== 'win32') {
    await symlink(join(target, 'private.ts'), join(root, 'linked.ts'), 'file');
    const withFileLink = await captureConsumer(root);
    assert.equal(withFileLink.skipped.find(item => item.path === 'linked.ts').reason, 'symbolic-link');
    assert.deepEqual(withFileLink.files.map(item => item.path), ['public.ts']);
  }
});

test('rejects remote, device, missing, and non-directory roots', async () => {
  for (const path of ['', ' ', '-', 'https://example.invalid/repo', 'file:///repo', 'main:repo', 'C:repo', '\\\\server\\share', '//server/share', '\\\\?\\C:\\repo', '\\\\.\\pipe\\plumber', 'NUL', 'CON', 'COM1', 'repo:stream', 'repo\0name']) {
    await assert.rejects(captureConsumer(path), invalidInput);
  }
  const root = await repository();
  await assert.rejects(captureConsumer(join(root, 'missing')), invalidInput);
  await assert.rejects(captureConsumer(await file(root, 'source.ts', '')), invalidInput);
});
