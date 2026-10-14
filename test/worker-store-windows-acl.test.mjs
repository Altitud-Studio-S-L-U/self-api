import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { openWorkerStore } from '../dist/worker-store.js';

if (process.platform === 'win32') {
  test('new WorkerStore state has private native ACLs; public existing state and files are rejected without repair', async t => {
    const parent = resolve('work/test-worker-windows-acl'); await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(await realpath(parent), 'case-'));
    t.after(async () => { assert.equal(dirname(await realpath(directory)), await realpath(parent)); await rm(directory, { recursive: true }); });
    const statePath = join(directory, 'state');
    const store = await openWorkerStore(statePath); store.close();
    const databasePath = join(statePath, 'worker.sqlite3'), bytes = await readFile(databasePath);
    const acl = path => execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true });
    for (const path of [statePath, databasePath]) {
      execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
      const before = acl(path);
      await assert.rejects(openWorkerStore(statePath), /restricted native ACLs/);
      assert.equal(acl(path), before); assert.deepEqual(await readFile(databasePath), bytes);
      execFileSync('icacls.exe', [path, '/remove:g', '*S-1-1-0'], { windowsHide: true });
      const reopened = await openWorkerStore(statePath); reopened.close();
    }
  });
}
