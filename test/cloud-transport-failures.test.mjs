import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createCloudControlTransport, createCloudTransport, generateCloudWorkerIdentity } from '../dist/cloud-connection.js';

const opaque = () => randomBytes(32).toString('hex');
async function fixture(t) {
  const identity = await generateCloudWorkerIdentity(), requests = [];
  let failure;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); requests.push(request.url);
    if (request.url === `/api/worker/v1/${failure.endpoint}`) {
      response.writeHead(failure.status, { ...(failure.type ? { 'content-type': failure.type } : {}), 'retry-after': '60' });
      response.end(failure.body); return;
    }
    assert.equal(request.url, '/api/worker/v1/token');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: opaque(), token_type: 'DPoP', expires_in: 300, scope: new URLSearchParams(body).get('scope') }));
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  t.after(async () => { server.closeAllConnections(); await new Promise(accept => server.close(accept)); });
  const credentials = { ...identity, baseUrl: `http://127.0.0.1:${server.address().port}`, projectId: opaque(), clientSecret: opaque(), allowLocalHttp: true };
  return { requests, credentials, async attempt(value) {
    failure = value; requests.length = 0;
    if (value.endpoint === 'control') return createCloudControlTransport(credentials).poll({ schemaVersion: 1, requestId: randomUUID(),
      installationId: identity.installationId, projectId: credentials.projectId, runId: randomUUID(), observedRevision: 1, automation: 'active' });
    return createCloudTransport(credentials).send({ schemaVersion: 1, eventId: opaque(), installationId: identity.installationId,
      projectId: credentials.projectId, sequence: 0, recordedAt: new Date().toISOString(), body: { type: 'runner-status', state: 'idle', reason: 'none', pendingJobs: 0 } });
  } };
}
const bodies = [{ body: '' }, { type: 'text/html', body: '<html>Synthetic gateway failure</html>' },
  { type: 'application/json', body: '{"error":"synthetic failure"}' }];

for (const endpoint of ['token', 'control', 'status']) test(`${endpoint}: server failures stay temporary independently of the response body`, async t => {
  const f = await fixture(t);
  for (const status of [502, 503, 504]) for (const body of bodies) {
    await assert.rejects(f.attempt({ endpoint, status, ...body }), { code: 'NETWORK_UNAVAILABLE' });
    assert.equal(f.requests.filter(path => path === `/api/worker/v1/${endpoint}`).length, 1, 'Transport must not retry implicitly.');
  }
});

for (const endpoint of ['token', 'control', 'status']) test(`${endpoint}: authentication and rate-limit decisions do not require JSON`, async t => {
  const f = await fixture(t);
  for (const status of [401, 403, 429]) for (const body of bodies) {
    await assert.rejects(f.attempt({ endpoint, status, ...body }), { code: status === 429 ? 'RATE_LIMITED' : 'AUTHORIZATION_REJECTED' });
    assert.equal(f.requests.filter(path => path === `/api/worker/v1/${endpoint}`).length, 1);
  }
  for (const status of [400, 404]) await assert.rejects(f.attempt({ endpoint, status, ...bodies[2] }),
    { code: endpoint === 'token' ? 'AUTHORIZATION_REJECTED' : 'STATUS_REJECTED' });
});

for (const endpoint of ['token', 'control', 'status']) test(`${endpoint}: malformed successful responses remain invalid`, async t => {
  const f = await fixture(t);
  for (const body of [bodies[0], bodies[1], { type: 'application/json', body: '{invalid' },
    { type: 'application/json', body: JSON.stringify({ private: 'x'.repeat(16_384) }) }]) {
    await assert.rejects(f.attempt({ endpoint, status: 200, ...body }), { code: 'INVALID_RESPONSE' });
  }
});

test('body cancellation failure cannot turn a known authentication decision into a transient failure', async t => {
  const identity = await generateCloudWorkerIdentity();
  for (const status of [401, 403, 429, 503]) {
    let cancellations = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() {
      cancellations++; throw new Error('Synthetic cancellation failure');
    } }), { status }));
    try {
      const credentials = { ...identity, baseUrl: 'https://cloud.example.test', projectId: opaque(), clientSecret: opaque() };
      await assert.rejects(createCloudControlTransport(credentials).poll({ schemaVersion: 1, requestId: randomUUID(),
        installationId: identity.installationId, projectId: credentials.projectId, runId: randomUUID(), observedRevision: 1, automation: 'active' }),
      { code: status === 429 ? 'RATE_LIMITED' : status === 503 ? 'NETWORK_UNAVAILABLE' : 'AUTHORIZATION_REJECTED' });
      assert.equal(cancellations, 1);
    } finally { mock.mock.restore(); }
  }
});
