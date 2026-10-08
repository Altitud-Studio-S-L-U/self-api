import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryNative, querySdk, pageIds } from './notion.mjs';

const context = { databaseId: 'database-demo', dataSourceId: 'source-demo', token: 'fixture-only' };
const response = { results: [{ object: 'page', id: 'page-demo' }], has_more: true, next_cursor: 'cursor-demo' };
const expected = { ids: ['page-demo'], hasMore: true, nextCursor: 'cursor-demo' };

test('native query selects the configured data source and preserves pagination', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.notion.com/v1/data_sources/source-demo/query');
    assert.equal(options.headers['Notion-Version'], '2025-09-03');
    assert.equal(options.headers.Authorization, 'Bearer fixture-only');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { page_size: 20 });
    return Response.json(response);
  });
  assert.deepEqual(await queryNative(context), expected);
});

test('SDK port requires an explicit source ID and preserves the same domain output', async () => {
  const port = { dataSources: { query: async input => {
    assert.deepEqual(input, { data_source_id: 'source-demo', page_size: 20 });
    return response;
  } } };
  assert.deepEqual(await querySdk(port, context), expected);
});

test('HTTP failures cannot be parsed into successful results', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'fixture rejection' }, { status: 429 }));
  await assert.rejects(queryNative(context), /429/);
});

test('partial or unexpected payloads fail rather than hiding data loss', () => {
  for (const invalid of [null, {}, { ...response, has_more: undefined }, { ...response, results: [{ id: 'x' }] },
    { ...response, next_cursor: 123 }]) assert.throws(() => pageIds(invalid), /Invalid/);
  assert.deepEqual(pageIds({ results: [], has_more: false, next_cursor: null }), { ids: [], hasMore: false, nextCursor: null });
});
