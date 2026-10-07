import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { analyzeMcpImpact } from '../dist/mcp-impact.js';
import { compareMcpCatalogs } from '../dist/mcp-catalog.js';

const parent = resolve('work/test-mcp-impact');
const sourceName = 'src/quote.mjs';
const baseFixture = resolve('fixtures/mcp/catalog-before.json');
const revisionFixture = resolve('fixtures/mcp/catalog-after.json');
const beforeConsumer = await readFile(resolve('fixtures/mcp/consumer-before.mjs'), 'utf8');
const binding = (file = sourceName, receiver = 'client') => ({ file, receiver, serverId: 'fictional-commerce-tools', authContextId: 'fixture-team-reader' });
const call = "client.callTool({ name: 'quote', arguments: { sku: 'fixture', currency: 'EUR' } })";
async function fixture(t, source = beforeConsumer, file = sourceName) {
  await mkdir(parent, { recursive: true });
  const canonical = await realpath(parent);
  const directory = await mkdtemp(join(canonical, 'impact-'));
  t.after(async () => {
    const target = await realpath(directory);
    assert.equal(dirname(target), canonical);
    assert.ok(basename(target).startsWith('impact-'));
    await rm(target, { recursive: true });
  });
  const consumerRoot = join(directory, 'consumer');
  await mkdir(dirname(join(consumerRoot, file)), { recursive: true });
  await writeFile(join(consumerRoot, file), source);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'must-not-execute' } }));
  const basePath = join(directory, 'base.json');
  const revisionPath = join(directory, 'revision.json');
  await writeFile(basePath, await readFile(baseFixture));
  await writeFile(revisionPath, await readFile(revisionFixture));
  return { options: { consumerRoot, basePath, revisionPath, bindings: [binding(file)] }, sourceFile: join(consumerRoot, file) };
}

test('fixture request and output changes map to the bound call and parser reads', async (t) => {
  const { options, sourceFile } = await fixture(t);
  const before = await readFile(sourceFile);
  const report = await analyzeMcpImpact(options);
  assert.equal(report.context, 'consistent');
  assert.equal(report.comparison.status, 'breaking-changes');
  assert.equal(report.inventory.calls.length, 1);
  const usage = report.inventory.calls[0];
  assert.equal(usage.resolution, 'bound');
  assert.equal(usage.reason, null);
  assert.equal(usage.toolName, 'quote');
  assert.equal(usage.location.file, sourceName);
  assert.deepEqual(usage.inputFields, ['currency', 'sku']);
  assert.deepEqual(usage.responseFields, ['/currency', '/totalCents']);
  assert.equal(usage.parserTrace, 'direct-reads');
  assert.equal(usage.parserLocations.length, 2);
  assert.equal(report.matches.length, 2);
  for (const match of report.matches) {
    assert.deepEqual(match.callIds, [usage.id]);
    assert.equal(match.parserLocations.length, 2);
  }
  assert.deepEqual(report.unmappedChangeIndexes, []);
  assert.deepEqual(report.unresolvedCallIds, []);
  assert.equal(report.conclusion, 'review-required');
  assert.equal(report.authorization, 'not-granted');
  assert.equal(report.inventory.codeExecuted, false);
  assert.equal(JSON.stringify(report).includes(beforeConsumer), false);
  assert.deepEqual(await readFile(sourceFile), before);
  const repeated = await analyzeMcpImpact(options);
  assert.equal(repeated.inventory.digest, report.inventory.digest);
  assert.equal(repeated.inventory.calls[0].id, usage.id);
});

test('precomputed comparisons require matching captured catalog digests', async (t) => {
  const { options } = await fixture(t);
  const comparison = await compareMcpCatalogs(options);
  assert.equal((await analyzeMcpImpact({ ...options, comparison })).comparison, comparison);
  await writeFile(options.revisionPath, (await readFile(options.revisionPath, 'utf8')) + '\n');
  await assert.rejects(analyzeMcpImpact({ ...options, comparison }), { code: 'INVALID_INPUT' });
});

