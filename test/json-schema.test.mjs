import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { compareJsonExamples, compareJsonSchemas, loadJsonExample, loadJsonSchema } from '../dist/json-schema.js';

const parent = resolve('work/test-json-schema');
await mkdir(parent, { recursive: true });
const realParent = await realpath(parent);
const temporary = await mkdtemp(join(realParent, 'schema-'));
let sequence = 0;
after(async () => {
  const target = await realpath(temporary);
  assert.equal(dirname(target), realParent);
  assert.ok(basename(target).startsWith('schema-'));
  await rm(target, { recursive: true });
});
async function file(value, name = 'input.json') {
  const path = join(temporary, `${sequence++}-${name}`);
  await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return path;
}
const object = (required = []) => ({ type: 'object', properties: { name: { type: 'string' } }, required, additionalProperties: false });
async function compare(base, revision, direction) {
  return compareJsonSchemas({ basePath: await file(base), revisionPath: await file(revision), direction });
}

test('declared schemas retain exact source bytes and immutable metadata', async () => {
  const value = { ...object(['name']), $schema: 'https://json-schema.org/draft/2020-12/schema' };
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\r\n');
  const path = await file(bytes);
  const snapshot = await loadJsonSchema(path);
  assert.equal(snapshot.kind, 'declared-schema');
  assert.equal(snapshot.source, 'local-file');
  assert.equal(snapshot.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(snapshot.byteLength, bytes.length);
  assert.deepEqual(snapshot.schema, value);
  assert.throws(() => { snapshot.schema.required.pop(); }, TypeError);
  assert.deepEqual(await readFile(path), bytes);
});

test('input and output direction must be explicit and have opposite variance', async (t) => {
  for (const direction of [undefined, null, 'request', '', true]) await t.test(String(direction), async () => {
    await assert.rejects(compare(object(), object(['name']), direction), { code: 'INVALID_INPUT' });
  });
  const input = await compare(object(), object(['name']), 'input');
  const output = await compare(object(), object(['name']), 'output');
  assert.equal(input.compatibility, 'breaking');
  assert.equal(input.status, 'breaking-changes');
  assert.deepEqual(input.paths, ['/required/name']);
  assert.equal(output.compatibility, 'compatible');
  assert.equal(output.status, 'no-breaking-changes');
  assert.equal(input.consumerImpact, 'not-analyzed');
});

test('scalar, array and unconstrained roots use the supported structural profile', async (t) => {
  for (const [before, afterSchema, direction, expected] of [
    [{ type: 'integer' }, { type: 'number' }, 'input', 'compatible'],
    [{ type: 'integer' }, { type: 'number' }, 'output', 'breaking'],
    [{ type: 'string', const: 'yes' }, { type: 'string' }, 'input', 'compatible'],
    [{ type: 'string' }, { type: 'string', const: 'yes' }, 'input', 'breaking'],
    [{ type: 'null' }, { type: 'object' }, 'input', 'breaking'],
    [{ type: 'array', items: { type: 'integer' } }, { type: 'array', items: { type: 'number' } }, 'input', 'compatible'],
    [true, {}, 'input', 'compatible'], [{}, true, 'output', 'compatible'],
    [true, { type: 'string' }, 'input', 'breaking'], [{ type: 'string' }, true, 'input', 'compatible'],
  ]) await t.test(JSON.stringify([before, afterSchema, direction]), async () => {
    assert.equal((await compare(before, afterSchema, direction)).compatibility, expected);
  });
});

test('formatting and ordering preserve normalized schema meaning', async () => {
  const before = { type: 'object', properties: { a: { type: 'string', enum: ['a', 'b'] }, z: { type: 'integer' } }, required: ['a', 'z'] };
  const afterSchema = { required: ['z', 'a'], properties: { z: { type: 'integer' }, a: { enum: ['b', 'a'], type: 'string' } }, type: 'object' };
  const report = await compare(before, afterSchema, 'input');
  assert.equal(report.contentChanged, true);
  assert.equal(report.structuralChanged, false);
  assert.equal(report.metadataChanged, false);
  assert.equal(report.base.semanticDigest, report.revision.semanticDigest);
  assert.equal(report.compatibility, 'compatible');
});

test('descriptive annotation changes require review and never authorize an action', async () => {
  const before = object(['name']);
  const afterSchema = structuredClone(before);
  afterSchema.properties.name.description = 'Provider prose containing an untrusted requested action.';
  const report = await compare(before, afterSchema, 'input');
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.compatibility, 'unknown');
  assert.equal(report.structuralChanged, false);
  assert.equal(report.metadataChanged, true);
  assert.notEqual(report.base.semanticDigest, report.revision.semanticDigest);
  assert.ok(report.limitations.some((item) => item.includes('never authorize actions')));
});

