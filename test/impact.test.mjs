import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { analyzeImpact, scanConsumer, PlumberError } from '../dist/index.js';

const root = resolve(import.meta.dirname, '..');
const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
const basePath = join(root, 'fixtures/orders-v1.json');
const revisionPath = join(root, 'fixtures/orders-v2.json');
const providerBaseUrl = 'https://orders.example.invalid';

async function consumer(t, source, manifest = { scripts: { test: 'node --test', start: 'node app.js' }, dependencies: { 'example-sdk': '^1.0.0' } }) {
  const work = join(root, 'work/test-impact');
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'orders.ts'), source);
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
  return directory;
}

test('connects real contract changes to a native consumer call and its JSON reads', async () => {
  const report = await analyzeImpact({ basePath, revisionPath, enginePath, providerBaseUrl, consumerRoot: join(root, 'fixtures/consumer') });
  assert.equal(report.comparison.changes.length, 2);
  assert.equal(report.matches.length, 2);
  assert.equal(report.inventory.calls.length, 1);
  assert.equal(report.inventory.calls[0].pathPattern, '/orders/{*}');
  assert(report.inventory.calls[0].responseFields.includes('total'));
  assert(report.matches.every(match => match.callIds.includes(report.inventory.calls[0].id)));
  assert.deepEqual(report.unmappedChangeIndexes, []);
  assert.equal(report.conclusion, 'review-required');
  assert.equal(report.inventory.codeExecuted, false);
});

test('matches origin, base-path boundary, and HTTP method without treating unrelated calls as affected', async t => {
  const consumerRoot = await consumer(t, [
    "fetch('https://orders.example.invalid/v1/orders/123?api_key=private-fixture');",
    "fetch('https://unrelated.example.invalid/v1/orders/123');",
    "fetch('https://orders.example.invalid/v10/orders/123');",
    "fetch('https://orders.example.invalid/v1/orders/123', { method: 'POST' });",
  ].join('\n'));
  const report = await analyzeImpact({ basePath, revisionPath, enginePath, consumerRoot, providerBaseUrl: `${providerBaseUrl}/v1` });
  assert(report.matches.every(match => match.callIds.length === 1 && match.callIds[0] === report.inventory.calls[0].id));
  assert.doesNotMatch(JSON.stringify(report), /private-fixture|api_key/);
});

test('dynamic usages and absent matches require review instead of proving compatibility', async t => {
  const consumerRoot = await consumer(t, 'export const run = (url: string) => fetch(url);');
  const report = await analyzeImpact({ basePath, revisionPath, enginePath, consumerRoot, providerBaseUrl });
  assert.deepEqual(report.matches, []);
  assert.deepEqual(report.unmappedChangeIndexes, [0, 1]);
  assert.equal(report.unresolvedCallIds.length, 1);
  assert.equal(report.conclusion, 'review-required');
  assert.equal(report.comparison.status, 'breaking-changes');
});

test('a concrete OpenAPI route takes precedence over a changed parameter route', async t => {
  const consumerRoot = await consumer(t, "fetch('https://orders.example.invalid/orders/search');");
  const base = JSON.parse(await readFile(basePath, 'utf8'));
  const revision = JSON.parse(await readFile(revisionPath, 'utf8'));
  const concrete = structuredClone(base.paths['/orders/{id}']);
  concrete.get.operationId = 'searchOrders';
  concrete.get.parameters = [];
  base.paths['/orders/search'] = concrete;
  revision.paths['/orders/search'] = concrete;
  const oldPath = join(consumerRoot, 'base.json');
  const newPath = join(consumerRoot, 'revision.json');
  await writeFile(oldPath, JSON.stringify(base));
  await writeFile(newPath, JSON.stringify(revision));
  const report = await analyzeImpact({ basePath: oldPath, revisionPath: newPath, enginePath, consumerRoot, providerBaseUrl });
  assert.equal(report.comparison.changes.length, 2);
  assert.deepEqual(report.matches, []);
  assert.deepEqual(report.unmappedChangeIndexes, [0, 1]);
  assert.equal(report.conclusion, 'review-required');
});

test('discovers declared dependency ranges and validation candidates without executing consumer content', async t => {
  const source = "import 'example-sdk'; import {writeFileSync} from 'node:fs'; writeFileSync('executed-marker','bad'); fetch('https://orders.example.invalid/orders/1');";
  const consumerRoot = await consumer(t, source, {
    scripts: { test: 'node -e "throw new Error(\'must not run\')"', postinstall: 'exit 99', typecheck: 'tsc --noEmit' },
    dependencies: { 'example-sdk': '^1.0.0' }, devDependencies: { 'test-tool': '2.0.0' },
  });
  const inventory = await scanConsumer(consumerRoot);
  assert(inventory.imports.some(item => item.packageName === 'example-sdk'));
  assert.deepEqual(inventory.packages[0].dependencies, [
    { name: 'example-sdk', range: '^1.0.0', kind: 'runtime' },
    { name: 'test-tool', range: '2.0.0', kind: 'development' },
  ]);
  assert.deepEqual(inventory.validationCandidates.map(item => item.script), ['test', 'typecheck']);
  assert(inventory.validationCandidates.every(item => item.execution === 'not-authorized'));
  assert.equal(inventory.codeExecuted, false);
  assert.equal(await readFile(join(consumerRoot, 'orders.ts'), 'utf8'), source);
  await assert.rejects(access(join(consumerRoot, 'executed-marker')));
  await assert.rejects(access(join(root, 'executed-marker')));
  assert.doesNotMatch(JSON.stringify(inventory), /writeFileSync|must not run.*executed-marker/);
});

test('inventory evidence changes when source or manifest changes', async t => {
  const consumerRoot = await consumer(t, "fetch('https://orders.example.invalid/orders/1');");
  const first = await scanConsumer(consumerRoot);
  assert.equal((await scanConsumer(consumerRoot)).digest, first.digest);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({ scripts: { test: 'new command' } }));
  assert.notEqual((await scanConsumer(consumerRoot)).digest, first.digest);
});

test('discovery output omits inline script secrets and credential-bearing dependency specifiers', async t => {
  const consumerRoot = await consumer(t, '', {
    scripts: { test: 'API_TOKEN=fixture-private-secret vitest' },
    dependencies: { 'private-sdk': 'git+https://user:fixture-private-secret@host.invalid/sdk.git' },
  });
  const inventory = await scanConsumer(consumerRoot);
  assert.equal(inventory.packages[0].dependencies[0].range, null);
  assert.match(inventory.validationCandidates[0].commandSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(inventory), /fixture-private-secret|API_TOKEN|host\.invalid|vitest/);
});

test('invalid manifests and credential-bearing subscription URLs fail explicitly', async t => {
  const consumerRoot = await consumer(t, '', { dependencies: { sdk: 42 } });
  await assert.rejects(scanConsumer(consumerRoot), error => error instanceof PlumberError && error.code === 'INVALID_INPUT');
  for (const url of ['not a url', 'file:///private', 'https://user:secret@example.invalid', 'https://example.invalid?token=secret', 'https://example.invalid#fragment']) {
    await assert.rejects(analyzeImpact({ basePath, revisionPath, enginePath, consumerRoot, providerBaseUrl: url }),
      error => error instanceof PlumberError && error.code === 'INVALID_INPUT' && !error.message.includes('secret'));
  }
});
