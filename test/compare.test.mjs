import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { compareOpenApi, PlumberError } from '../dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
const basePath = join(root, 'fixtures/orders-v1.json');
const revisionPath = join(root, 'fixtures/orders-v2.json');

async function fixture(t, change) {
  const work = join(root, 'work/test-compare');
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const document = JSON.parse(await readFile(basePath, 'utf8'));
  change(document);
  const file = join(directory, 'revision.json');
  await writeFile(file, JSON.stringify(document));
  return file;
}

test('identifies a newly required query input and removed response property using the real engine', async () => {
  const baseBefore = await readFile(basePath);
  const revisionBefore = await readFile(revisionPath);
  const report = await compareOpenApi({ basePath, revisionPath, enginePath });
  assert.equal(report.status, 'breaking-changes');
  assert.equal(report.consumerImpact, 'not-analyzed');
  assert.equal(report.coverage, 'structural-contract-only');
  assert.equal(report.contentChanged, true);
  assert(report.changes.some(change => change.id.includes('required') && change.text.includes('region')));
  assert(report.changes.some(change => change.id.includes('property') && change.text.includes('total')));
  assert(report.changes.every(change => change.path === '/orders/{id}' && change.operation === 'GET'));
  assert.equal(report.base.sha256, createHash('sha256').update(baseBefore).digest('hex'));
  assert.equal(report.revision.apiVersion, '2026-02-01');
  assert.deepEqual(await readFile(basePath), baseBefore);
  assert.deepEqual(await readFile(revisionPath), revisionBefore);
  assert(!JSON.stringify(report).includes(root));
  assert(!JSON.stringify(report).includes('baseSource'));
});

test('unchanged and additive contracts do not falsely report breaking changes', async t => {
  const identical = await compareOpenApi({ basePath, revisionPath: basePath, enginePath });
  assert.equal(identical.status, 'no-breaking-changes');
  assert.equal(identical.contentChanged, false);
  const additivePath = await fixture(t, document => {
    document.paths['/orders/{id}'].get.parameters.push({
      name: 'expand', in: 'query', required: false, schema: { type: 'string' },
    });
  });
  const additive = await compareOpenApi({ basePath, revisionPath: additivePath, enginePath });
  assert.equal(additive.status, 'no-breaking-changes');
  assert.equal(additive.contentChanged, true);
  assert.deepEqual(additive.changes, []);
  assert.equal(additive.consumerImpact, 'not-analyzed');
});

test('semantically invalid OpenAPI is an error, never an empty successful comparison', async t => {
  const invalidPath = await fixture(t, document => {
    document.paths['/orders/{id}'].get.parameters[0].required = false;
  });
  await assert.rejects(compareOpenApi({ basePath, revisionPath: invalidPath, enginePath }),
    error => error instanceof PlumberError && error.code === 'INVALID_INPUT');
});

test('OpenAPI 3.1 internal references preserve structural findings with the real engine', async t => {
  const oldDocument = JSON.parse(await readFile(basePath, 'utf8'));
  const newDocument = JSON.parse(await readFile(revisionPath, 'utf8'));
  const files = [];
  for (const document of [oldDocument, newDocument]) {
    document.openapi = '3.1.0';
    const content = document.paths['/orders/{id}'].get.responses['200'].content['application/json'];
    document.components = { schemas: { Order: content.schema } };
    content.schema = { $ref: '#/components/schemas/Order' };
    files.push(await fixture(t, target => Object.assign(target, document)));
  }
  const report = await compareOpenApi({ basePath: files[0], revisionPath: files[1], enginePath });
  assert.equal(report.base.specificationVersion, '3.1.0');
  assert.equal(report.status, 'breaking-changes');
  assert(report.changes.some(change => change.id.includes('property') && change.text.includes('total')));
});

test('external references fail before an unavailable executable can run', async t => {
  const externalPath = await fixture(t, document => {
    document.paths['/orders/{id}'].get.responses['200'].content['application/json'].schema = {
      $ref: 'https://example.invalid/private.json',
    };
  });
  await assert.rejects(compareOpenApi({ basePath, revisionPath: externalPath, enginePath: 'absent-engine' }),
    error => error instanceof PlumberError && error.code === 'UNSUPPORTED_CONTRACT');
});

test('missing engines produce an actionable error without downloading or comparing', async () => {
  await assert.rejects(compareOpenApi({ basePath, revisionPath, enginePath: resolve(root, 'work/absent-engine') }),
    error => error instanceof PlumberError && error.code === 'ENGINE_UNAVAILABLE');
});

test('caller configuration cannot silence findings or change the engine version', async () => {
  const previous = process.env.OASDIFF_CONFIG;
  process.env.OASDIFF_CONFIG = 'missing-private-config.json';
  try {
    const report = await compareOpenApi({ basePath, revisionPath, enginePath });
    assert.equal(report.status, 'breaking-changes');
  } finally {
    if (previous === undefined) delete process.env.OASDIFF_CONFIG;
    else process.env.OASDIFF_CONFIG = previous;
  }
  await assert.rejects(compareOpenApi({ basePath, revisionPath, enginePath: process.execPath }),
    error => error instanceof PlumberError && error.code === 'ENGINE_UNAVAILABLE');
});
