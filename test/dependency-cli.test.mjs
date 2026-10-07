import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runDependencyCli } from '../dist/dependency-cli.js';

const parent = resolve('work/test-dependency-cli');
await mkdir(parent, { recursive: true });
const realParent = await realpath(parent);
const temporary = await mkdtemp(join(realParent, 'cli-'));
let sequence = 0;
after(async () => {
  const target = await realpath(temporary);
  assert.equal(dirname(target), realParent);
  assert.ok(basename(target).startsWith('cli-'));
  await rm(target, { recursive: true });
});
async function file(value) {
  const path = join(temporary, `${sequence++}.json`);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}
function lock() {
  return { lockfileVersion: 3, packages: {
    '': { dependencies: { client: '^1.0.0' } },
    'node_modules/client': { version: '1.2.3' },
  } };
}
function advisories(overrides = {}) {
  return { schemaVersion: 1, advisories: [{ id: 'FIXTURE-ADVISORY', ecosystem: 'npm', package: 'client', affectedVersions: ['1.2.3'], sourceURL: 'https://example.invalid/advisory', ...overrides }] };
}
async function capture(args) {
  let stdout = '';
  let stderr = '';
  const code = await runDependencyCli(args, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
  return { code, stdout, stderr };
}

test('deps-scan uses the real local parser and identifies limited evidence in text and JSON', async () => {
  const path = await file(lock());
  const text = await capture(['deps-scan', path]);
  assert.equal(text.code, 0);
  assert.equal(text.stderr, '');
  assert.match(text.stdout, /Dependency entries: 1; unresolved: 0/u);
  assert.match(text.stdout, /client 1\.2\.3: direct; recorded-version/u);
  assert.match(text.stdout, /Recorded versions do not verify installed files/u);
  assert.match(text.stdout, /No registry requests/u);
  assert.equal(text.stdout.includes(temporary), false);
  const json = await capture(['deps-scan', path, '--json']);
  assert.equal(json.code, 0);
  const inventory = JSON.parse(json.stdout);
  assert.equal(inventory.kind, 'npm-lockfile-inventory');
  assert.equal(inventory.dependencies[0].version, '1.2.3');
  assert.equal(inventory.declarations[0].exactVersion, null);
  assert.equal(inventory.installation, 'not-verified');
});

test('deps-scan exits one for unresolved versions or missing root declaration evidence', async () => {
  const unknown = lock();
  unknown.packages['node_modules/client'].version = 'latest';
  const unresolved = await capture(['deps-scan', await file(unknown)]);
  assert.equal(unresolved.code, 1);
  assert.match(unresolved.stdout, /unknown version/u);
  assert.equal(unresolved.stderr, '');
  const missing = lock();
  missing.packages[''].dependencies.other = '1.0.0';
  const result = await capture(['deps-scan', await file(missing)]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /declarations without a root entry: 1/u);
});

test('deps-audit exits one for a recorded affected exact version with explicit coverage limits', async () => {
  const lockfilePath = await file(lock());
  const advisoryPath = await file(advisories());
  const text = await capture(['deps-audit', lockfilePath, '--advisories', advisoryPath]);
  assert.equal(text.code, 1);
  assert.equal(text.stderr, '');
  assert.match(text.stdout, /affected-known-version/u);
  assert.match(text.stdout, /not a complete vulnerability assessment/u);
  assert.match(text.stdout, /Exploitability is not assessed/u);
  const json = await capture(['deps-audit', lockfilePath, '--advisories', advisoryPath, '--json']);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout).findings[0].status, 'affected-known-version');
});

test('deps-audit exits zero for unlisted versions or withdrawn records without claiming security', async () => {
  for (const value of [advisories({ affectedVersions: ['9.0.0'] }), advisories({ withdrawn: true }), { schemaVersion: 1, advisories: [] }]) {
    const result = await capture(['deps-audit', await file(lock()), '--advisories', await file(value)]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /unaffected only within the supplied list/u);
    assert.match(result.stdout, /not a complete vulnerability assessment/u);
  }
});

