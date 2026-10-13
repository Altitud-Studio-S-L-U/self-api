import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createServiceFixture } from '../tooling/service-fixture.mjs';
import { createLicenseFixture } from '../tooling/license-fixture.mjs';
import { runWorkerService, registerLocalSubscription, CloudConnectionError } from '../dist/index.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';

const deferred = () => Promise.withResolvers();
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, cloud = false) {
  const parent = resolve('work/test-worker-service-signals'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'case-')); checkWindowsPermissions([directory], true, directory);
  const original = await createServiceFixture(directory), lease = await createLicenseFixture(directory);
  let config = { ...JSON.parse(await readFile(original.configPath, 'utf8')), license: lease.license }, running;
  if (cloud) {
    const consumerRoot = join(directory, 'consumer'), cloudPath = join(directory, 'cloud'), sourcePath = join(directory, 'openapi.json');
    await mkdir(consumerRoot); await mkdir(cloudPath, { mode: 0o700 });
    await writeFile(join(consumerRoot, 'orders.mjs'), "export const orders = () => fetch('https://orders.example.invalid/orders');\n");
    await writeFile(sourcePath, await readFile('fixtures/orders-v1.json'));
    const enginePath = resolve('work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
    const subscription = await registerLocalSubscription({ statePath: config.statePath, sourcePath, baselinePath: sourcePath, consumerRoot,
      providerBaseUrl: 'https://orders.example.invalid', enginePath });
    const { sources: _sources, ...input } = config;
    config = { ...input, openApi: { enginePath, intervalMs: 1000 }, cloud: { credentialsPath: lease.license.credentialsPath,
      statePath: cloudPath, integrationIds: [subscription.id], intervalMs: 60000 } };
  }
  const controller = new AbortController(), stopped = deferred();
  controller.signal.addEventListener('abort', stopped.resolve, { once: true });
  t.after(async () => { controller.abort(); await running?.catch(() => {}); await rm(directory, { recursive: true }); });
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const waits = new Set();
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const cancel = () => { waits.delete(item); signal.removeEventListener('abort', cancel); reject(new DOMException('Cancelled', 'AbortError')); };
    const item = { due: elapsed + ms, finish: () => { waits.delete(item); signal.removeEventListener('abort', cancel); resolve(); } };
    if (signal.aborted) { cancel(); return; }
    waits.add(item); signal.addEventListener('abort', cancel, { once: true });
  });
  return { directory, config, lease, controller, stopped: stopped.promise, waits,
    now: () => elapsed, status: () => JSON.parse(readFileSync(join(config.statePath, 'worker-service.status.json'), 'utf8')),
    async advance(ms) { elapsed += ms; for (const item of [...waits]) if (item.due <= elapsed) item.finish(); await flush(); },
    start(dependencies) { running = runWorkerService(config, { signal: controller.signal, dependencies: { wait, ...dependencies } }); return running; }, wait };
}

test('a signed pause acknowledges draining and completion before the next periodic control poll', { timeout: 60000 }, async t => {
  const f = await fixture(t), started = deferred(), draining = deferred(), paused = deferred(), release = deferred(), firstWait = deferred();
  t.after(release.resolve);
  const denial = await f.lease.sign({ revision: 2, decision: 'suspended' }), requests = [];
  let inFlight = 0, maximum = 0;
  const running = f.start({
    control: { async poll(input) {
      inFlight++; maximum = Math.max(maximum, inFlight); requests.push(input);
      if (requests.length === 1) await started.promise;
      if (input.automation === 'draining' && input.observedRevision === 2) draining.resolve();
      if (input.automation === 'paused' && input.observedRevision === 2) { paused.resolve(); f.controller.abort(); }
      inFlight--; return { schemaVersion: 1, license: denial, pollAfterMs: 60000 };
    } },
    async observeSources({ signal }) { started.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await Promise.race([release.promise, f.stopped]); return { schemaVersion: 1, results: [] }; },
    wait(ms, signal) { if (f.status().licenseReason === 'suspended' && requests.length === 1) firstWait.resolve(ms); return f.wait(ms, signal); },
  });
  assert((await firstWait.promise) <= 1000, 'The acknowledgement must not wait for the sixty-second heartbeat.');
  await f.advance(1000); await draining.promise; await flush();
  assert.equal(requests.length, 2, 'An unchanged response must not generate an acknowledgement loop.');
  release.resolve(); await flush(); await f.advance(1000); await paused.promise;
  await running; assert.equal(maximum, 1); assert.deepEqual(requests.map(value => [value.observedRevision, value.automation]), [[1, 'active'], [2, 'draining'], [2, 'paused']]);
});

