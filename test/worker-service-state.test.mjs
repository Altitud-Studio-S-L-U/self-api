import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, linkSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { serviceFiles, writeServiceSnapshot } from '../dist/worker-service-state.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';

async function fixture(t) {
  const parent = resolve('work/test-worker-service-state'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'snapshot-'));
  checkWindowsPermissions([directory], true, directory);
  await chmod(directory, 0o700);
  const cleanup = [];
  t.after(async () => {
    for (const release of cleanup.reverse()) await release();
    assert.equal(dirname(await realpath(directory)), await realpath(parent)); await rm(directory, { recursive: true });
  });
  const path = join(directory, serviceFiles.status), temporary = `${path}.next`;
  const previous = { state: 'starting', cycle: 0 }, next = { state: 'running', cycle: 1, payload: 'x'.repeat(1000) };
  writeServiceSnapshot(directory, serviceFiles.status, previous);
  return { directory, path, temporary, previous, next, cleanup };
}

function replaceInChild(item) {
  const source = `import { writeServiceSnapshot } from ${JSON.stringify(pathToFileURL(resolve('dist/worker-service-state.js')).href)};
    process.send('attempting');
    try { writeServiceSnapshot(process.argv[1], process.argv[2], JSON.parse(process.argv[3])); process.send({ completed: true }); }
    catch (error) { process.send({ completed: false, code: error.code, syscall: error.syscall, message: error.message }); process.exitCode = 2; }
    process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, item.directory, serviceFiles.status, JSON.stringify(item.next)],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = []; let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const started = once(child, 'message');
  child.on('message', value => { messages.push(value); });
  const exited = once(child, 'exit');
  return { child, started, exited, messages, stderr: () => stderr };
}

async function staged(item, processInfo) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    try { assert.deepEqual(JSON.parse(await readFile(item.temporary, 'utf8')), item.next); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(processInfo.child.exitCode, null, processInfo.stderr());
    await delay(10);
  }
  assert.fail('Snapshot writer did not reach its bounded staging file');
}

test('snapshot replacement rejects linked state and oversize records without replacing the previous snapshot', async t => {
  const item = await fixture(t);
  assert.throws(() => writeServiceSnapshot(item.directory, serviceFiles.status, { data: 'x'.repeat(16_384) }), /fixed limit/);
  assert.deepEqual(JSON.parse(await readFile(item.path, 'utf8')), item.previous);
  linkSync(item.path, join(item.directory, 'linked-status'));
  assert.throws(() => writeServiceSnapshot(item.directory, serviceFiles.status, item.next), /links or special files/);
  assert.deepEqual(JSON.parse(await readFile(item.path, 'utf8')), item.previous);
});

if (process.platform === 'win32') {
  test('Windows atomic replacement waits for a real reader to close and publishes one complete snapshot', async t => {
    const item = await fixture(t);
    let reader = openSync(item.path, 'r');
    item.cleanup.push(() => { if (reader !== undefined) closeSync(reader); });
    const processInfo = replaceInChild(item);
    item.cleanup.push(async () => { if (processInfo.child.exitCode === null) { processInfo.child.kill(); await processInfo.exited; } });
    await processInfo.started; await staged(item, processInfo);
    await delay(250);
    assert.equal(processInfo.child.exitCode, null, processInfo.stderr());
    assert.deepEqual(JSON.parse(readFileSync(item.path, 'utf8')), item.previous);
    closeSync(reader); reader = undefined;
    assert.deepEqual(await processInfo.exited, [0, null], processInfo.stderr());
    assert.deepEqual(processInfo.messages.at(-1), { completed: true });
    assert.deepEqual(JSON.parse(await readFile(item.path, 'utf8')), item.next);
    await assert.rejects(readFile(item.temporary), { code: 'ENOENT' });
    checkWindowsPermissions([item.directory, item.path], true);
  });

  test('Windows retained reader ends the bounded replacement with EPERM and keeps the previous snapshot intact', async t => {
    const item = await fixture(t);
    const reader = openSync(item.path, 'r'); item.cleanup.push(() => closeSync(reader));
    const processInfo = replaceInChild(item);
    item.cleanup.push(async () => { if (processInfo.child.exitCode === null) { processInfo.child.kill(); await processInfo.exited; } });
    const started = Date.now();
    await processInfo.started; await staged(item, processInfo);
    assert.deepEqual(await processInfo.exited, [2, null], processInfo.stderr());
    const elapsed = Date.now() - started;
    assert(elapsed >= 1000 && elapsed < 10_000, `Replacement including native ACL inspection took ${elapsed}ms`);
    assert.equal(processInfo.messages.at(-1).code, 'EPERM');
    assert.equal(processInfo.messages.at(-1).syscall, 'rename');
    assert.deepEqual(JSON.parse(readFileSync(item.path, 'utf8')), item.previous);
    assert.deepEqual(JSON.parse(await readFile(item.temporary, 'utf8')), item.next);
  });

  test('Windows replacement does not repair a public destination or change its previous snapshot', async t => {
    const item = await fixture(t);
    execFileSync('icacls.exe', [item.path, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
    item.cleanup.push(() => execFileSync('icacls.exe', [item.path, '/remove:g', '*S-1-1-0'], { windowsHide: true, stdio: 'pipe' }));
    const reader = openSync(item.path, 'r'); item.cleanup.push(() => closeSync(reader));
    const permissions = execFileSync('icacls.exe', [item.path], { encoding: 'utf8', windowsHide: true });
    assert.throws(() => writeServiceSnapshot(item.directory, serviceFiles.status, item.next), /restricted native ACLs/);
    assert.equal(execFileSync('icacls.exe', [item.path], { encoding: 'utf8', windowsHide: true }), permissions);
    assert.deepEqual(JSON.parse(readFileSync(item.path, 'utf8')), item.previous);
    assert.deepEqual(JSON.parse(await readFile(item.temporary, 'utf8')), item.next);
  });

  test('Windows replacement preserves a genuinely read-only destination instead of changing its permissions', async t => {
    const item = await fixture(t);
    await chmod(item.path, 0o400); item.cleanup.push(() => chmod(item.path, 0o600));
    assert.throws(() => writeServiceSnapshot(item.directory, serviceFiles.status, item.next), { code: 'EPERM', syscall: 'rename' });
    assert.deepEqual(JSON.parse(await readFile(item.path, 'utf8')), item.previous);
    assert.deepEqual(JSON.parse(await readFile(item.temporary, 'utf8')), item.next);
    assert.throws(() => openSync(item.path, 'w'), { code: 'EPERM' });
  });

  test('Windows replacement rejects changed staging bytes while a reader holds the previous snapshot', async t => {
    const item = await fixture(t);
    const reader = openSync(item.path, 'r'); item.cleanup.push(() => closeSync(reader));
    const processInfo = replaceInChild(item);
    item.cleanup.push(async () => { if (processInfo.child.exitCode === null) { processInfo.child.kill(); await processInfo.exited; } });
    await processInfo.started; await staged(item, processInfo);
    const changed = { state: 'untrusted-staging' };
    await writeFile(item.temporary, `${JSON.stringify(changed)}\n`);
    assert.deepEqual(await processInfo.exited, [2, null], processInfo.stderr());
    assert.equal(processInfo.messages.at(-1).code, 'INVALID_INPUT');
    assert.match(processInfo.messages.at(-1).message, /changed during atomic replacement/);
    assert.deepEqual(JSON.parse(readFileSync(item.path, 'utf8')), item.previous);
    assert.deepEqual(JSON.parse(await readFile(item.temporary, 'utf8')), changed);
  });
}