test('deps-audit exits one for unknown matches and unrelated unresolved dependency records', async () => {
  const unknown = await capture(['deps-audit', await file(lock()), '--advisories', await file(advisories({ package: 'absent' }))]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stdout, /unknown/u);
  const value = lock();
  value.packages['node_modules/other'] = { link: true, resolved: '../local-package' };
  const unrelated = await capture(['deps-audit', await file(value), '--advisories', await file({ schemaVersion: 1, advisories: [] })]);
  assert.equal(unrelated.code, 1);
  assert.match(unrelated.stdout, /Unresolved dependency entries: 1/u);
});

test('invalid commands, duplicate options and stray positionals fail with sanitized argument errors', async () => {
  const path = await file(lock());
  const advisoryPath = await file(advisories());
  for (const args of [
    [], ['deps-scan'], ['deps-audit'], ['wrong-command', path],
    ['deps-scan', path, 'extra'], ['deps-audit', path, 'extra', '--advisories', advisoryPath],
    ['deps-scan', path, '--unknown-secret-option'], ['deps-scan', path, '--json=true'],
    ['deps-scan', path, '--json', '--json'], ['deps-scan', path, '--advisories', advisoryPath],
    ['deps-scan', '   '], ['deps-audit', path], ['deps-audit', path, '--advisories'],
    ['deps-audit', path, '--advisories', '   '],
    ['deps-audit', path, '--advisories', advisoryPath, '--advisories', advisoryPath],
    ['deps-audit', path, '--advisories', advisoryPath, '--json', '--json'],
  ]) {
    const result = await capture(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.stdout, '', JSON.stringify(args));
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
    assert.equal(result.stderr.includes('unknown-secret-option'), false);
    assert.equal(result.stderr.includes(temporary), false);
  }
});

test('malformed or unsupported local documents exit two without raw content or paths', async () => {
  for (const value of ['{', { lockfileVersion: 1 }, null]) {
    const result = await capture(['deps-scan', await file(value), '--json']);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(temporary), false);
  }
  const broken = await capture(['deps-audit', await file(lock()), '--advisories', await file({ schemaVersion: 1, advisories: [{ token: 'private-secret-marker' }] })]);
  assert.equal(broken.code, 2);
  assert.equal(broken.stderr.includes('private-secret-marker'), false);
  const missing = await capture(['deps-scan', join(temporary, 'secret-path-does-not-exist.json')]);
  assert.equal(missing.code, 2);
  assert.equal(missing.stderr.includes('secret-path-does-not-exist'), false);
});

test('text and JSON omit resolved credentials, integrity and private selectors', async () => {
  const secret = 'PRIVATE-CREDENTIAL-FIXTURE';
  const value = lock();
  value.packages[''].dependencies.client = `git+https://user:${secret}@example.invalid/client`;
  value.packages['node_modules/client'].resolved = `https://user:${secret}@example.invalid/client.tgz`;
  value.packages['node_modules/client'].integrity = secret;
  value.packages[`private/${secret}`] = { version: '1.0.0' };
  const path = await file(value);
  const advisoryPath = await file(advisories());
  for (const args of [
    ['deps-scan', path], ['deps-scan', path, '--json'],
    ['deps-audit', path, '--advisories', advisoryPath], ['deps-audit', path, '--advisories', advisoryPath, '--json'],
  ]) {
    const result = await capture(args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.stdout.includes(temporary), false);
  }
});

test('local dependency commands never fetch references or execute consumer scripts', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network allowed in the dependency CLI.'); };
  try {
    const value = lock();
    value.packages[''].scripts = { postinstall: 'untrusted script content' };
    value.packages['node_modules/client'].hasInstallScript = true;
    assert.equal((await capture(['deps-scan', await file(value)])).code, 0);
    assert.equal((await capture(['deps-audit', await file(value), '--advisories', await file(advisories())])).code, 1);
    assert.equal((await capture(['deps-scan', 'https://example.invalid/package-lock.json'])).code, 2);
  } finally { globalThis.fetch = original; }
});
