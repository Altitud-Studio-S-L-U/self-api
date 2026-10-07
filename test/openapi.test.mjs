import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { loadOpenApi } from '../dist/openapi.js';

const temporaryParent = resolve('work/test-openapi');
await mkdir(temporaryParent, { recursive: true });
const resolvedParent = await realpath(temporaryParent);
const temporaryDirectory = await mkdtemp(join(resolvedParent, 'snapshot-'));
let fixtureNumber = 0;

after(async () => {
  const target = await realpath(temporaryDirectory);
  assert.equal(dirname(target), resolvedParent);
  assert.ok(basename(target).startsWith('snapshot-'));
  await rm(target, { recursive: true, force: false });
});

function document(overrides = {}) {
  return {
    openapi: '3.0.3',
    info: { title: 'Fixture API', version: '2026-10' },
    paths: {},
    ...overrides,
  };
}

async function fixture(contents, name = 'contract.json') {
  const filePath = join(temporaryDirectory, `${fixtureNumber++}-${name}`);
  await writeFile(filePath, contents);
  return filePath;
}

async function rejectDocument(value, code) {
  const filePath = await fixture(JSON.stringify(value));
  await assert.rejects(loadOpenApi(filePath), { name: 'PlumberError', code });
}

test('captures supported JSON versions, original bytes, and immutable metadata', async (t) => {
  for (const version of ['3.0.3', '3.1.0', '3.1.1']) {
    await t.test(version, async () => {
      const json = `${JSON.stringify(document({
        openapi: version,
        info: { title: 'API de envío 🚰', version: '2026-10' },
      }), null, 2)}\r\n`;
      const bytes = Buffer.from(json);
      const filePath = await fixture(bytes, 'contract with spaces.json');
      const snapshot = await loadOpenApi(filePath);
      assert.equal(snapshot.json, json);
      assert.deepEqual(snapshot.metadata, {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
        specificationVersion: version,
        apiVersion: '2026-10',
      });
      assert.equal(JSON.stringify(snapshot.metadata).includes(temporaryDirectory), false);
      assert.throws(() => { snapshot.metadata.sha256 = 'changed'; }, TypeError);
      assert.throws(() => { snapshot.json = '{}'; }, TypeError);
      assert.deepEqual(await readFile(filePath), bytes);
    });
  }
});

test('invalid JSON, UTF-8, and required structure are errors, not empty contracts', async (t) => {
  for (const [label, contents] of [
    ['empty', ''],
    ['malformed JSON', '{"openapi":'],
    ['JavaScript module', 'export default { openapi: "3.0.3" };'],
    ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])],
  ]) {
    await t.test(label, async () => {
      await assert.rejects(loadOpenApi(await fixture(contents)), {
        name: 'PlumberError', code: 'INVALID_INPUT',
      });
    });
  }
  for (const [label, value] of [
    ['null', null],
    ['array', []],
    ['missing version', { info: { title: 'API', version: '1' }, paths: {} }],
    ['non-string version', document({ openapi: 3.1 })],
    ['malformed version', document({ openapi: '3.1' })],
    ['missing info', document({ info: undefined })],
    ['missing title', document({ info: { version: '1' } })],
    ['non-string API version', document({ info: { title: 'API', version: 1 } })],
    ['missing paths', document({ paths: undefined })],
    ['array paths', document({ paths: [] })],
    ['non-string ref', document({ components: { schemas: { Item: { $ref: 7 } } } })],
  ]) {
    await t.test(label, () => rejectDocument(value, 'INVALID_INPUT'));
  }
});

test('external references are unsupported while internal cycles remain engine input', async (t) => {
  const references = [
    'https://example.invalid/schema.json#/Item',
    'file:///private/schema.json',
    '../schema.json#/Item',
    'C:\\private\\schema.json',
    '\\\\server\\share\\schema.json',
    '//example.invalid/schema.json',
    'data:application/json,{}',
  ];
  for (const reference of references) {
    await t.test(reference, async () => {
      await rejectDocument(document({
        components: { schemas: { Item: { $ref: reference } } },
      }), 'UNSUPPORTED_CONTRACT');
      await rejectDocument(document({
        components: { links: { Next: { operationRef: reference } } },
      }), 'UNSUPPORTED_CONTRACT');
    });
  }

  const cyclic = document({
    components: {
      schemas: {
        Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } },
      },
    },
    externalDocs: { url: 'https://example.invalid/docs' },
    servers: [{ url: 'https://example.invalid' }],
  });
  const snapshot = await loadOpenApi(await fixture(JSON.stringify(cyclic)));
  assert.deepEqual(JSON.parse(snapshot.json), cyclic);
});

