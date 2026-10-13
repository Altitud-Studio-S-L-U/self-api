import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { readWorkerServiceStatus, requestWorkerServiceStop } from '../dist/index.js';
import { serviceFiles } from '../dist/worker-service-state.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';

async function fixture(t) {
  const parent = resolve('work/test-worker-service-status'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'status-'));
  checkWindowsPermissions([directory], true, directory);
  t.after(async () => {
    assert.equal(dirname(await realpath(directory)), await realpath(parent));
    await rm(directory, { recursive: true });
  });
  const statePath = join(directory, 'state'); await mkdir(statePath, { mode: 0o700 });
  const config = { schemaVersion: 1, statePath, sources: { intervalMs: 1000 }, allowHttp: false };
  const status = { schemaVersion: 1, runId: randomUUID(), pid: 123, state: 'running', updatedAt: '2026-10-13T12:00:00.000Z',
    cycles: 0, observation: 'healthy', cloud: 'synced', automation: 'active', licenseReason: 'allowed' };
  return { config, status, write: value => writeFile(join(statePath, serviceFiles.status), JSON.stringify(value), { mode: 0o600 }) };
}

test('persisted service status validates every field before reporting state or creating a stop request', async t => {
  const item = await fixture(t);
  const rejected = error => error?.code === 'INVALID_INPUT' && !error.message.includes('PRIVATE');
  const changes = [
    { state: 'PRIVATE-unknown' }, { observation: 'PRIVATE-unknown' }, { cloud: 'PRIVATE-unknown' },
    { automation: 'PRIVATE-unknown' }, { licenseReason: 'PRIVATE-unknown' }, { models: 'PRIVATE-unknown' },
    { state: null }, { observation: [] }, { cloud: {} }, { automation: true }, { licenseReason: 1 }, { models: null },
    { schemaVersion: 2 }, { schemaVersion: '1' }, { runId: '-'.repeat(36) }, { runId: 'ABCDEF12-3456-4789-ABCD-EF1234567890' },
    { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: Number.MAX_SAFE_INTEGER + 1 }, { pid: '123' },
    { cycles: -1 }, { cycles: 1.5 }, { cycles: Number.MAX_SAFE_INTEGER + 1 }, { cycles: '0' },
    { updatedAt: 'PRIVATE-date' }, { updatedAt: '2026-02-30T12:00:00.000Z' }, { updatedAt: '2026-10-13T25:00:00.000Z' },
    { updatedAt: '2026-10-13' }, { updatedAt: 1 }, { extra: 'PRIVATE-unexpected-field' },
  ];
  for (const change of changes) {
    await item.write({ ...item.status, ...change });
    assert.throws(() => readWorkerServiceStatus(item.config), rejected, JSON.stringify(Object.keys(change)));
    assert.throws(() => requestWorkerServiceStop(item.config), rejected);
  }
  for (const field of Object.keys(item.status)) {
    const incomplete = { ...item.status }; delete incomplete[field]; await item.write(incomplete);
    assert.throws(() => readWorkerServiceStatus(item.config), rejected, `Missing ${field}`);
  }
  for (const value of [null, [], 42, 'PRIVATE', { schemaVersion: 1, runId: item.status.runId }]) {
    await item.write(value); assert.throws(() => readWorkerServiceStatus(item.config), rejected);
  }
  await assert.rejects(readFile(join(item.config.statePath, serviceFiles.stop)), { code: 'ENOENT' });
});

test('valid service status retains optional model state and stop targets only the reported run', async t => {
  const item = await fixture(t);
  assert.equal(readWorkerServiceStatus(item.config), undefined);
  assert.deepEqual(requestWorkerServiceStop(item.config), { requested: false });
  await item.write(item.status);
  assert.deepEqual(readWorkerServiceStatus(item.config), item.status);
  assert.equal(Object.hasOwn(readWorkerServiceStatus(item.config), 'models'), false);
  for (const state of ['starting', 'running', 'degraded', 'stopping', 'stopped', 'failed']) {
    for (const models of ['pending', 'unverified', 'healthy', 'degraded', 'requires-reconfiguration']) {
      const value = { ...item.status, state, models }; await item.write(value);
      assert.deepEqual(readWorkerServiceStatus(item.config), value);
      assert.deepEqual(requestWorkerServiceStop(item.config), ['stopped', 'failed'].includes(state)
        ? { requested: false } : { requested: true, runId: item.status.runId });
    }
  }
  assert.deepEqual(JSON.parse(await readFile(join(item.config.statePath, serviceFiles.stop), 'utf8')),
    { schemaVersion: 1, runId: item.status.runId });
});

test('malformed persisted status returns a sanitized contract error', async t => {
  const item = await fixture(t);
  await writeFile(join(item.config.statePath, serviceFiles.status), '{"PRIVATE":broken}', { mode: 0o600 });
  assert.throws(() => readWorkerServiceStatus(item.config), error => error?.code === 'INVALID_INPUT' && !error.message.includes('PRIVATE'));
});
