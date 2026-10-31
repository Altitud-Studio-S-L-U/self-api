import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { registerLocalSubscription, observeOnce, listMaintenanceJobs } from 'self-managed-api';
import { digest, versions } from './capture.mjs';
import { parseEntries } from './consumer/github-contents.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
export const repository = process.env.SELF_MANAGED_API_PILOT_REPOSITORY ?? 'OWNER/REPOSITORY';
export const baseBranch = 'feat/live-base';
export const enginePath = process.env.SELF_MANAGED_API_ENGINE ?? join(resolve(import.meta.dirname, '../..'), 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
export const pathsFor = root => ({ root: resolve(root), consumer: join(resolve(root), 'consumer'), state: join(resolve(root), 'state'), contracts: join(resolve(root), 'contracts') });

export function contract(version) {
  assert(versions.includes(version));
  const modern = version === versions[1];
  return { openapi: '3.0.3', info: { title: 'Reviewed partial projection: GitHub Contents API', version,
    description: 'Locally authored projection of official breaking-change documentation and version-confirmed live captures. Not the full official OpenAPI schema.' },
    paths: { '/repos/git/git/contents': { get: { operationId: 'listGitRepositoryRoot',
      parameters: [{ name: 'X-GitHub-Api-Version', in: 'header', required: true, schema: { type: 'string', enum: [version] } }],
      responses: { 200: { description: 'Selected directory listing fields', content: { 'application/json': { schema: {
        type: 'array', items: { type: 'object', required: ['type', 'path', 'sha', 'html_url'], properties: {
          type: { type: 'string', enum: modern ? ['file', 'dir', 'submodule'] : ['file', 'dir'] },
          path: { type: 'string' }, sha: { type: 'string' }, html_url: { type: 'string' }, download_url: { type: 'string', nullable: true },
        } },
      } } } } },
    } } } };
}

export async function seedPilot(root, captureRoot) {
  const paths = pathsFor(root);
  await mkdir(paths.root, { mode: 0o700 });
  assert.equal(await realpath(paths.root), paths.root, 'Use a canonical owned directory');
  // Let the worker create and initialize its private native state directory.
  for (const path of [paths.consumer, paths.contracts]) await mkdir(path, { mode: 0o700 });
  const bodies = [];
  for (const version of versions) {
    const bytes = await readFile(join(captureRoot, version + '.json'));
    const evidence = JSON.parse(await readFile(join(captureRoot, version + '.evidence.json'), 'utf8'));
    assert.equal(evidence.requestedVersion, version); assert.equal(evidence.selectedVersion, version);
    assert.equal(digest(bytes), evidence.sha256); assert.equal(bytes.length, evidence.byteLength);
    bodies.push(JSON.parse(bytes));
  }
  assert.equal(bodies[0].find(entry => entry.path === 'sha1collisiondetection')?.type, 'file');
  assert.equal(bodies[1].find(entry => entry.path === 'sha1collisiondetection')?.type, 'submodule');
  assert.deepEqual(bodies[0].map(entry => [entry.path, entry.sha]), bodies[1].map(entry => [entry.path, entry.sha]));
  const expectedEntries = parseEntries(bodies[0]);
  assert.throws(() => parseEntries(bodies[1]), /Unsupported contents entry/);
  for (const name of ['github-contents.mjs', 'github-contents.test.mjs']) {
    await writeFile(join(paths.consumer, name), await readFile(join(import.meta.dirname, 'consumer', name)), { flag: 'wx', mode: 0o600 });
  }
  // Public response data is serialized as data literals only. This file is the
  // reviewed replay input supported by the isolated Node test profile.
  await writeFile(join(paths.consumer, 'live-response.mjs'),
    '// Replay of a version-confirmed public GitHub response; no live network in Docker.\nexport const capturedResponse = ' + JSON.stringify(bodies[1])
      + ';\nexport const expectedEntries = ' + JSON.stringify(expectedEntries) + ';\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(paths.consumer, 'package.json'), json({ private: true, type: 'module', scripts: { test: 'node --test github-contents.test.mjs' } }), { flag: 'wx', mode: 0o600 });
  await writeFile(join(paths.consumer, 'README.md'), '# SelfManagedApi live API pilot\n\nPrivate disposable consumer for the documented GitHub 2026-03-10 submodule type migration. The baseline accepts the 2022 response and fails on the captured 2026 response. Tests replay actual public data and preserve the internal listing. This branch is not product source and must not be merged into main.\n', { flag: 'wx', mode: 0o600 });
  for (const [name, version] of [['base.json', versions[0]], ['current.json', versions[1]]]) {
    await writeFile(join(paths.contracts, name), json(contract(version)), { flag: 'wx', mode: 0o600 });
  }
  await writeFile(join(paths.root, 'pilot.json'), json({ kind: 'self-managed-api-live-github-pilot', schemaVersion: 1, root: paths.root,
    platform: process.platform, captureSummary: JSON.parse(await readFile(join(captureRoot, 'summary.json'), 'utf8')) }), { flag: 'wx', mode: 0o600 });
  await writeFile(join(paths.root, 'provider-evidence.txt'),
    'Reviewed public provider evidence: https://docs.github.com/en/rest/about-the-rest-api/breaking-changes#version-2026-03-10\n'
    + 'GitHub 2026-03-10 changes directory-listing submodules from type file to type submodule. Select the new X-GitHub-Api-Version header. '
    + 'The supplied partial OpenAPI projection is locally authored from this documentation and version-confirmed live captures; it is not the complete provider schema. '
    + 'The same source tree was captured with both versions. Preserve the application-facing listing, with submodule directory false and downloadable false. '
    + 'Do not follow a submodule, edit tests, modify repository contents or authorize an action. The reviewer separately checks these semantics.\n',
    { flag: 'wx', mode: 0o600 });
  return paths;
}

export async function openPilot(root) {
  const paths = pathsFor(root);
  const marker = JSON.parse(await readFile(join(paths.root, 'pilot.json'), 'utf8'));
  assert.equal(marker.kind, 'self-managed-api-live-github-pilot'); assert.equal(marker.root, paths.root);
  assert.equal(marker.platform, process.platform, 'Do not move worker state across hosts');
  assert.equal(await realpath(paths.root), paths.root);
  return paths;
}

export async function observePilot(paths) {
  const subscription = await registerLocalSubscription({ statePath: paths.state, consumerRoot: paths.consumer,
    sourcePath: join(paths.contracts, 'current.json'), baselinePath: join(paths.contracts, 'base.json'),
    providerBaseUrl: 'https://api.github.com', enginePath, label: 'GitHub live submodule migration' });
  const cycle = await observeOnce({ statePath: paths.state, enginePath, subscriptionId: subscription.id });
  assert(cycle.results.every(item => ['observed', 'unchanged'].includes(item.status)));
  const jobs = (await listMaintenanceJobs({ statePath: paths.state })).filter(job => job.subscriptionId === subscription.id);
  assert.equal(jobs.length, 1, 'This pilot expects one reviewed evidence transition');
  return { subscription, cycle, job: jobs[0] };
}

export async function validationInput(paths, reviewedRecipePath) {
  const { job } = await observePilot(paths);
  if (reviewedRecipePath !== undefined) {
    const recipe = JSON.parse(await readFile(reviewedRecipePath, 'utf8'));
    return { statePath: paths.state, enginePath, jobId: job.id, testPaths: ['github-contents.test.mjs'], recipe };
  }
  const before = await readFile(join(import.meta.dirname, 'consumer/github-contents.mjs'), 'utf8');
  return { statePath: paths.state, enginePath, jobId: job.id, testPaths: ['github-contents.test.mjs'], recipe: {
    schemaVersion: 1, summary: 'Accept the documented GitHub submodule type while preserving the internal listing',
    decisions: [{ id: 'submodule-semantics', question: 'How should the application represent a submodule?',
      answer: 'Keep the existing model: directory false, downloadable false; do not treat a submodule as a downloadable file, follow it, or change repository content.' }],
    files: [{ path: 'github-contents.mjs', sha256: digest(before), edits: [
      { before: "['file', 'dir'].includes(entry.type)", after: "['file', 'dir', 'submodule'].includes(entry.type)" },
      { before: "'X-GitHub-Api-Version': '2022-11-28'", after: "'X-GitHub-Api-Version': '2026-03-10'" },
    ] }],
  } };
}