test('missing or mismatched bindings never infer a live server connection', async (t) => {
  const { options } = await fixture(t);
  for (const bindings of [undefined, [], [{ ...binding(), serverId: 'other' }], [{ ...binding(), authContextId: 'other' }], [binding('src/absent.mjs')]]) {
    const report = await analyzeMcpImpact({ ...options, bindings });
    assert.equal(report.inventory.calls[0].resolution, 'unresolved');
    assert.deepEqual(report.matches, []);
    assert.equal(report.unmappedChangeIndexes.length, 2);
  }
  assert.ok((await analyzeMcpImpact({ ...options, bindings: [binding('src/absent.mjs')] })).inventory.issues.some((issue) => issue.code === 'binding-file-not-captured'));
});

test('changed server, auth, protocol, capabilities or completeness prevents mapping', async (t) => {
  for (const [field, value] of [['authContextId', 'other'], ['serverId', 'other'], ['protocolVersion', 'other'], ['capabilities', { tools: {} }], ['completeness', 'partial'], ['completeness', 'failed']]) await t.test(field + ':' + JSON.stringify(value), async (t) => {
    const { options } = await fixture(t);
    const revision = JSON.parse(await readFile(options.revisionPath, 'utf8'));
    revision[field] = value;
    await writeFile(options.revisionPath, JSON.stringify(revision));
    const report = await analyzeMcpImpact(options);
    assert.equal(report.context, 'inconclusive');
    assert.equal(report.inventory.calls[0].reason, 'catalog-context-inconclusive');
    assert.deepEqual(report.matches, []);
  });
});

test('named imports, typed parameters and commonjs receivers support exact file bindings', async (t) => {
  for (const [file, source] of [
    ['src/quote.mjs', `import { client } from './missing.mjs'; const response = await ${call}; export const value = response.structuredContent.totalCents;`],
    ['src/quote.mjs', `import { exportedClient as client } from './missing.mjs'; const response = await ${call}; export const value = response.structuredContent.totalCents;`],
    ['src/quote.ts', `import type { Client } from './missing'; export async function quote(client: Client) { const response = await ${call}; return response.structuredContent.totalCents; }`],
    ['src/quote.ts', "export async function quote(client: Client) { const response = (await (client as Client).callTool({ name: `quote`, arguments: {} })) as Reply; return response!.structuredContent.totalCents; }"],
    ['src/quote.cjs', `const client = require('./missing'); async function quote() { const response = await ${call}; return response.structuredContent.totalCents; }`],
  ]) await t.test(source.slice(0, 30), async (t) => {
    const { options } = await fixture(t, source, file);
    const report = await analyzeMcpImpact(options);
    assert.equal(report.inventory.calls[0].resolution, 'bound');
    assert.deepEqual(report.inventory.calls[0].responseFields, ['/totalCents']);
  });
});

test('shadowed, reassigned, escaped or out-of-scope receivers remain unresolved', async (t) => {
  for (const [source, reason] of [
    [`const client = createClient(); async function run(client) { await ${call}; }`, 'shadowed-receiver'],
    [`let client = createClient(); client = other; await ${call};`, 'receiver-reassigned'],
    [`const client = createClient(); client.callTool = replacement; await ${call};`, 'receiver-reassigned'],
    [`const client = createClient(); const alias = client; await ${call};`, 'receiver-escapes'],
    [`const client = createClient(); Object.assign(client, other); await ${call};`, 'receiver-escapes'],
    [`function unrelated(client) {} async function run() { await ${call}; }`, 'receiver-binding-unresolved'],
    [`for (let client of providers) {} await ${call};`, 'receiver-binding-unresolved'],
    [`class Configuration { static { const client = createClient(); } } await ${call};`, 'receiver-binding-unresolved'],
    [`const { client } = configuration; await ${call};`, 'receiver-binding-unresolved'],
    [`const client = createClient(); eval('unknown'); await ${call};`, 'dynamic-scope'],
    [`await ${call};`, 'receiver-binding-unresolved'],
  ]) await t.test(reason, async (t) => {
    const { options } = await fixture(t, source);
    const report = await analyzeMcpImpact(options);
    assert.equal(report.inventory.calls[0].reason, reason);
    assert.deepEqual(report.matches, []);
  });
});

