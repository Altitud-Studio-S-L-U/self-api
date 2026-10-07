import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectSource } from '../dist/inspect-source.js';

function inspect(text, path = 'src/client.ts') {
  return inspectSource({ path, text, sha256: createHash('sha256').update(text).digest('hex') });
}

test('identifies native fetch methods while removing query, fragment and header data', () => {
  const result = inspect('fetch("https://api.example.invalid/orders?api_key=private-query#private-fragment"); globalThis.fetch("https://api.example.invalid/orders", { method: "post", headers: { Authorization: "private-header" } });');
  assert.deepEqual(result.calls.map(({ method, origin, pathPattern, resolution }) => ({ method, origin, pathPattern, resolution })), [
    { method: 'GET', origin: 'https://api.example.invalid', pathPattern: '/orders', resolution: 'resolved' },
    { method: 'POST', origin: 'https://api.example.invalid', pathPattern: '/orders', resolution: 'resolved' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private-query|private-fragment|private-header/);
});

test('traces typed JSON response fields and their source locations', () => {
  const result = inspect([
    'type ProviderOrder = { id: string; total: number };',
    'export async function getOrder(id: string) {',
    '  const response = await fetch(`https://orders.example.invalid/orders/${encodeURIComponent(id)}`);',
    '  const order: ProviderOrder = await response.json();',
    '  return { reference: order.id, total: order.total };',
    '}',
  ].join('\n'));
  const call = result.calls[0];
  assert.equal(result.calls.length, 1);
  assert.equal(call.resolution, 'resolved');
  assert.equal(call.method, 'GET');
  assert.equal(call.origin, 'https://orders.example.invalid');
  assert.equal(call.pathPattern, '/orders/{*}');
  assert.deepEqual(call.responseFields, ['id', 'total']);
  assert.equal(call.parserLocations.length, 2);
  assert.ok(call.parserLocations.every((location) => location.file === 'src/client.ts' && location.line === 5));
  assert.deepEqual(result.issues, []);
});

test('accepts multiple encoded whole segments without query data', () => {
  const result = inspect('fetch(`https://api.example.invalid/accounts/${encodeURIComponent(account)}/orders/${encodeURIComponent(order)}?token=private`);');
  assert.equal(result.calls[0].resolution, 'resolved');
  assert.equal(result.calls[0].pathPattern, '/accounts/{*}/orders/{*}');
  assert.doesNotMatch(JSON.stringify(result), /token|private/);
});

const unresolvedCases = [
  ['URL variable', 'fetch(endpoint);'],
  ['relative URL', 'fetch("/orders");'],
  ['unknown host', 'fetch(`https://${host}/orders`);'],
  ['unencoded path', 'fetch(`https://api.example.invalid/orders/${id}`);'],
  ['partially encoded path', 'fetch(`https://api.example.invalid/orders/prefix-${encodeURIComponent(id)}`);'],
  ['dynamic query', 'fetch(`https://api.example.invalid/orders?token=${encodeURIComponent(token)}`);'],
  ['encoded host', 'fetch(`https://${encodeURIComponent(host)}/orders`);'],
  ['URL userinfo', 'fetch("https://private-user:private-password@api.example.invalid/orders");'],
  ['URL object', 'fetch(new URL("https://api.example.invalid/orders"));'],
  ['dynamic options', 'fetch("https://api.example.invalid/orders", options);'],
  ['dynamic method', 'fetch("https://api.example.invalid/orders", { method });'],
  ['unknown method', 'fetch("https://api.example.invalid/orders", { method: "PRIVATE" });'],
  ['spread options', 'fetch("https://api.example.invalid/orders", { method: "POST", ...options });'],
  ['computed option', 'fetch("https://api.example.invalid/orders", { [key]: value });'],
  ['options getter', 'fetch("https://api.example.invalid/orders", { get method() { return "GET"; } });'],
  ['prototype options', 'fetch("https://api.example.invalid/orders", { __proto__: options });'],
  ['fetch parameter', 'function request(fetch) { return fetch("https://api.example.invalid/orders"); }'],
  ['imported fetch', 'import fetch from "fetch-client"; fetch("https://api.example.invalid/orders");'],
  ['globalThis parameter', 'function request(globalThis) { return globalThis.fetch("https://api.example.invalid/orders"); }'],
  ['fetch assignment', 'fetch = replacement; fetch("https://api.example.invalid/orders");'],
  ['loop assignment', 'for (fetch of methods) {} fetch("https://api.example.invalid/orders");'],
  ['global fetch assignment', 'globalThis.fetch = replacement; fetch("https://api.example.invalid/orders");'],
  ['encoder parameter', 'function request(encodeURIComponent) { return fetch(`https://api.example.invalid/orders/${encodeURIComponent(id)}`); }'],
  ['global encoder assignment', 'globalThis.encodeURIComponent = replacement; fetch(`https://api.example.invalid/orders/${encodeURIComponent(id)}`);'],
  ['optional fetch', 'fetch?.("https://api.example.invalid/orders");'],
  ['computed fetch', 'globalThis["fetch"]("https://api.example.invalid/orders");'],
  ['direct eval', 'eval(program); fetch("https://api.example.invalid/orders");'],
];
for (const [description, source] of unresolvedCases) {
  test(`does not resolve ${description}`, () => {
    const result = inspect(source);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].resolution, 'unresolved');
    assert.ok(result.calls[0].reason);
    assert.deepEqual(result.calls[0].responseFields, []);
    assert.ok(result.issues.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /private-user|private-password/);
  });
}

