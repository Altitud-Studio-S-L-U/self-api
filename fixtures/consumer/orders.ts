// Fictional integration; this file is inspected as data, never imported by discovery.
type ProviderOrder = { id: string; total: number };
export type Order = { reference: string; total: number };

export async function getOrder(id: string): Promise<Order> {
  const response = await fetch(`https://orders.example.invalid/orders/${encodeURIComponent(id)}`);
  const order: ProviderOrder = await response.json();
  return { reference: order.id, total: order.total };
}
