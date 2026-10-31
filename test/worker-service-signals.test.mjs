import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServiceFixture } from '../tooling/service-fixture.mjs';
import { loadWorkerServiceConfig, readWorkerServiceStatus, runWorkerService } from '../dist/index.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';

async function fixture(t) {
  const parent = resolve('work/test-worker-service-signals');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'case-'));
  checkWindowsPermissions([directory], true, directory);
  t.after(async () => {
    assert.equal(dirname(await realpath(directory)), await realpath(parent));
    await rm(directory, { recursive: true });
  });
  const value = await createServiceFixture(directory);
  return loadWorkerServiceConfig(value.configPath);
}

test('an already cancelled standalone service observes nothing and releases ownership for the next run', async t => {
  const config = await fixture(t);
  const cancelled = new AbortController();
  cancelled.abort();
  let observations = 0;
  const first = await runWorkerService(config, { signal: cancelled.signal, dependencies: {
    observeSources: async () => { assert.fail('Cancelled work must never start'); },
  } });
  assert.equal(first.state, 'stopped');
  assert.equal(first.cycles, 0);
  const next = new AbortController();
  const second = await runWorkerService(config, { signal: next.signal, dependencies: {
    observeSources: async ({ signal }) => {
      assert.equal(signal.aborted, false);
      observations++;
      next.abort();
      return { schemaVersion: 1, results: [{ status: 'unchanged' }] };
    },
  } });
  assert.equal(second.state, 'stopped');
  assert.equal(observations, 1);
  assert.notEqual(second.runId, first.runId);
  assert.deepEqual(readWorkerServiceStatus(config), second);
});