test('distinguishes globalThis.fetch from a local fetch binding', () => {
  assert.equal(inspect('const fetch = local; globalThis.fetch("https://api.example.invalid/orders");').calls[0].resolution, 'resolved');
});

test('keeps aliases and unrelated methods outside supported call syntax', () => {
  assert.deepEqual(inspect('const request = fetch; request("https://api.example.invalid/orders"); client.fetch("https://api.example.invalid/orders");').calls, []);
});

test('traces computed and nested reads as top-level response fields', () => {
  const result = inspect('async function read() { const response = await fetch("https://api.example.invalid/orders"); const data = await response.json(); return [data["total"], data.customer.name, data?.id]; }');
  assert.deepEqual(result.calls[0].responseFields, ['customer', 'id', 'total']);
});

const untraceableCases = [
  ['unrelated same-name binding', 'function unrelated(data) { return data.secret; }', 'return data.total;'],
  ['data reassignment', '', 'data = another; return data.total;'],
  ['data mutation', '', 'data.total = 0; return data.total;'],
  ['data escaping', '', 'consume(data); return data.total;'],
  ['data alias', '', 'const alias = data; return alias.total;'],
  ['unknown property', '', 'return data[field];'],
  ['response escaping', 'function mutate(value) {}', 'return data.total;', 'mutate(response);'],
  ['response method replacement', '', 'return data.total;', 'response.json = replacement;'],
];
for (const [description, prefix, usage, afterFetch = ''] of untraceableCases) {
  test(`does not attribute response fields when ${description}`, () => {
    const result = inspect(`${prefix} async function read() { const response = await fetch("https://api.example.invalid/orders"); ${afterFetch} const data = await response.json(); ${usage} }`);
    assert.equal(result.calls[0].resolution, 'resolved');
    assert.deepEqual(result.calls[0].responseFields, []);
    assert.deepEqual(result.calls[0].parserLocations, []);
    assert.ok(result.issues.some(({ code }) => code.startsWith('response-trace-')));
  });
}

test('does not connect JSON parsing in a separate block', () => {
  const result = inspect('async function read() { const response = await fetch("https://api.example.invalid/orders"); if (response.ok) { const data = await response.json(); return data.total; } }');
  assert.deepEqual(result.calls[0].responseFields, []);
  assert.ok(result.issues.some(({ code }) => code === 'response-trace-unavailable'));
});

test('collects bare package roots without loading imports or executing source', () => {
  const result = inspect('import sdk from "@private-scope/sdk/deep/module"; import "missing-plumber-package/side-effect"; import "./local.js"; import "node:fs"; export { feature } from "@other/package/feature"; globalThis.__plumber_execution_probe = "executed"; throw new Error("customer-code-must-not-execute");');
  assert.deepEqual(result.imports.map(({ packageName }) => packageName), ['@private-scope/sdk', 'missing-plumber-package', '@other/package']);
  assert.equal(globalThis.__plumber_execution_probe, undefined);
  assert.deepEqual(result.issues, []);
});

test('parses TSX without a project configuration', () => {
  assert.equal(inspect('const Card = <div />; fetch("https://api.example.invalid/orders");', 'src/view.tsx').calls[0].resolution, 'resolved');
});

test('reports syntax errors without partial calls or source content', () => {
  const result = inspect('fetch("https://api.example.invalid/orders?secret=private"); const broken = ;');
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.imports, []);
  assert.equal(result.issues[0].code, 'syntax-error');
  assert.doesNotMatch(JSON.stringify(result), /secret|private|broken/);
});

test('stable call IDs bind the file digest, path and call position', () => {
  const source = 'fetch("https://api.example.invalid/orders"); fetch("https://api.example.invalid/orders");';
  const first = inspect(source);
  assert.deepEqual(first, inspect(source));
  assert.notEqual(first.calls[0].id, first.calls[1].id);
  assert.notEqual(first.calls[0].id, inspect(source, 'src/other.ts').calls[0].id);
  assert.notEqual(first.calls[0].id, inspect(`${source}\n`).calls[0].id);
  assert.match(first.calls[0].id, /^[0-9a-f]{64}$/);
});

test('bounds source bytes before reporting partial evidence', () => {
  const result = inspect(`fetch("https://api.example.invalid/orders"); //${'x'.repeat(2 * 1024 * 1024)}`);
  assert.deepEqual(result.calls, []);
  assert.equal(result.issues[0].code, 'source-size-limit');
});

test('bounds AST depth and node count without a partial inventory', () => {
  for (const text of [
    'fetch("https://api.example.invalid/orders"); const deep = ' + 'a+'.repeat(300) + 'a;',
    'fetch("https://api.example.invalid/orders");' + 'a;'.repeat(51_000),
  ]) {
    const result = inspect(text);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.imports, []);
    assert.equal(result.issues[0].code, 'ast-limit-exceeded');
  }
});
