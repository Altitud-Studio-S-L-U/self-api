import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { captureConsumer } from '../dist/consumer-files.js';
import { analyzeCapturedImpact } from '../dist/impact.js';
import { scanCapturedConsumer, scanConsumer } from '../dist/scan.js';

const parent = resolve('work/test-impact-capture');
await mkdir(parent, { recursive: true });
const resolvedParent = await realpath(parent);
const temporary = await mkdtemp(join(resolvedParent, 'impact-capture-'));
let fixtureNumber = 0;
after(async () => {
  const target = await realpath(temporary);
  assert.equal(dirname(target), resolvedParent);
  assert.ok(basename(target).startsWith('impact-capture-'));
  await rm(target, { recursive: true, force: false });
});

const providerBaseUrl = 'https://orders.example.invalid/v1';
const invalidInput = { name: 'PlumberError', code: 'INVALID_INPUT' };

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

async function consumer(source, manifest = { scripts: { test: 'node --test' }, dependencies: { sdk: '^1.0.0' } }) {
  const root = join(temporary, `consumer-${fixtureNumber++}`);
  await mkdir(root);
  await writeFile(join(root, 'orders.mjs'), source);
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(root, '.env'), 'SYNTHETIC_SECRET=never-captured');
  await writeFile(join(root, 'notes.txt'), 'A skipped non-source fixture');
  return root;
}

function evidence({ concreteMethod } = {}) {
  const get = { responses: { 200: { description: 'OK' } } };
  const paths = { '/orders/{id}': { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], get } };
  if (concreteMethod) paths['/orders/search'] = { [concreteMethod]: get };
  const json = JSON.stringify({ openapi: '3.0.3', info: { title: 'Synthetic captured contract', version: '1.0.0' }, paths });
  const metadata = { sha256: createHash('sha256').update(json).digest('hex'), byteLength: Buffer.byteLength(json), specificationVersion: '3.0.3', apiVersion: '1.0.0' };
  const base = freeze({ json, metadata });
  const comparison = freeze({
    schemaVersion: 1, engine: { name: 'oasdiff', version: '1.33.0' }, base: metadata,
    revision: { ...metadata, sha256: 'b'.repeat(64), apiVersion: '2.0.0' },
    contentChanged: true, status: 'breaking-changes',
    changes: [
      { id: 'response-property-removed', text: 'Synthetic removed response field', level: 'error', operation: 'GET', path: '/orders/{id}' },
      { id: 'schema-change', text: 'Synthetic change without operation mapping', level: 'warning' },
    ],
    coverage: 'structural-contract-only', consumerImpact: 'not-analyzed',
  });
  return { base, comparison };
}

test('captured analysis preserves inventory and skipped coverage after the live consumer changes', async () => {
  const root = await consumer("const response = await fetch('https://orders.example.invalid/v1/orders/123'); const order = await response.json(); order.total;");
  const captured = await captureConsumer(root);
  assert.ok(Object.isFrozen(captured));
  const original = freeze(scanCapturedConsumer(captured));
  assert.deepEqual(original, await scanConsumer(root));
  await writeFile(join(root, 'orders.mjs'), "fetch('https://different.example.invalid/unrelated');");
  await writeFile(join(root, 'package.json'), '{invalid live manifest');
  const inventory = freeze(scanCapturedConsumer(captured));
  assert.deepEqual(inventory, original);
  assert.equal(inventory.digest, captured.digest);
  assert.deepEqual(inventory.skipped, captured.skipped);
  assert.ok(inventory.skipped.some(item => item.path === '.env'));
  assert.ok(inventory.skipped.some(item => item.path === 'notes.txt'));
  const report = analyzeCapturedImpact({ ...evidence(), inventory, providerBaseUrl });
  assert.deepEqual(report.matches, [{ changeIndex: 0, callIds: [inventory.calls[0].id] }]);
  assert.deepEqual(report.unmappedChangeIndexes, [1]);
  assert.equal(report.inventory, inventory);
  assert.equal(report.inventory.coverage, 'bounded-native-fetch-syntax');
  assert.equal(report.coverage, 'potential-operation-impact');
  assert.equal(report.conclusion, 'review-required');
  await assert.rejects(scanConsumer(root), invalidInput);
});

