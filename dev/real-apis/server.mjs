import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client as LegacyNotion } from 'notion-v4';
import { defineIntegrationBoundary, getIntegrationBoundary } from 'plumber';
import { providers, providerManifest } from './catalog.mjs';

export const fixtureContext = Object.freeze({ databaseId: '00000000-0000-4000-8000-000000000001',
  dataSourceId: '00000000-0000-4000-8000-000000000002', token: 'keepseam-fixture-not-a-secret' });
export const pageResponse = Object.freeze({ results: [{ object: 'page', id: 'local-page-one' }], has_more: true, next_cursor: 'local-next-cursor' });

export function simulatedNotion(url, init, version) {
  const request = new URL(url);
  const headers = new Headers(init?.headers);
  const modern = version === '2025-09-03';
  if (request.origin !== 'https://api.notion.com' || init?.method?.toUpperCase() !== 'POST') throw new Error('Lab transport denied unexpected request');
  if (headers.get('authorization') !== `Bearer ${fixtureContext.token}`) return Response.json({ object: 'error', code: 'unauthorized', message: 'Fixture token required' }, { status: 401 });
  const expectedPath = modern ? `/v1/data_sources/${fixtureContext.dataSourceId}/query` : `/v1/databases/${fixtureContext.databaseId}/query`;
  if (request.pathname !== expectedPath || headers.get('notion-version') !== version) {
    return Response.json({ object: 'error', code: 'validation_error', message: 'Locally forced contract change (not a claim of a provider shutdown)' }, { status: 410 });
  }
  const body = JSON.parse(init.body);
  if (body.page_size !== 20) return Response.json({ object: 'error', code: 'validation_error', message: 'Fixture page size required' }, { status: 400 });
  return Response.json(pageResponse);
}

export async function serve(paths) {
  const notion = await import(pathToFileURL(join(paths.consumer, 'notion.mjs')).href);
  const manifests = providers.map(providerManifest);
  const native = defineIntegrationBoundary(manifests.find(value => value.provider === 'Notion'), notion.queryNative);
  const realFetch = globalThis.fetch;
  const version = async () => JSON.parse(await readFile(join(paths.contracts, 'notion-current.json'), 'utf8')).info.version;
  // This development process has a closed transport. Unknown requests never fall through to the internet.
  const localTransport = async (url, init) => {
    const target = new URL(url);
    if (target.origin === 'https://api.notion.com' && target.pathname.includes('/query')) {
      return realFetch(`http://127.0.0.1:43230/upstream/notion${target.pathname}`, { ...init, redirect: 'error' });
    }
    const provider = providers.find(value => value.origin + value.path === target.href && value.method === (init?.method ?? 'GET').toUpperCase());
    if (!provider) throw new Error('Lab transport denied unexpected request');
    return Response.json({ simulated: true, provider: provider.id, configuredVersion: provider.version, businessOperationExecuted: false });
  };
  globalThis.fetch = localTransport;
  const sdk = new LegacyNotion({ auth: fixtureContext.token, notionVersion: '2022-06-28', fetch: localTransport, logger: () => {} });
  const server = createServer(async (request, response) => {
    const send = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(payload)); };
    try {
      const url = new URL(request.url, 'http://127.0.0.1:43230');
      if (request.method === 'POST' && url.pathname.startsWith('/upstream/notion/')) {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) { send(413, { error: 'body-limit' }); return; } chunks.push(chunk); }
        const result = simulatedNotion(`https://api.notion.com${url.pathname.slice('/upstream/notion'.length)}`, {
          method: 'POST', headers: request.headers, body: Buffer.concat(chunks).toString('utf8'),
        }, await version());
        send(result.status, await result.json()); return;
      }
      if (request.method !== 'GET') { send(405, { error: 'read-only-lab-interface' }); return; }
      if (url.pathname === '/health') { send(200, { status: 'ok', simulatedProvider: true, version: await version() }); return; }
      if (url.pathname === '/integrations') { send(200, { simulated: true, integrations: providers.map(({ id, name, version }) => ({ id, name, version })), boundary: getIntegrationBoundary(native) }); return; }
      if (url.pathname === '/notion/native') { send(200, { simulated: true, result: await native(fixtureContext) }); return; }
      if (url.pathname === '/notion/sdk') { send(200, { simulated: true, result: await notion.querySdk(sdk, fixtureContext) }); return; }
      const provider = providers.find(value => url.pathname === `/integrations/${value.id}`);
      if (!provider) { send(404, { error: 'unknown-lab-route' }); return; }
      const adapter = await import(pathToFileURL(join(paths.consumer, 'adapters', `${provider.id}.mjs`)).href);
      send(200, await adapter.call());
    } catch { send(502, { error: 'simulated-upstream-failed', simulated: true, next: 'Review the local worker job and its proposed migration' }); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43230, '127.0.0.1', resolve); });
  process.stdout.write('Simulated consumer API: http://127.0.0.1:43230/integrations (native and actual legacy Notion SDK). No provider API calls.\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); globalThis.fetch = realFetch; });
  return server;
}