test('structural breaks remain visible alongside metadata changes', async () => {
  const report = await compare(object(), { ...object(['name']), description: 'New version.' }, 'input');
  assert.equal(report.status, 'breaking-changes');
  assert.equal(report.compatibility, 'breaking');
  assert.equal(report.metadataChanged, true);
});

test('provided schema exports do not establish API behavior or import applications', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network access is forbidden in this local test.'); };
  try {
    const basePath = await file(object(), 'database-schema-export.json');
    const revisionPath = await file(object(['name']), 'framework-schema-export.json');
    const report = await compareJsonSchemas({ basePath, revisionPath, direction: 'input' });
    assert.equal(report.status, 'breaking-changes');
    assert.ok(report.limitations.some((item) => item.includes('does not establish API authorization')));
    const modulePath = await file('throw new Error("Application must never start"); export default {};', 'application.mjs');
    await assert.rejects(loadJsonSchema(modulePath), { name: 'PlumberError', code: 'INVALID_INPUT' });
  } finally { globalThis.fetch = originalFetch; }
});

test('raw examples retain observed data without inferring a schema or required fields', async () => {
  const data = { name: 'Ada', optionalInReality: 42, nested: { id: 1 } };
  const snapshot = await loadJsonExample(await file(data));
  assert.equal(snapshot.kind, 'observed-example');
  assert.equal(snapshot.inference, 'none');
  assert.equal(snapshot.requiredFields, 'unknown');
  assert.equal(snapshot.compatibility, 'not-established');
  assert.deepEqual(snapshot.value, data);
  assert.equal(Object.hasOwn(snapshot, 'schema'), false);
  assert.throws(() => { snapshot.value.nested.id = 2; }, TypeError);
});

test('schema-shaped examples remain examples unless explicitly loaded as declared schemas', async () => {
  const path = await file(object(['name']));
  const example = await loadJsonExample(path);
  const schema = await loadJsonSchema(path);
  assert.equal(example.kind, 'observed-example');
  assert.equal(example.requiredFields, 'unknown');
  assert.equal(example.inference, 'none');
  assert.equal(schema.kind, 'declared-schema');
  assert.equal(schema.sha256, example.sha256);
});

test('missing example fields never establish a removed property or breaking contract', async () => {
  const basePath = await file({ name: 'Ada', lastSeen: '2026-10-07' });
  const revisionPath = await file({ name: 'Ada' });
  const report = await compareJsonExamples({ basePath, revisionPath });
  assert.equal(report.valueChanged, true);
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.compatibility, 'not-established');
  assert.equal(report.requiredFields, 'unknown');
  assert.equal(report.inference, 'none');
  assert.equal(Object.hasOwn(report, 'changes'), false);
  assert.equal(Object.hasOwn(report, 'schema'), false);
});

test('identical observed values still cannot establish compatibility', async () => {
  const report = await compareJsonExamples({ basePath: await file('{"a":1,"b":2}'), revisionPath: await file('{ "b": 2, "a": 1 }') });
  assert.equal(report.contentChanged, true);
  assert.equal(report.valueChanged, false);
  assert.equal(report.base.valueDigest, report.revision.valueDigest);
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.compatibility, 'not-established');
});

test('example arrays preserve order and primitive JSON values remain observations', async (t) => {
  for (const value of [null, true, false, 2, ['x', 'y']]) await t.test(JSON.stringify(value), async () => {
    const snapshot = await loadJsonExample(await file(value));
    assert.deepEqual(snapshot.value, value);
    assert.equal(snapshot.inference, 'none');
  });
  assert.equal((await compareJsonExamples({ basePath: await file([1, 2]), revisionPath: await file([2, 1]) })).valueChanged, true);
});