test('captured helpers treat imports, top-level code, and package commands only as data', async () => {
  const marker = join(temporary, 'must-never-be-written');
  const writeMarker = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`;
  const root = await consumer([
    "import 'missing-synthetic-sdk';",
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    "fetch('https://orders.example.invalid/v1/orders/1');",
  ].join('\n'), {
    scripts: { test: `node -e ${JSON.stringify(writeMarker)}`, postinstall: `node -e ${JSON.stringify(writeMarker)}` },
    dependencies: { sdk: 'git+https://user:synthetic-private-secret@example.invalid/sdk.git' },
  });
  const captured = await captureConsumer(root);
  const inventory = scanCapturedConsumer(captured);
  const report = analyzeCapturedImpact({ ...evidence(), inventory, providerBaseUrl });
  assert.ok(inventory.imports.some(item => item.packageName === 'missing-synthetic-sdk'));
  assert.equal(inventory.packages[0].dependencies[0].range, null);
  assert.equal(inventory.validationCandidates.length, 1);
  assert.equal(inventory.validationCandidates[0].execution, 'not-authorized');
  assert.equal(inventory.codeExecuted, false);
  assert.equal(report.matches.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private-secret|writeFileSync|must-never-be-written/);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('captured impact maintains origin, base-path, method, and unresolved-call semantics', async () => {
  const root = await consumer([
    "fetch('https://orders.example.invalid/v1/orders/123');",
    "fetch('https://another.example.invalid/v1/orders/123');",
    "fetch('https://orders.example.invalid/v10/orders/123');",
    "fetch('https://orders.example.invalid/v1/orders/123', { method: 'POST' });",
    'export const request = url => fetch(url);',
  ].join('\n'));
  const inventory = freeze(scanCapturedConsumer(await captureConsumer(root)));
  const report = analyzeCapturedImpact({ ...evidence(), inventory, providerBaseUrl: `${providerBaseUrl}/` });
  assert.deepEqual(report.provider, { origin: 'https://orders.example.invalid', basePath: '/v1' });
  assert.deepEqual(report.matches, [{ changeIndex: 0, callIds: [inventory.calls[0].id] }]);
  assert.deepEqual(report.unresolvedCallIds, [inventory.calls[4].id]);
  assert.equal(report.conclusion, 'review-required');
});

test('captured mapping gives concrete operations precedence only for the same method', async () => {
  const root = await consumer("fetch('https://orders.example.invalid/v1/orders/search');");
  const inventory = freeze(scanCapturedConsumer(await captureConsumer(root)));
  const concreteGet = analyzeCapturedImpact({ ...evidence({ concreteMethod: 'get' }), inventory, providerBaseUrl });
  assert.deepEqual(concreteGet.matches, []);
  assert.deepEqual(concreteGet.unmappedChangeIndexes, [0, 1]);
  const concretePost = analyzeCapturedImpact({ ...evidence({ concreteMethod: 'post' }), inventory, providerBaseUrl });
  assert.deepEqual(concretePost.matches, [{ changeIndex: 0, callIds: [inventory.calls[0].id] }]);
});

test('captured mapping rejects a base hash mismatch and unsafe provider bindings', async () => {
  const captured = await captureConsumer(await consumer(''));
  const inventory = scanCapturedConsumer(captured);
  const input = { ...evidence(), inventory, providerBaseUrl };
  assert.throws(() => analyzeCapturedImpact({ ...input, base: { ...input.base, metadata: { ...input.base.metadata, sha256: 'c'.repeat(64) } } }), invalidInput);
  for (const unsafe of ['not a URL', 'file:///private', 'https://user:secret@example.invalid', 'https://example.invalid?token=secret', 'https://example.invalid#secret']) {
    assert.throws(() => analyzeCapturedImpact({ ...input, providerBaseUrl: unsafe }), error => {
      assert.equal(error.code, 'INVALID_INPUT');
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
});

test('captured manifest validation keeps its existing explicit failures', async () => {
  const captured = await captureConsumer(await consumer(''));
  for (const text of ['{invalid', 'null', '{"dependencies":{"sdk":42}}', '{"scripts":{"test":42}}']) {
    const altered = freeze({ ...captured, manifests: [{ ...captured.manifests[0], text }] });
    assert.throws(() => scanCapturedConsumer(altered), invalidInput);
  }
});
