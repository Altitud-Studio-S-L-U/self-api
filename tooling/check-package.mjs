import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pnpmPath = process.env.npm_execpath;
assert.ok(pnpmPath && isAbsolute(pnpmPath), 'Run this package check with pnpm run test:package.');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const work = join(root, 'work');
await mkdir(work, { recursive: true });
const directory = await mkdtemp(join(work, 'package-check-'));
const consumer = join(directory, 'consumer');
const environment = {
  ...process.env,
  COREPACK_ENABLE_NETWORK: '0',
  npm_config_offline: 'true',
  npm_config_update_notifier: 'false',
};

function run(args, cwd, timeout = 60_000) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, 'Package check subprocess must finish normally.');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  await mkdir(consumer);
  const packed = run([pnpmPath, 'pack', '--out', join(directory, 'keepseam-client.tgz'), '--json'], root);
  // pnpm places the JSON manifest after any stdout from our prepack build.
  const packageContents = JSON.parse(packed.stdout.slice(packed.stdout.lastIndexOf('\n{') + 1));
  assert.ok(Array.isArray(packageContents.files) && packageContents.files.length > 0);
  for (const { path } of packageContents.files) {
    assert.ok(['package.json', 'README.md', 'dist/oasdiff-release.json'].includes(path) ||
      /^dist\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|d\.ts)$/u.test(path),
    `Unexpected packaged file: ${path}`);
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'keepseam-package-consumer-fixture',
    private: true,
    type: 'module',
    packageManager: manifest.packageManager,
    dependencies: { 'keepseam-client': 'file:../keepseam-client.tgz' },
    devDependencies: {
      typescript: manifest.devDependencies.typescript,
      '@types/node': manifest.devDependencies['@types/node'],
    },
  }));
  // The consumer installs the tarball and existing toolchain from the cache; no lifecycle scripts run.
  run([pnpmPath, 'install', '--offline', '--ignore-scripts', '--ignore-workspace'], consumer);
  await copyFile(join(root, 'fixtures', 'orders-v1.json'), join(consumer, 'base.json'));
  await copyFile(join(root, 'fixtures', 'orders-v2.json'), join(consumer, 'revision.json'));
  await writeFile(join(consumer, 'use-sdk.mjs'), `
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareOpenApi, compareMcpCatalogs, compareJsonSchemas, prepareModelProposal, runWorkerLoop, normalizeIntegrationManifest, preparePublicationRequest, createGitHubPublicationAdapter, observeSourcesOnce, loadNpmDependencyInventory, prepareHttpSource, captureHttpSource, analyzeMcpImpact, registerHttpSubscription, registerHttpSourceSubscription, runWorkerService, normalizeWorkerServiceConfig, renderWorkerServiceManifest } from 'keepseam-client';
import { runCli } from 'keepseam-client/cli';
import { negotiateCloudProtocol, encodeCloudStatusEvent } from 'keepseam-client/protocol';

for (const api of [compareMcpCatalogs, compareJsonSchemas, prepareModelProposal, runWorkerLoop, normalizeIntegrationManifest, preparePublicationRequest, createGitHubPublicationAdapter, observeSourcesOnce, loadNpmDependencyInventory, encodeCloudStatusEvent, prepareHttpSource, captureHttpSource, analyzeMcpImpact, registerHttpSubscription, registerHttpSourceSubscription, runWorkerService, normalizeWorkerServiceConfig, renderWorkerServiceManifest, runCli]) assert.equal(typeof api, 'function');
assert.deepEqual(negotiateCloudProtocol([1]), { status: 'compatible', version: 1 });

const installed = await realpath(join(import.meta.dirname, 'node_modules'));
const entry = await realpath(fileURLToPath(import.meta.resolve('keepseam-client')));
const location = relative(installed, entry);
assert.ok(location && !isAbsolute(location) && location !== '..' && !location.startsWith('..' + sep),
  'The SDK must resolve from the installed consumer package.');
const report = await compareOpenApi({
  basePath: join(import.meta.dirname, 'base.json'),
  revisionPath: join(import.meta.dirname, 'revision.json'),
  enginePath: process.argv[2],
});
assert.equal(report.status, 'breaking-changes');
assert.ok(report.changes.some(change => change.id.includes('required') && change.text.includes('region')));
assert.ok(report.changes.some(change => change.id.includes('property') && change.text.includes('total')));
for (const path of ['keepseam-client/dist/index.js', 'keepseam-client/dist/compare.js', 'keepseam-client/package.json']) {
  await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
`);
  await writeFile(join(consumer, 'use-types.ts'), `
import { compareOpenApi, type CompareOptions, type ComparisonReport, type GitPublicationAdapter, type ModelProposalAdapter, type SourceSubscriptionOptions, type HttpSourcePolicy, type McpImpactOptions } from 'keepseam-client';
import { validateCloudStatusEvent, type CloudStatusEvent } from 'keepseam-client/protocol';

const compare: (options: CompareOptions) => Promise<ComparisonReport> = compareOpenApi;
const options: CompareOptions = { basePath: 'base.json', revisionPath: 'revision.json', enginePath: 'oasdiff' };
void compare;
void options;
const validateEvent: (input: unknown) => CloudStatusEvent = validateCloudStatusEvent;
type CustomerAdapters = { git: GitPublicationAdapter; model: ModelProposalAdapter; source: SourceSubscriptionOptions; http: HttpSourcePolicy; mcp: McpImpactOptions };
void validateEvent;
`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: ['node'],
      skipLibCheck: false,
    },
    files: ['use-types.ts'],
  }));
  run([pnpmPath, 'exec', 'tsc', '--project', 'tsconfig.json'], consumer);
  const runtime = run([
    join(consumer, 'use-sdk.mjs'),
    join(root, 'work', 'tools', 'oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff'),
  ], consumer);
  assert.equal(runtime.stdout, '', 'Importing and using the SDK must not print to stdout.');
  assert.equal(runtime.stderr, '', 'Importing and using the SDK must not emit warnings.');
  const cli = run([pnpmPath, 'exec', 'keepseam', '--help'], consumer);
  assert.equal(cli.stderr, '');
  assert.match(cli.stdout, /keepseam compare <base\.json> <revision\.json>/u);
  process.stdout.write('Packed package passed: public SDK import, NodeNext types, installed CLI, private subpaths, and package contents.\n');
} finally {
  const actualWork = await realpath(work);
  const actualDirectory = await realpath(directory);
  const owned = relative(actualWork, actualDirectory);
  assert.ok(!isAbsolute(owned) && owned.startsWith('package-check-') && !owned.includes(sep),
    'Package-check cleanup must stay in its owned directory inside work.');
  await rm(actualDirectory, { recursive: true, force: true });
}
