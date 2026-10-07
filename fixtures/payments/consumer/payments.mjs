// Fictional, read-only payments adapter. The application already supplies currency and accessToken.
export function parsePayment(payment, expectedCurrency) {
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)
    || typeof payment.id !== 'string' || payment.id.length === 0
    || !['EUR', 'USD'].includes(expectedCurrency) || payment.currency !== expectedCurrency
    || !Number.isSafeInteger(payment.totalCents) || payment.totalCents < 0) {
    throw new Error('Invalid payment response.');
  }
  return { reference: payment.id, amountMinor: payment.totalCents, currency: payment.currency };
}

export async function getPayment(id, context) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 100
    || !context || !['EUR', 'USD'].includes(context.currency)
    || typeof context.accessToken !== 'string' || !/^[A-Za-z0-9._-]{1,512}$/u.test(context.accessToken)) {
    throw new Error('Invalid payment request.');
  }
  const response = await fetch(`http://127.0.0.1:43127/payments/${encodeURIComponent(id)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${context.accessToken}`,
      'X-Api-Version': '2026-01',
    },
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    const error = new Error(`Payment request failed (${response.status}).`);
    error.status = response.status;
    if (response.status === 429) error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  let payment;
  try { payment = await response.json(); }
  catch { throw new Error('Invalid payment response.'); }
  return parsePayment(payment, context.currency);
}
