import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { listSourceSubscriptions, registerSourceSubscription } from '../dist/index.js';

async function fixture(t) {
  const parent = resolve('work/test-private-state'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'case-'));
  t.after(async () => { assert.equal(dirname(await realpath(directory)), await realpath(parent)); await rm(directory, { recursive: true }); });
  return directory;
}
async function exposeRead(path) {
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
    return {
      permissions: () => execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true }),
      restore: () => execFileSync('icacls.exe', [path, '/remove:g', '*S-1-1-0'], { windowsHide: true }),
    };
  }
  const { stat } = await import('node:fs/promises'), original = (await stat(path)).mode & 0o777;
  await chmod(path, original | 0o044);
  return { permissions: async () => (await stat(path)).mode, restore: () => chmod(path, original) };
}

test('source evidence database rejects public read access without altering permissions or stored evidence', async t => {
  const directory = await fixture(t), sourcePath = join(directory, 'schema.json'), statePath = join(directory, 'state');
  await writeFile(sourcePath, JSON.stringify({ type: 'object', properties: { id: { type: 'string' } } }));
  await registerSourceSubscription({ statePath, sourcePath, baselinePath: sourcePath, kind: 'json-schema', direction: 'input' });
  const database = join(statePath, 'source-observations.sqlite3'), bytes = await readFile(database), exposure = await exposeRead(database);
  try {
    const permissions = await exposure.permissions();
    await assert.rejects(listSourceSubscriptions({ statePath }), { code: 'INVALID_INPUT' });
    assert.equal(await exposure.permissions(), permissions); assert.deepEqual(await readFile(database), bytes);
  } finally { await exposure.restore(); }
  assert.equal((await listSourceSubscriptions({ statePath })).length, 1);
});
