import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureHttpSource, prepareHttpSource, registerHttpSourceSubscription, registerLocalSubscription, scanConsumer } from 'plumber';
import { providers, providerManifest } from './catalog.mjs';

export const repositoryRoot = resolve(import.meta.dirname, '../..');
export const defaultRoot = join(repositoryRoot, 'work/real-apis');
export const enginePath = join(repositoryRoot, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
export const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
async function missing(path, content) {
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export function notionContract(version) {
  const modern = version === '2025-09-03';
  if (!modern && version !== '2022-06-28') throw new Error('Unknown exercise version');
  const parameter = modern ? 'data_source_id' : 'database_id';
  return { openapi: '3.0.3', info: { title: 'Keepseam exercise projection: Notion query (partial, authored locally)', version,
    description: 'Exercise subset derived from the public migration guide. Not an official or complete Notion OpenAPI specification; no retirement claim.' },
  paths: { [`/v1/${modern ? 'data_sources' : 'databases'}/{${parameter}}/query`]: { post: {
    operationId: modern ? 'queryDataSource' : 'queryDatabase',
    parameters: [{ name: parameter, in: 'path', required: true, schema: { type: 'string' } },
      { name: 'Notion-Version', in: 'header', required: true, schema: { type: 'string', enum: [version] } }],
    responses: { 200: { description: 'Selected page list projection', content: { 'application/json': { schema: {
      type: 'object', required: ['results', 'has_more', 'next_cursor'], properties: {
        results: { type: 'array', items: { type: 'object', properties: { object: { type: 'string', enum: ['page'] }, id: { type: 'string' } }, required: ['object', 'id'] } },
        has_more: { type: 'boolean' }, next_cursor: { type: 'string', nullable: true },
      },
    } } } } },
  } } } };
}

export async function seed(root = defaultRoot) {
  root = resolve(root);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error('Lab root must be a canonical directory');
  const marker = { kind: 'keepseam-real-api-lab', schemaVersion: 1, root, platform: process.platform };
  try { if (json(JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'))) !== json(marker)) throw new Error('Lab belongs to a different path or host'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(root)).length) throw new Error('Refusing nonempty unowned lab directory');
    await missing(join(root, 'environment.json'), json(marker));
  }
  const paths = { root, consumer: join(root, 'consumer'), state: join(root, 'state'), sources: join(root, 'sources'), contracts: join(root, 'contracts') };
  for (const path of [paths.consumer, paths.state, paths.sources, paths.contracts, join(paths.consumer, 'adapters')]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Lab directories cannot be symlinks');
    if (process.platform !== 'win32') await chmod(path, 0o700);
  }
  for (const name of ['notion.mjs', 'notion.test.mjs']) await missing(join(paths.consumer, name), await readFile(join(import.meta.dirname, 'consumer', name)));
  await missing(join(paths.consumer, 'package.json'), json({ private: true, type: 'module', dependencies: { '@notionhq/client': '4.0.2' }, scripts: { test: 'node --test notion.test.mjs' } }));
  for (const provider of providers) {
    const options = { method: provider.method, ...(provider.selectorName ? { headers: { [provider.selectorName]: provider.version } } : {}) };
    await missing(join(paths.consumer, 'adapters', `${provider.id}.mjs`),
      `// Local exercise. The development server supplies a transport which cannot call this provider.\nexport async function call() {\n  const response = await fetch(${JSON.stringify(provider.origin + provider.path)}, ${JSON.stringify(options)});\n  if (!response.ok) throw new Error('Upstream request failed: ' + response.status);\n  return response.json();\n}\n`);
  }
  await missing(join(root, 'integrations.json'), json(providers.map(providerManifest)));
  await missing(join(paths.contracts, 'notion-old.json'), json(notionContract('2022-06-28')));
  await missing(join(paths.contracts, 'notion-new.json'), json(notionContract('2025-09-03')));
  await missing(join(paths.contracts, 'notion-current.json'), json(notionContract('2022-06-28')));
  return paths;
}

export async function selectVersion(version, root = defaultRoot) {
  const paths = await seed(root);
  const bytes = json(notionContract(version));
  const temporary = join(paths.contracts, `.current-${randomUUID()}.json`);
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(paths.contracts, 'notion-current.json'));
  return { version, simulatedProvider: true, liveProviderRetirementClaim: false };
}

export async function registerNotion(paths) {
  return registerLocalSubscription({ statePath: paths.state, consumerRoot: paths.consumer,
    sourcePath: join(paths.contracts, 'notion-current.json'), baselinePath: join(paths.contracts, 'notion-old.json'),
    providerBaseUrl: 'https://api.notion.com', enginePath, label: 'Notion query migration · local exercise' });
}

export async function migrationRecipe(paths, { sourceSelected = true } = {}) {
  // Recipes target this checked-in baseline, never arbitrary edited source with a freshly blessed hash.
  const original = await readFile(join(import.meta.dirname, 'consumer/notion.mjs'));
  return { schemaVersion: 1, summary: 'Notion query: explicit data source selection; preserve the application page-list contract',
    decisions: [{ id: 'data-source', question: 'Which data source replaces the database for this integration?',
      ...(sourceSelected ? { answer: 'This local exercise supplies context.dataSourceId from explicit application configuration. Never reuse databaseId or select the first source automatically. Confirm the source and access permissions for a real account.' } : {}) },
    { id: 'sdk', question: 'Has the application reviewed the SDK dependency update independently?',
      answer: 'Use @notionhq/client 5.27.0 for the exercise candidate, with notionVersion 2025-09-03. The manifest is not auto-edited or installed by this recipe; the dedicated SDK test uses both pinned major versions.' }],
    files: [{ path: 'notion.mjs', sha256: hash(original), edits: [
      { before: 'export async function queryNative(context) {', after: "export async function queryNative(context) {\n  if (typeof context.dataSourceId !== 'string' || !context.dataSourceId) throw new Error('Select a data source explicitly');" },
      { before: '/v1/databases/${encodeURIComponent(context.databaseId)}/query', after: '/v1/data_sources/${encodeURIComponent(context.dataSourceId)}/query' },
      { before: "'Notion-Version': '2022-06-28'", after: "'Notion-Version': '2025-09-03'" },
      { before: 'export async function querySdk(notion, context) {', after: "export async function querySdk(notion, context) {\n  if (typeof context.dataSourceId !== 'string' || !context.dataSourceId) throw new Error('Select a data source explicitly');" },
      { before: 'notion.databases.query({ database_id: context.databaseId, page_size: 20 })', after: 'notion.dataSources.query({ data_source_id: context.dataSourceId, page_size: 20 })' },
    ] }] };
}

export async function fetchDocumentation(paths, report = () => {}) {
  const results = [];
  for (const provider of providers) {
    try {
      const url = provider.capture ?? provider.documentation;
      const source = prepareHttpSource({ url, allowedOrigins: [new URL(url).origin], contentKind: 'text', maximumBytes: 2 * 1024 * 1024, timeoutMs: 15_000 });
      const capture = await captureHttpSource({ source });
      const baselinePath = join(paths.sources, `${provider.id}.baseline.txt`);
      await missing(baselinePath, capture.snapshot.bytes);
      const subscription = await registerHttpSourceSubscription({ statePath: paths.state, kind: 'documentation', source, baselinePath,
        consumerRoot: paths.consumer, label: `${provider.name} official public documentation` });
      // Public downloaded content remains ignored local evidence; it is never loaded as code.
      await writeFile(join(paths.sources, `${provider.id}.capture.json`), json({ url, sha256: capture.snapshot.sha256,
        capturedAt: capture.snapshot.capturedAt, bytes: capture.snapshot.byteLength, subscriptionId: subscription.id }), { mode: 0o600 });
      results.push({ provider: provider.id, status: 'captured', bytes: capture.snapshot.byteLength, sha256: capture.snapshot.sha256, subscriptionId: subscription.id });
    } catch (error) { results.push({ provider: provider.id, status: 'failed', reason: error.reason ?? error.code ?? 'capture-failed' }); }
    report(results.at(-1));
  }
  await writeFile(join(paths.root, 'documentation-results.json'), json(results), { mode: 0o600 });
  return results;
}

export async function inventory(paths) {
  const result = await scanConsumer(paths.consumer);
  return { providers: providers.map(({ id, name, version, change }) => ({ id, name, version, change })), inventory: result,
    execution: 'simulated-provider-only', sourceCoverage: 'selected-pages', sdkCallMapping: 'explicit-boundary-required' };
}