test('unsupported dialects and constructs cannot appear as supported snapshots', async (t) => {
  const cases = [
    ['Swagger', { swagger: '2.0', info: { title: 'API', version: '1' }, paths: {} }],
    ['OpenAPI 3.2', document({ openapi: '3.2.0' })],
    ['OpenAPI 2', document({ openapi: '2.0.0' })],
    ['dynamic ref', document({ openapi: '3.1.0', components: { schemas: { Item: { $dynamicRef: '#node' } } } })],
    ['dynamic anchor', document({ openapi: '3.1.0', components: { schemas: { Item: { $dynamicAnchor: 'node' } } } })],
    ['schema identity', document({ openapi: '3.1.0', components: { schemas: { Item: { $id: 'https://example.invalid/item' } } } })],
    ['component path items', document({ openapi: '3.1.0', components: { pathItems: {} } })],
    ['webhooks', document({ openapi: '3.1.0', webhooks: {} })],
    ['custom dialect', document({ openapi: '3.1.0', jsonSchemaDialect: 'https://example.invalid/dialect' })],
    ['custom schema dialect', document({ openapi: '3.1.0', components: { schemas: { Item: { $schema: 'https://example.invalid/dialect' } } } })],
  ];
  for (const [label, value] of cases) {
    await t.test(label, () => rejectDocument(value, 'UNSUPPORTED_CONTRACT'));
  }

  const supported = document({
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    components: { schemas: { State: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string', const: 'ready' } } },
  });
  assert.deepEqual(JSON.parse((await loadOpenApi(await fixture(JSON.stringify(supported)))).json), supported);
});

test('enforces byte and nesting limits without counting quoted brackets as structure', async () => {
  const maximumBytes = 4 * 1024 * 1024;
  const emptyPadding = JSON.stringify(document({ 'x-padding': '' }));
  const atLimit = JSON.stringify(document({ 'x-padding': 'a'.repeat(maximumBytes - Buffer.byteLength(emptyPadding)) }));
  assert.equal(Buffer.byteLength(atLimit), maximumBytes);
  assert.equal((await loadOpenApi(await fixture(atLimit))).metadata.byteLength, maximumBytes);
  await assert.rejects(loadOpenApi(await fixture(`${atLimit} `)), { code: 'INVALID_INPUT' });

  const prefix = JSON.stringify(document()).slice(0, -1);
  const depth128 = `${prefix},"x-depth":${'['.repeat(127)}0${']'.repeat(127)}}`;
  const depth129 = `${prefix},"x-depth":${'['.repeat(128)}0${']'.repeat(128)}}`;
  assert.equal((await loadOpenApi(await fixture(depth128))).json, depth128);
  await assert.rejects(loadOpenApi(await fixture(depth129)), { code: 'INVALID_INPUT' });
  const quoted = JSON.stringify(document({ 'x-note': `${'[{'.repeat(256)}"\\${'}]'.repeat(256)}` }));
  assert.equal((await loadOpenApi(await fixture(quoted))).json, quoted);
});

test('rejects non-file inputs, remote paths, device paths, and alternate data streams', async (t) => {
  for (const value of [
    '', ' ', '-', 'https://example.invalid/openapi.json', 'file:///tmp/openapi.json',
    'main:openapi.json', 'C:relative.json', '\\\\server\\share\\openapi.json',
    '//server/share/openapi.json', '\\\\.\\pipe\\plumber', '\\\\?\\C:\\openapi.json',
    'NUL', 'nul.json', 'CON', 'COM1.json', 'LPT9', 'CONOUT$',
    'contract.json:stream', 'contract\0.json',
  ]) {
    await t.test(JSON.stringify(value), async () => {
      await assert.rejects(loadOpenApi(value), { name: 'PlumberError', code: 'INVALID_INPUT' });
    });
  }
  await assert.rejects(loadOpenApi(temporaryDirectory), { code: 'INVALID_INPUT' });
  await assert.rejects(loadOpenApi(join(temporaryDirectory, 'missing.json')), { code: 'INVALID_INPUT' });
  const unusualName = await fixture(JSON.stringify(document()), '--help-contrato-ñ.json');
  assert.equal((await loadOpenApi(unusualName)).metadata.apiVersion, '2026-10');
});

test('rejects symlinked ancestors, including Windows directory junctions', async () => {
  const targetDirectory = join(temporaryDirectory, 'source-directory');
  const linkDirectory = join(temporaryDirectory, 'linked-directory');
  await mkdir(targetDirectory);
  await writeFile(join(targetDirectory, 'openapi.json'), JSON.stringify(document()));
  await symlink(targetDirectory, linkDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadOpenApi(join(linkDirectory, 'openapi.json')), { code: 'INVALID_INPUT' });
});

test('captured content survives source changes and treats example payloads as data', async () => {
  const original = document({
    components: {
      schemas: {
        Item: {
          type: 'object',
          properties: { $ref: { type: 'string' }, $id: { type: 'string' } },
          example: { $ref: 'https://example.invalid/literal', $id: 'literal data' },
        },
      },
    },
  });
  const json = JSON.stringify(original);
  const filePath = await fixture(json);
  const snapshot = await loadOpenApi(filePath);
  await writeFile(filePath, JSON.stringify(document({ info: { title: 'Changed', version: 'next' } })));
  assert.equal(snapshot.json, json);
  assert.equal(snapshot.metadata.sha256, createHash('sha256').update(json).digest('hex'));
  assert.equal(snapshot.metadata.apiVersion, '2026-10');
});
