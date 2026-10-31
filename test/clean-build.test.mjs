import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

async function fixture(t) {
  const parent = resolve('work/test-clean-build');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'case-'));
  t.after(async () => {
    assert.equal(dirname(await realpath(directory)), await realpath(parent));
    await rm(directory, { recursive: true });
  });
  const context = join(directory, 'project');
  await mkdir(join(context, 'tooling'), { recursive: true });
  const script = join(context, 'tooling/clean-build.mjs');
  await copyFile(new URL('../tooling/clean-build.mjs', import.meta.url), script);
  return { directory, context, script };
}

test('clean build removes generated output while preserving adjacent files', async t => {
  const { context, script } = await fixture(t);
  await mkdir(join(context, 'dist'));
  await writeFile(join(context, 'dist/retired-transport.js'), 'stale');
  await writeFile(join(context, 'source.txt'), 'keep');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(join(context, 'dist/retired-transport.js')), { code: 'ENOENT' });
  assert.equal(await readFile(join(context, 'source.txt'), 'utf8'), 'keep');
});

test('clean build rejects a linked output directory and preserves its target', async t => {
  const { directory, context, script } = await fixture(t);
  const target = join(directory, 'other-data');
  await mkdir(target);
  await writeFile(join(target, 'sentinel.txt'), 'keep');
  await symlink(target, join(context, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /build output must not be a symbolic link/u);
  assert.equal(await readFile(join(target, 'sentinel.txt'), 'utf8'), 'keep');
});