test('unsupported schemas fail explicitly instead of producing compatible results', async (t) => {
  for (const value of [
    false, { $ref: 'file:///private.json' }, { type: ['null', 'string'] },
    { type: 'number', minimum: 0 }, { type: 'object', patternProperties: {} },
    { type: 'string', pattern: '.*' }, { allOf: [{ type: 'object' }] },
    { type: 'object', properties: { child: { type: 'string' } }, additionalProperties: { type: 'string' } },
  ]) await t.test(JSON.stringify(value), async () => {
    const path = await file(value);
    await assert.rejects(loadJsonSchema(path), { name: 'PlumberError', code: 'UNSUPPORTED_CONTRACT' });
    await assert.rejects(compareJsonSchemas({ basePath: path, revisionPath: path, direction: 'input' }), { code: 'UNSUPPORTED_CONTRACT' });
  });
});

test('local loaders enforce byte, depth, encoding, finite-number and destination limits', async (t) => {
  for (const [label, bytes] of [
    ['JSON syntax', '{'], ['UTF-8', Buffer.from([0xff])], ['size', Buffer.alloc(4 * 1024 * 1024 + 1, 32)],
    ['depth', '{"x":'.repeat(65) + 'null' + '}'.repeat(65)], ['nonfinite number', '{"value":1e400}'],
  ]) await t.test(label, async () => {
    const path = await file(bytes);
    for (const load of [loadJsonSchema, loadJsonExample]) await assert.rejects(load(path), { name: 'PlumberError', code: 'INVALID_INPUT' });
  });
  for (const load of [loadJsonSchema, loadJsonExample]) await assert.rejects(load('https://example.invalid/schema.json'), { code: 'INVALID_INPUT' });
});

test('numeric identities that JSON.parse would round or underflow are rejected before compatibility analysis', async (t) => {
  for (const token of ['9007199254740992', '9007199254740993', '-9007199254740993', '0.10000000000000001', '1.0000000000000001', '1e-400', '-1e-400']) {
    await t.test(token, async () => {
      const schemaPath = await file(`{"type":"number","enum":[${token}]}`);
      const examplePath = await file(`{"value":${token}}`);
      await assert.rejects(loadJsonSchema(schemaPath), { code: 'UNSUPPORTED_CONTRACT' });
      await assert.rejects(loadJsonExample(examplePath), { code: 'UNSUPPORTED_CONTRACT' });
      await assert.rejects(compareJsonSchemas({ basePath: schemaPath, revisionPath: schemaPath, direction: 'input' }), { code: 'UNSUPPORTED_CONTRACT' });
    });
  }
});

test('equivalent decimal spellings remain supported without scanning quoted strings as numbers', async () => {
  const before = await file('{"type":"number","enum":[1e2,0.10,1.2300e-2],"description":"9007199254740993 and 0.10000000000000001 are literal text"}');
  const afterSchema = await file('{"type":"number","enum":[100,0.1,0.0123],"description":"9007199254740993 and 0.10000000000000001 are literal text"}');
  const report = await compareJsonSchemas({ basePath: before, revisionPath: afterSchema, direction: 'input' });
  assert.equal(report.compatibility, 'compatible');
  assert.equal(report.base.semanticDigest, report.revision.semanticDigest);
  const examples = await compareJsonExamples({ basePath: await file('{"n":5e-324}'), revisionPath: await file('{"n":5e-324}') });
  assert.equal(examples.valueChanged, false);
  const quotedText = JSON.stringify('escaped quote " 9007199254740993');
  const safe = await loadJsonExample(await file(`{"max":9007199254740991,"min":-9007199254740991,"zero":-0,"text":${quotedText}}`));
  assert.equal(safe.value.max, Number.MAX_SAFE_INTEGER);
  assert.equal(safe.value.min, Number.MIN_SAFE_INTEGER);
  assert.equal(Object.is(safe.value.zero, -0), true);
  await assert.rejects(loadJsonExample(await file(`{"n":0.${'0'.repeat(255)}1}`)), { code: 'UNSUPPORTED_CONTRACT' });
});
