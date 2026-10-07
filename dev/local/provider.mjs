import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createProviderServer({ statePath }) {
  return createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method !== 'GET') { send(405, { error: 'read-only-fictional-provider' }); return; }
      const url = new URL(request.url, 'http://127.0.0.1:43127');
      const contract = JSON.parse(await readFile(join(statePath, 'current.json'), 'utf8'));
      const version = contract.info.version;
      if (!['2026-01', '2026-02'].includes(version)) throw new Error('Invalid development contract.');
      if (url.pathname === '/health') { send(200, { status: 'ok', fictional: true, version }); return; }
      if (url.pathname === '/openapi.json') { send(200, contract); return; }
      const match = /^\/payments\/([^/]+)$/u.exec(url.pathname);
      if (!match) { send(404, { error: 'unknown-route' }); return; }
      if (request.headers.authorization !== 'Bearer fixture-payments-token') { send(401, { error: 'fixture-token-required' }); return; }
      if (request.headers['x-api-version'] !== version) { send(410, { error: 'api-version-retired', version }); return; }
      const currency = url.searchParams.get('currency');
      if (version === '2026-02' && !['EUR', 'USD'].includes(currency)) { send(400, { error: 'currency-required' }); return; }
      const payments = JSON.parse(await readFile(join(statePath, 'payments.json'), 'utf8'));
      const payment = payments.find(value => value.id === decodeURIComponent(match[1]));
      if (!payment) { send(404, { error: 'payment-not-found' }); return; }
      if (version === '2026-02' && currency !== payment.currency) { send(409, { error: 'currency-mismatch' }); return; }
      if (version === '2026-01') { send(200, { id: payment.id, totalCents: payment.amountMinor, currency: payment.currency }); return; }
      const minor = BigInt(payment.amountMinor);
      send(200, { id: payment.id, amount: { value: `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`, currency_code: payment.currency } });
    } catch {
      send(500, { error: 'development-provider-state-unavailable' });
    }
  });
}

if (import.meta.main) {
  if (process.env.PLUMBER_FICTIONAL_DEV !== 'true' || !process.env.PLUMBER_PROVIDER_STATE) {
    throw new Error('This server requires the explicit fictional development configuration.');
  }
  const server = createProviderServer({ statePath: process.env.PLUMBER_PROVIDER_STATE });
  server.listen(43127, '0.0.0.0', () => process.stdout.write('Fictional read-only payments provider listening on 43127.\n'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
}
