// Fictitious consumer boundary for a controlled local test; no MCP server is contacted.
export async function quote(client, sku, currency) {
  const response = await client.callTool({ name: 'quote', arguments: { sku, currency } });
  return { amount: response.structuredContent.totalCents / 100, currency: response.structuredContent.currency };
}
