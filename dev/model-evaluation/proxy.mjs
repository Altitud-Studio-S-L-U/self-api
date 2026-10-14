// Development-only fixed-upstream relay. The inference container remains on
// its internal network; Docker Desktop cannot publish an internal-network port.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const upstream = process.env.KEEPSEAM_MODEL_UPSTREAM;
assert.match(upstream ?? '', /^http:\/\/172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}:8080$/u);
const maximumBytes = 2 * 1024 * 1024;
createServer({ maxHeaderSize: 8192, requestTimeout: 150000, headersTimeout: 10000 }, async (request, response) => {
  if (!((request.method === 'GET' && request.url === '/health')
    || (request.method === 'POST' && request.url === '/v1/chat/completions' && request.headers['content-type']?.split(';')[0] === 'application/json'))) {
    response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"unsupported request"}'); return;
  }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
  request.once('aborted', () => controller.abort());
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  try {
    const chunks = []; let length = 0;
    for await (const bytes of request) {
      length += bytes.length; if (length > maximumBytes) throw new Error('input limit'); chunks.push(bytes);
    }
    const result = await fetch(upstream + request.url, { method: request.method, redirect: 'error', signal: controller.signal,
      ...(request.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) } : {}) });
    if (result.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('invalid content type');
    const output = []; length = 0;
    for await (const bytes of result.body) {
      length += bytes.length; if (length > maximumBytes) throw new Error('output limit'); output.push(bytes);
    }
    const bytes = Buffer.concat(output);
    response.writeHead(result.status, { 'content-type': 'application/json', 'content-length': bytes.length }); response.end(bytes);
  } catch {
    controller.abort();
    if (!response.headersSent && !response.destroyed) { response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":"local model unavailable"}'); }
  } finally { clearTimeout(timer); }
}).listen(8080, '0.0.0.0');
