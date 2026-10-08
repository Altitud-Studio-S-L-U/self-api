import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client as LegacyNotion } from 'notion-v4';
import { Client as ModernNotion } from '@notionhq/client';
import { scanConsumer, defineIntegrationBoundary, getIntegrationBoundary, createMigrationPlan, observeOnce, listMaintenanceJobs } from 'plumber';
import { providers, providerManifest } from '../dev/real-apis/catalog.mjs';
import { seed, selectVersion, migrationRecipe, registerNotion, enginePath } from '../dev/real-apis/environment.mjs';
import { fixtureContext, pageResponse, simulatedNotion } from '../dev/real-apis/server.mjs';

async function fixture(t) {
  const parent = resolve('work/real-api-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  t.after(async () => { assert.equal(dirname(await realpath(root)), await realpath(parent)); await rm(root, { recursive: true }); });
  return seed(root);
}

test('ten real providers have source evidence, explicit versions and visible native call paths', async t => {
  const paths = await fixture(t);
  assert.equal(providers.length, 10);
  assert.equal(new Set(providers.map(value => value.id)).size, 10);
  for (const provider of providers) {
    const manifest = providerManifest(provider);
    const handler = async () => 'unchanged';
    assert.equal(defineIntegrationBoundary(manifest, handler), handler);
    assert.equal(getIntegrationBoundary(handler).boundaryId, provider.id);
    assert.equal(manifest.versionCoverage, 'listed-only');
  }
  const result = await scanConsumer(paths.consumer);
  for (const provider of providers) assert.ok(result.calls.some(value => value.location.file === `adapters/${provider.id}.mjs` && value.method === provider.method), provider.id);
  assert.ok(result.packages.flatMap(value => value.dependencies).some(value => value.name === '@notionhq/client'));
});

test('real legacy and modern Notion SDKs and native calls agree across a reviewed local migration', async t => {
  const paths = await fixture(t);
  const original = await readFile(join(paths.consumer, 'notion.mjs'), 'utf8');
  const old = await import(pathToFileURL(join(paths.consumer, 'notion.mjs')).href);
  let version = '2022-06-28';
  const calls = [];
  const transport = async (url, init) => { calls.push({ url, init }); return simulatedNotion(url, init, version); };
  t.mock.method(globalThis, 'fetch', transport);
  const legacy = new LegacyNotion({ auth: fixtureContext.token, notionVersion: version, fetch: transport, logger: () => {} });
  const expected = { ids: ['local-page-one'], hasMore: true, nextCursor: 'local-next-cursor' };
  assert.deepEqual(await old.querySdk(legacy, fixtureContext), expected);
  assert.deepEqual(await old.queryNative(fixtureContext), expected);
  version = '2025-09-03';
  await assert.rejects(old.queryNative(fixtureContext), /410/);
  await assert.rejects(old.querySdk(legacy, fixtureContext), error => error.status === 410);
  await selectVersion(version, paths.root);
  const subscription = await registerNotion(paths);
  const cycle = await observeOnce({ statePath: paths.state, enginePath, subscriptionId: subscription.id });
  const job = (await listMaintenanceJobs({ statePath: paths.state }))[0];
  assert.equal(cycle.results[0].jobId, job.id);
  assert.equal(job.report.comparison.status, 'breaking-changes');
  assert.ok(job.report.matches.some(value => value.callIds.length));
  const options = { basePath: join(paths.contracts, 'notion-old.json'), revisionPath: join(paths.contracts, 'notion-current.json'),
    consumerRoot: paths.consumer, providerBaseUrl: 'https://api.notion.com', enginePath };
  const undecided = await createMigrationPlan({ ...options, recipe: await migrationRecipe(paths, { sourceSelected: false }) });
  assert.equal(undecided.status, 'requires-decision'); assert.equal(undecided.files.length, 0);
  const plan = await createMigrationPlan({ ...options, recipe: await migrationRecipe(paths) });
  assert.equal(plan.authorization, 'not-granted');
  assert.deepEqual(plan.files.map(value => value.path), ['notion.mjs']);
  const candidatePath = join(paths.root, 'reviewed-notion.mjs');
  await writeFile(candidatePath, plan.files[0].after);
  const candidate = await import(pathToFileURL(candidatePath).href);
  const modern = new ModernNotion({ auth: fixtureContext.token, notionVersion: version, fetch: transport, retry: false, logger: () => {} });
  assert.deepEqual(await candidate.querySdk(modern, fixtureContext), expected);
  assert.deepEqual(await candidate.queryNative(fixtureContext), expected);
  assert.ok(calls.some(call => call.url.includes('/data_sources/')));
  const beforeMissing = calls.length;
  await assert.rejects(candidate.queryNative({ ...fixtureContext, dataSourceId: undefined }), /Select a data source/);
  await assert.rejects(candidate.querySdk(modern, { ...fixtureContext, dataSourceId: '' }), /Select a data source/);
  assert.equal(calls.length, beforeMissing);
  assert.deepEqual(candidate.pageIds(pageResponse), expected);
  assert.equal(await readFile(join(paths.consumer, 'notion.mjs'), 'utf8'), original, 'The live consumer remains unchanged');
});
