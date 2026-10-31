export function pageIds(response) {
  if (!response || !Array.isArray(response.results) || typeof response.has_more !== 'boolean'
    || !(response.next_cursor === null || typeof response.next_cursor === 'string')
    || response.results.some(page => page?.object !== 'page' || typeof page.id !== 'string')) {
    throw new Error('Invalid Notion page response');
  }
  return { ids: response.results.map(page => page.id), hasMore: response.has_more, nextCursor: response.next_cursor };
}

export async function queryNative(context) {
  const response = await fetch(`https://api.notion.com/v1/databases/${encodeURIComponent(context.databaseId)}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${context.token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_size: 20 }),
  });
  if (!response.ok) throw new Error(`Notion query failed: ${response.status}`);
  return pageIds(await response.json());
}

// The actual SDK is supplied by the application. SelfManagedApi metadata does not wrap its behavior.
export async function querySdk(notion, context) {
  return pageIds(await notion.databases.query({ database_id: context.databaseId, page_size: 20 }));
}
