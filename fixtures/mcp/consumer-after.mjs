// Fictitious adapted boundary preserving the application's internal result.
export async function quote(client, sku, currency) {
  const response = await client.callTool({ name: 'quote', arguments: { sku, currencyCode: currency } });
  return { amount: response.structuredContent.amountMinor / 100, currency: response.structuredContent.currencyCode };
}
