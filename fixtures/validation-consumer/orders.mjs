// Fictional consumer: context.region already exists in the application's input contract.
export async function getOrder(id, context) {
  const response = await fetch(`https://orders.example.invalid/orders/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Order request failed (${response.status})`);
  const order = await response.json();
  if (typeof order.id !== 'string' || typeof order.total !== 'number' || !Number.isFinite(order.total)) {
    throw new Error('Invalid order response.');
  }
  return { reference: order.id, total: order.total };
}
