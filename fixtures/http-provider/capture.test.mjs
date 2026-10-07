import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { captureHttpSource, prepareHttpSource, HttpSourceError } from './http-source.js';

const hostname = 'payments.plumber.test';
const origin = `https://${hostname}`;
const pinnedAddress = '8.8.8.8'; // Synthetic DNS evidence; the fixture never connects to this address.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requests = [];
const sockets = new Map();
let certificate, server, port, version = 1, connections = 0;

function contract() {
  const amount = version === 1 ? 'totalMinor' : 'amountMinor';
  return Buffer.from(JSON.stringify({ openapi: '3.0.3', info: { title: 'Fictional payments fixture', version: String(version) },
    paths: { '/payments/{id}': { get: { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Fictional payment; amounts remain in minor units.', content: { 'application/json': {
        schema: { type: 'object', required: ['id', amount], properties: { id: { type: 'string' }, [amount]: { type: 'integer' } } },
      } } } } } } } }));
}

before(async () => {
  const key = await readFile(new URL('./server.key', import.meta.url));
  certificate = await readFile(new URL('./server.crt', import.meta.url));
  server = createServer({ key, cert: certificate }, (request, response) => {
    requests.push({ path: request.url, headers: { ...request.headers } });
    const path = request.url;
    if (path === '/stall-headers') return;
    if (path === '/stall-body') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"pending":');
      return;
    }
    if (path === '/redirect') {
      response.writeHead(302, { Location: 'https://unapproved.plumber.test/private' });
      response.end('fictional-private-body');
      return;
    }
    if (path === '/unauthorized' || path === '/unavailable') {
      response.writeHead(path === '/unauthorized' ? 401 : 503, { 'Content-Type': 'text/plain' });
      response.end('fictional-private-body');
      return;
    }
    if (path === '/compressed') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      response.end(gzipSync(Buffer.from('{}')));
      return;
    }
    if (path === '/large' || path === '/large-chunked') {
      const body = Buffer.from(JSON.stringify({ fixture: 'x'.repeat(1024) }));
      response.writeHead(200, { 'Content-Type': 'application/json', ...(path === '/large' ? { 'Content-Length': body.length } : {}) });
      if (path === '/large-chunked') response.write(body.subarray(0, 32));
      response.end(path === '/large-chunked' ? body.subarray(32) : body);
      return;
    }
    if (path !== '/openapi.json') { response.writeHead(404); response.end(); return; }
    const etag = `"payments-v${version}"`;
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag }); response.end(); return; }
    const body = contract();
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ETag: etag,
      'Last-Modified': version === 1 ? 'Thu, 01 Jan 2026 00:00:00 GMT' : 'Fri, 02 Jan 2026 00:00:00 GMT' });
    response.end(body);
  });
  server.on('connection', socket => {
    connections += 1;
    const closed = new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve(); }));
    sockets.set(socket, closed);
  });
  server.on('tlsClientError', () => { /* TLS rejection is an expected fixture case; do not print handshake errors. */ });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
});

after(async () => {
  if (!server) return;
  server.closeAllConnections();
  for (const socket of sockets.keys()) socket.destroy();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function policy(path = '/openapi.json', overrides = {}) {
  return prepareHttpSource({ url: `${origin}${path}`, allowedOrigins: [origin], contentKind: 'json', timeoutMs: 5000, ...overrides });
}

function fixtureDependencies({ ca, expectedHostname = hostname, onRequest = () => {} } = {}) {
  return {
    resolve: async name => { assert.equal(name, expectedHostname); return [{ address: pinnedAddress, family: 4 }]; },
    request(url, options, callback) {
      onRequest();
      assert.equal(url.protocol, 'https:');
      assert.equal(url.hostname, expectedHostname);
      assert.equal(url.port, '');
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.servername, expectedHostname);
      assert.equal(options.agent, false);
      assert.equal(options.autoSelectFamily, false);
      assert.equal(options.maxHeaderSize, 8192);
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      let pinned = false;
      options.lookup(expectedHostname, { all: false }, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, pinnedAddress);
        assert.equal(family, 4);
        pinned = true;
      });
      assert.equal(pinned, true);
      // This trusted fixture changes only socket routing and CA trust. Production SSRF rules remain intact.
      return httpsRequest(url, { ...options, port, ca: ca ?? certificate,
        lookup(name, lookupOptions, done) {
          assert.equal(name, expectedHostname);
          if (lookupOptions.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
          else done(null, '127.0.0.1', 4);
        },
      }, callback);
    },
  };
}

function reason(expected) {
  return error => error instanceof HttpSourceError && error.reason === expected && !error.message.includes('fictional-private');
}

async function drained() {
  await Promise.race([Promise.all([...sockets.values()]), delay(1500, undefined, { ref: false }).then(() => {
    assert.fail('The HTTP capture left a fixture connection open.');
  })]);
  assert.equal(sockets.size, 0);
}