test('new persisted observations wake Cloud sync without overlapping sends or bypassing failure backoff', { timeout: 60000 }, async t => {
  const f = await fixture(t, true), firstSync = deferred(), releaseObservation = deferred(), thirdSync = deferred();
  let observations = 0, syncs = 0, inFlight = 0, maximum = 0;
  const sendTimes = [];
  const running = f.start({
    control: { async poll() { await f.stopped; throw new CloudConnectionError('NETWORK_UNAVAILABLE'); } },
    async observe() {
      observations++;
      if (observations === 1) await Promise.race([releaseObservation.promise, f.stopped]);
      return { schemaVersion: 1, results: [{ subscriptionId: f.config.cloud.integrationIds[0], status: 'observed' }] };
    },
    async sync() {
      syncs++; inFlight++; maximum = Math.max(maximum, inFlight); sendTimes.push(f.now());
      try {
        if (syncs === 1) { firstSync.resolve(); return { state: 'synced', sent: 0, pending: 0 }; }
        if (syncs === 2) throw new CloudConnectionError('NETWORK_UNAVAILABLE');
        thirdSync.resolve(); await f.stopped; return { state: 'synced', sent: 1, pending: 0 };
      } finally { inFlight--; }
    },
  });
  await firstSync.promise; await flush(); releaseObservation.resolve(); await flush();
  await f.advance(25);
  assert.equal(syncs, 2, 'A persisted change must be sent without advancing the sixty-second heartbeat.');
  await f.advance(1000); assert(observations >= 2); assert.equal(syncs, 2, 'New observations cannot bypass the existing transport failure backoff.');
  await f.advance(118999); assert.equal(syncs, 2);
  await f.advance(1); await thirdSync.promise;
  await f.advance(1000); assert.equal(syncs, 3, 'A send already in progress retains sole ownership.');
  f.controller.abort(); await running;
  assert.equal(maximum, 1); assert.equal(inFlight, 0); assert(sendTimes[1] < 60000); assert.equal(sendTimes[2] - sendTimes[1], 120000);
});

test('a failed immediate control acknowledgement keeps the normal retry interval and paused state', { timeout: 60000 }, async t => {
  const f = await fixture(t), started = deferred(), firstWait = deferred(), failedAck = deferred(), retried = deferred();
  const denial = await f.lease.sign({ revision: 2, decision: 'suspended' }), times = [];
  const running = f.start({
    control: { async poll(input) {
      times.push(f.now());
      if (times.length === 1) await started.promise;
      if (times.length === 2) { failedAck.resolve(); throw new CloudConnectionError('NETWORK_UNAVAILABLE'); }
      if (times.length === 3) { assert.equal(input.observedRevision, 2); assert.equal(input.automation, 'paused'); retried.resolve(); f.controller.abort(); }
      return { schemaVersion: 1, license: denial, pollAfterMs: 60000 };
    } },
    async observeSources({ signal }) { started.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { schemaVersion: 1, results: [] }; },
    wait(ms, signal) { if (f.status().licenseReason === 'suspended' && times.length === 1 && ms <= 1000) firstWait.resolve(); return f.wait(ms, signal); },
  });
  await firstWait.promise; await f.advance(1000); await failedAck.promise; await flush();
  assert.equal(f.status().automation, 'paused');
  await f.advance(59999); assert.equal(times.length, 2, 'A failed acknowledgement must not spin or retry on observation-loop wakeups.');
  await f.advance(1); await retried.promise; await running;
  assert.deepEqual(times, [0, 1000, 61000]);
});

test('a control response started before a concurrent status 401 cannot restore revoked permission', { timeout: 60000 }, async t => {
  const f = await fixture(t, true), pollStarted = deferred(), oldResponse = deferred(), denied = deferred(), oldSettled = deferred(), restored = deferred();
  let polls = 0, syncs = 0, released = false;
  const running = f.start({
    control: { async poll() {
      polls++;
      if (polls === 1) { pollStarted.resolve(); await Promise.race([oldResponse.promise, f.stopped]); }
      return { schemaVersion: 1, license: f.lease.token, pollAfterMs: 60000 };
    } },
    async observe() { return { schemaVersion: 1, results: [] }; },
    async sync() {
      if (++syncs === 1) { await pollStarted.promise; throw new CloudConnectionError('AUTHORIZATION_REJECTED'); }
      return { state: 'synced', sent: 0, pending: 0 };
    },
    wait(ms, signal) {
      const status = f.status();
      if (!released && status.licenseReason === 'revoked') denied.resolve();
      if (released && polls === 1) oldSettled.resolve(status);
      if (polls >= 2 && status.licenseReason === 'allowed') restored.resolve(status);
      return f.wait(ms, signal);
    },
  });
  await denied.promise; released = true; oldResponse.resolve();
  const afterOld = await oldSettled.promise;
  assert.equal(afterOld.licenseReason, 'revoked', 'Only a control request made after the rejection may restore permission.');
  assert.equal(afterOld.automation, 'paused'); assert.equal(syncs, 1);
  await f.advance(60000);
  assert.equal((await restored.promise).automation, 'active', 'A fresh authenticated control request can restore permission.');
  f.controller.abort(); await running;
});
