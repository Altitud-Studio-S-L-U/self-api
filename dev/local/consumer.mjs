import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createConsumerServer({ getPayment }) {
  return createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET') { send(405, { error: 'read-only-development-consumer' }); return; }
    const url = new URL(request.url, 'http://127.0.0.1:43128');
    if (url.pathname === '/health') { send(200, { status: 'ok', fictional: true }); return; }
    const match = /^\/payments\/([^/]+)$/u.exec(url.pathname);
    if (!match) { send(404, { error: 'unknown-route' }); return; }
    const currency = url.searchParams.get('currency');
    if (!['EUR', 'USD'].includes(currency)) { send(400, { error: 'currency-required' }); return; }
    try {
      const payment = await getPayment(decodeURIComponent(match[1]), { currency, accessToken: 'fixture-payments-token' });
      send(200, payment);
    } catch (error) {
      send(502, { error: 'payment-integration-failed', upstreamStatus: Number.isInteger(error?.status) ? error.status : null });
    }
  });
}

if (import.meta.main) {
  if (process.env.PLUMBER_FICTIONAL_DEV !== 'true' || !process.env.PLUMBER_CONSUMER_ROOT) {
    throw new Error('This server requires the explicit fictional development configuration.');
  }
  const { getPayment } = await import(pathToFileURL(join(process.env.PLUMBER_CONSUMER_ROOT, 'payments.mjs')).href);
  const server = createConsumerServer({ getPayment });
  server.listen(43128, '0.0.0.0', () => process.stdout.write('Fictional consumer listening on 43128. Restart after editing its source.\n'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
}