test('dynamic names, requests, argument objects and optional calls remain unresolved', async (t) => {
  for (const [expression, reason] of [
    ["client.callTool({ name: selected, arguments: {} })", 'dynamic-or-missing-tool-name'],
    ["client.callTool({ name: 'quote', arguments: input })", 'dynamic-or-missing-tool-arguments'],
    ["client.callTool({ name: 'quote' })", 'dynamic-or-missing-tool-arguments'],
    ["client.callTool()", 'dynamic-or-missing-request'], ["client.callTool(request)", 'dynamic-or-missing-request'],
    ["client.callTool({ name: 'quote', arguments: {}, ...request })", 'dynamic-request-properties'],
    ["client.callTool({ name: 'quote', name: other, arguments: {} })", 'dynamic-request-properties'],
    ["client.callTool({ name: 'quote', arguments: { ...input } })", 'dynamic-tool-arguments'],
    ["client.callTool({ name: 'quote', arguments: { get id() { throw Error(); } } })", 'dynamic-tool-arguments'],
    ["client?.callTool({ name: 'quote', arguments: {} })", 'optional-call'],
    ["client.callTool({ name: 'undeclared', arguments: {} })", 'tool-not-declared-in-baseline'],
  ]) await t.test(expression, async (t) => {
    const { options } = await fixture(t, `const client = createClient(); await ${expression};`);
    const report = await analyzeMcpImpact(options);
    assert.equal(report.inventory.calls[0].reason, reason);
    assert.equal(report.unresolvedCallIds.length, 1);
    assert.deepEqual(report.matches, []);
  });
});

test('computed dispatch and call/apply forms produce explicit inspection issues', async (t) => {
  for (const expression of ["client[method]({ name: 'quote', arguments: {} })", "client.callTool.call(client, { name: 'quote', arguments: {} })"]) await t.test(expression, async (t) => {
    const { options } = await fixture(t, `const client = createClient(); await ${expression};`);
    const report = await analyzeMcpImpact(options);
    assert.ok(report.inventory.issues.some((issue) => issue.code === 'indirect-client-dispatch'));
    assert.deepEqual(report.matches, []);
  });
});

test('result aliases, writes, shadowing and indirect parsers do not fabricate output field evidence', async (t) => {
  for (const suffix of [
    'return parse(response);', 'const alias = response; return alias.structuredContent.totalCents;',
    'response.structuredContent.totalCents = 1; return response.structuredContent.totalCents;',
    'const data = response.structuredContent; return data.totalCents;', 'return response.structuredContent[field];',
    'return (() => response.structuredContent.totalCents)();', 'return response.structuredContent.items.map(transform);',
    'return response.content[0].text;', 'function unrelated(response) {} return response.structuredContent.totalCents;',
  ]) await t.test(suffix, async (t) => {
    const { options } = await fixture(t, `export async function quote(client) { const response = await ${call}; ${suffix} }`);
    const report = await analyzeMcpImpact(options);
    assert.equal(report.inventory.calls[0].resolution, 'bound');
    assert.equal(report.inventory.calls[0].parserTrace, 'unavailable');
    assert.deepEqual(report.inventory.calls[0].responseFields, []);
    assert.deepEqual(report.inventory.calls[0].parserLocations, []);
  });
});

