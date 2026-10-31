import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEntries } from './consumer/github-contents.mjs';

export const versions = Object.freeze(['2022-11-28', '2026-03-10']);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const origin = 'https://api.github.com';

// Fixed public read endpoints only. This consumer probe is distinct from the
// SDK's configurable, hardened documentation capture. It never reads a token.
export async function captureGitHub(path, version) {
  assert(versions.includes(version));
  assert(path === '/repos/git/git/commits/master'
    || /^\/repos\/git\/git\/contents\?ref=(?:master|[a-f0-9]{40})$/u.test(path));
  const endpoint = origin + path;
  const response = await fetch(endpoint, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity',
      'User-Agent': 'self-managed-api-live-validation/0.1.0', 'X-GitHub-Api-Version': version } });
  assert.equal(response.status, 200, 'Live GitHub must succeed; no fixture fallback');
  assert.equal(response.url, endpoint);
  assert(response.headers.get('content-type')?.startsWith('application/json'));
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1048576) throw new Error('Live response exceeded 1 MiB');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString('utf8'));
  const selectedVersion = response.headers.get('x-github-api-version-selected');
  assert.equal(selectedVersion, version, 'Server must confirm the requested version; stale/mismatched responses are not evidence');
  return { body, bytes, evidence: { endpoint, requestedVersion: version, selectedVersion,
    capturedAt: new Date().toISOString(), sha256: digest(bytes), byteLength: bytes.length } };
}

export async function captureLivePair(directory) {
  const root = resolve(directory);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const commit = await captureGitHub('/repos/git/git/commits/master', versions[0]);
  assert.match(commit.body.sha, /^[a-f0-9]{40}$/u);
  const captures = [];
  for (const [index, version] of versions.entries()) {
    const captured = await captureGitHub('/repos/git/git/contents?ref=' + (index === 0 ? commit.body.sha : 'master'), version);
    assert(Array.isArray(captured.body));
    await writeFile(join(root, version + '.json'), captured.bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(root, version + '.evidence.json'), JSON.stringify(captured.evidence, null, 2), { flag: 'wx', mode: 0o600 });
    captures.push(captured);
  }
  const blobs = body => body.map(entry => [entry.path, entry.sha]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(blobs(captures[0].body), blobs(captures[1].body), 'Branch moved: capture a fresh pair before comparing versions');
  assert.equal(captures[0].body.find(entry => entry.path === 'sha1collisiondetection')?.type, 'file');
  assert.equal(captures[1].body.find(entry => entry.path === 'sha1collisiondetection')?.type, 'submodule');
  const expectedEntries = parseEntries(captures[0].body);
  assert.throws(() => parseEntries(captures[1].body), /Unsupported contents entry/);
  await writeFile(join(root, 'expected-entries.json'), JSON.stringify(expectedEntries), { flag: 'wx', mode: 0o600 });
  const summary = { source: 'live-github-https', repository: 'git/git', commit: commit.body.sha,
    observations: captures.map(value => value.evidence), oldConsumerAgainstOldVersion: 'passed',
    oldConsumerAgainstNewVersion: 'failed-as-documented', legacyVersionRetired: false,
    documentation: 'https://docs.github.com/en/rest/about-the-rest-api/breaking-changes#version-2026-03-10' };
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv.length !== 3) throw new Error('Usage: node dev/live-validation/capture.mjs <new-owned-directory>');
  console.log(JSON.stringify(await captureLivePair(process.argv[2]), null, 2));
}
