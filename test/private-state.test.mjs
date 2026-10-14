import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { generateCloudWorkerIdentity, listSourceSubscriptions, registerSourceSubscription, syncWorkerToCloud } from '../dist/index.js';
import { openWorkerStore } from '../dist/worker-store.js';

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

test('Cloud synchronization refuses public state and outbox files before transport and preserves evidence', async t => {
  const directory = await fixture(t), consumerRoot = join(directory, 'consumer'); await mkdir(consumerRoot);
  const statePath = join(directory, 'state'), cloudStatePath = join(directory, 'cloud'), subscriptionId = 'a'.repeat(64);
  const bytes = Buffer.from(JSON.stringify({ openapi: '3.0.3', info: { title: 'Private-state fixture', version: '1' }, paths: {} }));
  const store = await openWorkerStore(statePath);
  try { store.register({ id: subscriptionId, label: 'Private-state fixture', sourcePath: join(directory, 'source.json'), consumerRoot,
    providerBaseUrl: 'https://example.invalid', baseline: { bytes, metadata: { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, specificationVersion: '3.0.3', apiVersion: '1' } } }); }
  finally { store.close(); }
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++; const chunks = []; for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/api/worker/v1/token') response.end(JSON.stringify({ access_token: 'b'.repeat(64), token_type: 'DPoP', expires_in: 300, scope: 'worker:status' }));
    else { const event = JSON.parse(Buffer.concat(chunks)); response.end(JSON.stringify({ eventId: event.eventId, sequence: event.sequence, status: 'accepted' })); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => server.close(done)));
  const identity = await generateCloudWorkerIdentity(), credentials = { ...identity, baseUrl: `http://127.0.0.1:${server.address().port}`,
    projectId: 'c'.repeat(64), clientSecret: 'd'.repeat(64), allowLocalHttp: true };
  const options = { statePath, cloudStatePath, credentials, integrationIds: [subscriptionId] };
  assert.equal((await syncWorkerToCloud(options)).state, 'synced');
  const database = join(cloudStatePath, 'cloud.sqlite3');
  for (const path of [cloudStatePath, database]) {
    const before = await readFile(database), exposure = await exposeRead(path), calls = requests;
    try {
      const permissions = await exposure.permissions();
      await assert.rejects(syncWorkerToCloud(options), { code: 'INVALID_INPUT' });
      assert.equal(requests, calls); assert.equal(await exposure.permissions(), permissions); assert.deepEqual(await readFile(database), before);
    } finally { await exposure.restore(); }
    assert.equal((await syncWorkerToCloud(options)).state, 'synced');
  }
});
