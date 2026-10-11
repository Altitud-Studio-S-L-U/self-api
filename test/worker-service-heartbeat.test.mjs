import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { generateCloudWorkerIdentity, listLocalSubscriptions, normalizeWorkerServiceConfig, readWorkerServiceStatus,
  registerLocalSubscription, runWorkerService } from '../dist/index.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';

test('Cloud heartbeat remains serial and timely while a healthy observer is awaiting a slow source', { timeout: 45000 }, async t => {
  const controller = new AbortController();
  let release = () => {}, running;
  t.after(async () => { controller.abort(); release(); if (running) await running.catch(() => {}); });
  const parent = resolve('work/test-worker-heartbeat'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'case-'));
  checkWindowsPermissions([directory], true, directory);
  t.after(async () => { assert.equal(dirname(await realpath(directory)), await realpath(parent)); await rm(directory, { recursive: true }); });
  const consumerRoot = join(directory, 'consumer'), cloudStatePath = join(directory, 'cloud');
  await mkdir(consumerRoot); await mkdir(cloudStatePath, { mode: 0o700 });
  await writeFile(join(consumerRoot, 'orders.mjs'), "export const orders = () => fetch('https://orders.example.invalid/orders');\n");
  const sourcePath = join(directory, 'source.json');
  await writeFile(sourcePath, await readFile('fixtures/orders-v1.json'));
  const enginePath = resolve('work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
  const statePath = join(directory, 'state');
  const subscription = await registerLocalSubscription({ statePath, sourcePath, baselinePath: sourcePath, consumerRoot,
    providerBaseUrl: 'https://orders.example.invalid', enginePath });
  const identity = await generateCloudWorkerIdentity(), credentialsPath = join(directory, 'credentials.json');
  await writeFile(credentialsPath, JSON.stringify({ baseUrl: 'http://127.0.0.1:1', allowLocalHttp: true,
    installationId: identity.installationId, projectId: 'b'.repeat(64), clientSecret: 'c'.repeat(64), privateJwk: identity.privateJwk }), { mode: 0o600 });
  const config = normalizeWorkerServiceConfig({ schemaVersion: 1, statePath, openApi: { enginePath, intervalMs: 1000 },
    cloud: { statePath: cloudStatePath, credentialsPath, integrationIds: [subscription.id], intervalMs: 3600000 } });
  let elapsed = 0;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-10-11T12:00:00Z') });
  t.mock.method(performance, 'now', () => elapsed);
  const waits = new Set();
  const advance = ms => {
    elapsed += ms; t.mock.timers.tick(ms);
    for (const waiting of [...waits]) if (waiting.due <= elapsed) waiting.finish();
  };
  const wait = (milliseconds, signal) => new Promise((done, reject) => {
    const cancel = () => { waits.delete(waiting); reject(new DOMException('Cancelled', 'AbortError')); };
    const waiting = { due: elapsed + milliseconds, finish: () => {
      waits.delete(waiting); signal.removeEventListener('abort', cancel); done();
    } };
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    waits.add(waiting); signal.addEventListener('abort', cancel, { once: true });
  });
  const flush = () => new Promise(done => setImmediate(done));
  const slow = new Promise(done => { release = done; });
  let entered; const pending = new Promise(done => { entered = done; });
  let firstSent; const initial = new Promise(done => { firstSent = done; });
  let observations = 0, syncs = 0, activeSyncs = 0, maximumActiveSyncs = 0, activeObserver = false, lastSeen;
  running = runWorkerService(config, { signal: controller.signal, dependencies: {
    wait,
    async observe() {
      observations++;
      if (observations === 2) { activeObserver = true; entered(); await slow; activeObserver = false; }
      return { schemaVersion: 1, results: [{ subscriptionId: subscription.id, status: 'unchanged' }] };
    },
    async sync() {
      activeSyncs++; maximumActiveSyncs = Math.max(maximumActiveSyncs, activeSyncs);
      syncs++; lastSeen = Date.now(); await flush(); activeSyncs--;
      if (syncs === 1) firstSent();
      return { state: 'synced', sent: 1, pending: 0 };
    },
  } });
  await initial; await flush();
  assert.equal(readWorkerServiceStatus(config).observation, 'healthy');
  advance(1000); await pending;
  advance(59000); await flush(); await flush();
  assert.equal(activeObserver, true); assert.equal(syncs, 2, 'The due contact must not await source completion.');
  advance(30001); await flush();
  assert.equal(Date.now() - lastSeen, 30001, 'The fresh contact remains inside the 90-second Cloud projection window.');
  assert.equal(readWorkerServiceStatus(config).cloud, 'synced'); assert.equal(maximumActiveSyncs, 1);
  const registered = (await listLocalSubscriptions({ statePath }))[0];
  assert.equal(registered.lastSucceededAt, null, 'A heartbeat must not fabricate fresh provider evidence.');
  controller.abort(); release();
  assert.equal((await running).state, 'stopped'); assert.equal(activeSyncs, 0);
});