test('only direct awaited const assignments produce traces', async (t) => {
  for (const source of [
    `async function quote(client) { const response = ${call}; return response.structuredContent.totalCents; }`,
    `async function quote(client) { let response = await ${call}; return response.structuredContent.totalCents; }`,
    `async function quote(client) { const { structuredContent } = await ${call}; return structuredContent.totalCents; }`,
    `async function quote(client) { return (await ${call}).structuredContent.totalCents; }`,
  ]) await t.test(source.slice(0, 55), async (t) => {
    const { options } = await fixture(t, source);
    assert.equal((await analyzeMcpImpact(options)).inventory.calls[0].parserTrace, 'unavailable');
  });
});

test('literal callTool brackets and nested parser reads produce escaped JSON pointers', async (t) => {
  const { options } = await fixture(t, "async function quote(client) { const response = await client['callTool']({ name: 'quote', arguments: { sku: 'fixture' } }); return response.structuredContent['money/value']['a~b']; }");
  const usage = (await analyzeMcpImpact(options)).inventory.calls[0];
  assert.equal(usage.resolution, 'bound');
  assert.deepEqual(usage.responseFields, ['/money~1value/a~0b']);
});

test('consumer source edits change capture and call identity', async (t) => {
  const { options, sourceFile } = await fixture(t);
  const before = await analyzeMcpImpact(options);
  await writeFile(sourceFile, beforeConsumer + '\n// Local source edit.\n');
  const after = await analyzeMcpImpact(options);
  assert.notEqual(after.inventory.digest, before.inventory.digest);
  assert.notEqual(after.inventory.calls[0].id, before.inventory.calls[0].id);
});

test('a type-only import cannot establish a runtime receiver binding', async (t) => {
  const { options } = await fixture(t, `import type { client } from './missing'; await ${call};`, 'src/quote.ts');
  assert.equal((await analyzeMcpImpact(options)).inventory.calls[0].reason, 'receiver-binding-unresolved');
});

test('syntax failures and excluded files remain visible', async (t) => {
  const { options } = await fixture(t, 'export const broken = ;');
  await writeFile(join(options.consumerRoot, 'ignored.txt'), 'client.callTool(...)');
  const report = await analyzeMcpImpact(options);
  assert.deepEqual(report.inventory.calls, []);
  assert.ok(report.inventory.issues.some((issue) => issue.code === 'syntax-error'));
  assert.ok(report.inventory.skipped.some((entry) => entry.path === 'ignored.txt'));
  assert.equal(report.unmappedChangeIndexes.length, 2);
});

test('bindings reject duplicates, traversal and executable getters before capture', async (t) => {
  const { options } = await fixture(t);
  for (const bindings of [[binding(), binding()], [{ ...binding(), file: '../outside.mjs' }], [{ ...binding(), file: '/absolute.mjs' }], [{ ...binding(), receiver: 'this.client' }], [{ ...binding(), authContextId: '' }], [{ ...binding(), token: 'private' }]]) await assert.rejects(analyzeMcpImpact({ ...options, bindings }), { code: 'INVALID_INPUT' });
  let executed = 0;
  const getter = binding();
  Object.defineProperty(getter, 'receiver', { get() { executed += 1; return 'client'; } });
  await assert.rejects(analyzeMcpImpact({ ...options, bindings: [getter] }), { code: 'INVALID_INPUT' });
  const proxy = new Proxy(binding(), { ownKeys() { executed += 1; return []; } });
  await assert.rejects(analyzeMcpImpact({ ...options, bindings: [proxy] }), { code: 'INVALID_INPUT' });
  assert.equal(executed, 0);
});

test('consumer imports, throws and scripts are not executed and providers are not fetched', async (t) => {
  const { options } = await fixture(t, `import './does-not-exist.mjs'; throw new Error('Must not execute'); ${beforeConsumer}`);
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network is forbidden'); };
  try {
    const report = await analyzeMcpImpact(options);
    assert.equal(report.inventory.calls[0].resolution, 'bound');
    assert.equal(report.inventory.codeExecuted, false);
  } finally { globalThis.fetch = original; }
});