test('real TLS captures exact contract bytes, reuses 304 evidence, and observes v2 without mutating v1', async () => {
  const source = policy();
  const start = requests.length;
  const first = await captureHttpSource({ source }, fixtureDependencies());
  assert.equal(first.status, 'captured');
  assert.deepEqual(Buffer.from(first.snapshot.bytes), contract());
  assert.equal(first.snapshot.sha256, hash(contract()));
  assert.equal(first.snapshot.etag, '"payments-v1"');
  const original = Buffer.from(first.snapshot.bytes);
  const repeated = await captureHttpSource({ source, previous: first.snapshot }, fixtureDependencies());
  assert.equal(repeated.status, 'not-modified');
  assert.deepEqual(Buffer.from(repeated.snapshot.bytes), original);
  assert.equal(repeated.snapshot.capturedAt, first.snapshot.capturedAt);
  assert.equal(requests.at(-1).headers['if-none-match'], '"payments-v1"');
  version = 2;
  const updated = await captureHttpSource({ source, previous: repeated.snapshot }, fixtureDependencies());
  assert.equal(updated.status, 'captured');
  assert.equal(updated.snapshot.etag, '"payments-v2"');
  assert.notEqual(updated.snapshot.sha256, first.snapshot.sha256);
  assert.deepEqual(Buffer.from(updated.snapshot.bytes), contract());
  assert.deepEqual(Buffer.from(first.snapshot.bytes), original);
  assert.equal(requests.length - start, 3);
  await drained();
});

test('real TLS rejects an unrelated CA and an incorrect certificate hostname', async () => {
  const beforeRequests = requests.length;
  const beforeConnections = connections;
  assert.ok(rootCertificates.length > 0);
  await assert.rejects(captureHttpSource({ source: policy() }, fixtureDependencies({ ca: rootCertificates[0] })), reason('request-failed'));
  await drained();
  const other = 'different-payments.plumber.test';
  const source = policy('/openapi.json', { url: `https://${other}/openapi.json`, allowedOrigins: [`https://${other}`] });
  await assert.rejects(captureHttpSource({ source }, fixtureDependencies({ expectedHostname: other })), reason('request-failed'));
  await drained();
  assert.equal(requests.length, beforeRequests, 'Rejected TLS must never reach the HTTP handler.');
  assert.equal(connections - beforeConnections, 2, 'Both failures must attempt an actual TLS connection.');
});

test('real redirects, authorization failures, server failures and compression are rejected without retries', async () => {
  for (const [path, expected] of [['/redirect', 'redirect-denied'], ['/unauthorized', 'http-status'],
    ['/unavailable', 'http-status'], ['/compressed', 'compressed-response']]) {
    const start = requests.length;
    await assert.rejects(captureHttpSource({ source: policy(path) }, fixtureDependencies()), reason(expected));
    assert.equal(requests.length - start, 1);
    assert.equal(requests.at(-1).path, path);
    await drained();
  }
});

test('real content-length and streamed-body limits reject excess bytes and close the connection', async () => {
  for (const path of ['/large', '/large-chunked']) {
    const start = requests.length;
    await assert.rejects(captureHttpSource({ source: policy(path, { maximumBytes: 64 }) }, fixtureDependencies()), reason('response-too-large'));
    assert.equal(requests.length - start, 1);
    await drained();
  }
});

test('real stalled headers and bodies reach the deadline without retrying or leaving sockets open', async () => {
  for (const path of ['/stall-headers', '/stall-body']) {
    const start = requests.length;
    await assert.rejects(captureHttpSource({ source: policy(path, { timeoutMs: 2000 }) }, fixtureDependencies()), reason('deadline-exceeded'));
    assert.equal(requests.length - start, 1);
    await drained();
  }
});

test('an explicit abort closes a real stalled TLS response', async () => {
  const controller = new AbortController();
  const deps = fixtureDependencies();
  const constructor = deps.request;
  deps.request = (url, options, callback) => constructor(url, options, response => {
    callback(response);
    queueMicrotask(() => controller.abort());
  });
  const start = requests.length;
  await assert.rejects(captureHttpSource({ source: policy('/stall-body'), signal: controller.signal }, deps), reason('aborted'));
  assert.equal(requests.length - start, 1);
  await drained();
});

test('production SSRF validation denies loopback before credentials or even the trusted fixture constructor', async () => {
  const source = policy('/openapi.json', { authContextId: 'fixture-scope' });
  const start = requests.length;
  let credentials = 0, constructors = 0;
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }],
    [{ address: pinnedAddress, family: 4 }, { address: '127.0.0.1', family: 4 }]]) {
    const deps = fixtureDependencies({ onRequest: () => { constructors += 1; } });
    deps.resolve = async () => addresses;
    await assert.rejects(captureHttpSource({ source, credentials: { origin, authContextId: 'fixture-scope',
      getAuthorization: () => { credentials += 1; return 'Bearer fictional-private-token'; } } }, deps), reason('address-denied'));
  }
  assert.equal(credentials, 0);
  assert.equal(constructors, 0);
  assert.equal(requests.length, start);
  await drained();
});
