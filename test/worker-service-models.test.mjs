import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { ModelConnections, ModelConnectionStore, runWorkerService } from '../dist/index.js';
import { createServiceFixture } from '../tooling/service-fixture.mjs';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';

test('worker startup checks require their separate grant, run once per restart, and never poll paid inference at idle', { timeout: 4 * 45000 }, async t => {
  const parent = resolve('work/test-worker-service-models'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'case-')); checkWindowsPermissions([directory], true, directory);
  t.after(async () => {
    const target = await realpath(directory); assert.equal(dirname(target), await realpath(parent)); assert(basename(target).startsWith('case-'));
    await rm(target, { recursive: true });
  });
  const fixture = await createServiceFixture(directory), base = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  const modelPath = join(directory, 'connections.json');
  const profile = { schemaVersion: 1, primary: 'local', connections: [{ id: 'local', revision: 1, credentialRevision: 1,
    provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'test-model', policyId: 'private-test', maximumOutputTokens: 1024 }] };
  await writeFile(modelPath, JSON.stringify(profile), { mode: 0o600 });
  const configuration = { ...base, models: { configPath: modelPath } };
  let checks = 0;
  const once = async expected => {
    const controller = new AbortController(); let observed = 0;
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const result = await runWorkerService(configuration, { signal: controller.signal, dependencies: {
        probeModel: async () => { checks++; return { status: 'verified', latencyMs: 1, maximumOutputTokens: 128 }; },
        observeSources: async () => { observed++; return { schemaVersion: 1, results: [] }; },
        wait: async (milliseconds, signal) => {
          await delay(Math.min(milliseconds, 100), undefined, { signal }).catch(() => {});
          // Like the runtime's status reader, close the handle before its synchronous Windows snapshot replacement.
          const status = JSON.parse(readFileSync(join(base.statePath, 'worker-service.status.json'), 'utf8'));
          if (observed >= 2 && status.models === expected) controller.abort();
        },
      } });
      assert.equal(result.models, expected); assert(observed >= 2); assert.equal(result.state, 'stopped');
    } finally { clearTimeout(timeout); controller.abort(); }
  };
  await once('unverified'); assert.equal(checks, 0);
  const store = await ModelConnectionStore.open(base.statePath);
  try { store.authorizeStartupProbe(new ModelConnections(profile).configurationDigest); } finally { store.close(); }
  await once('healthy'); assert.equal(checks, 1);
  await once('healthy'); assert.equal(checks, 2);
  await writeFile(modelPath, JSON.stringify({ ...profile, connections: [{ ...profile.connections[0], revision: 2, credentialRevision: 2 }] }));
  await once('unverified'); assert.equal(checks, 2, 'Changing revision invalidates the standing startup probe grant.');
});
