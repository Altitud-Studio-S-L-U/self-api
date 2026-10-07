import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { analyzeNpmAdvisories, loadNpmAdvisories, loadNpmDependencyInventory, normalizeNpmAdvisories } from '../dist/dependency-inventory.js';

const parent = resolve('work/test-dependency-inventory');
await mkdir(parent, { recursive: true });
const realParent = await realpath(parent);
const temporary = await mkdtemp(join(realParent, 'inventory-'));
let sequence = 0;
after(async () => {
  const target = await realpath(temporary);
  assert.equal(dirname(target), realParent);
  assert.ok(basename(target).startsWith('inventory-'));
  await rm(target, { recursive: true });
});
async function file(value) {
  const path = join(temporary, `${sequence++}.json`);
  await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return path;
}
function lock(version = 3) {
  return { name: 'fictional-consumer', lockfileVersion: version, packages: {
    '': { name: 'fictional-consumer', dependencies: { client: '^1.0.0' } },
    'node_modules/client': { version: '1.2.3', resolved: 'https://registry.npmjs.org/client/-/client-1.2.3.tgz', integrity: 'ignored-integrity' },
    'node_modules/client/node_modules/transitive': { version: '2.3.4' },
  } };
}
function advisory(overrides = {}) {
  return { id: 'GHSA-fixture-one', ecosystem: 'npm', package: 'client', affectedVersions: ['1.2.3'], sourceURL: 'https://example.invalid/advisories/fixture-one', ...overrides };
}
function catalog(advisories = [advisory()]) { return { schemaVersion: 1, advisories }; }
async function correlate(lockfile, advisories = catalog()) {
  return analyzeNpmAdvisories({ lockfilePath: await file(lockfile), advisoryPath: await file(advisories) });
}

test('npm lockfile v2 and v3 retain package versions separately from declared selectors', async (t) => {
  for (const lockfileVersion of [2, 3]) await t.test(String(lockfileVersion), async () => {
    const value = lock(lockfileVersion);
    value.dependencies = { client: { version: '99.0.0' } };
    const path = await file(value);
    const bytes = await readFile(path);
    const result = await loadNpmDependencyInventory(path);
    assert.equal(result.lockfileVersion, lockfileVersion);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.byteLength, bytes.length);
    assert.equal(result.dependencies.find((item) => item.name === 'client').version, '1.2.3');
    assert.equal(result.declarations[0].exactVersion, null);
    assert.equal(result.declarations[0].selector, 'non-exact');
    assert.equal(result.declarations[0].selectorSha256, createHash('sha256').update('^1.0.0').digest('hex'));
    assert.equal(result.dependencies.find((item) => item.name === 'client').relationship, 'direct');
    assert.equal(result.dependencies.find((item) => item.name === 'transitive').relationship, 'transitive');
    assert.equal(result.installation, 'not-verified');
    assert.equal(result.codeExecuted, false);
    assert.deepEqual(await readFile(path), bytes);
    assert.throws(() => { result.dependencies[0].version = 'different'; }, TypeError);
  });
});

test('scoped, nested, development, optional and peer records preserve explicit flags', async () => {
  const value = lock();
  value.packages[''].devDependencies = { '@scope/tool': '2.0.0' };
  value.packages[''].optionalDependencies = { absent: 'next' };
  value.packages[''].peerDependencies = { peer: '^3' };
  value.packages['node_modules/@scope/tool'] = { version: '2.0.0', dev: true, devOptional: true };
  value.packages['node_modules/@scope/tool/node_modules/@nested/pkg'] = { version: '3.1.0', optional: true, peer: true };
  const result = await loadNpmDependencyInventory(await file(value));
  const direct = result.dependencies.find((item) => item.name === '@scope/tool');
  assert.equal(direct.relationship, 'direct');
  assert.equal(direct.development, true);
  assert.equal(direct.developmentOptional, true);
  const transitive = result.dependencies.find((item) => item.name === '@nested/pkg');
  assert.equal(transitive.relationship, 'transitive');
  assert.equal(transitive.optional, true);
  assert.equal(transitive.peer, true);
  assert.equal(result.declarations.find((item) => item.name === '@scope/tool').exactVersion, '2.0.0');
  assert.equal(result.declarations.find((item) => item.name === 'absent').lockfileEntry, 'not-recorded');
  assert.ok(result.limitations.some((item) => item.includes('no root lockfile entry')));
});

test('declaration and lockfile version discrepancies are retained without solving a range', async () => {
  const value = lock();
  value.packages[''].dependencies.client = '9.9.9';
  const result = await loadNpmDependencyInventory(await file(value));
  assert.equal(result.declarations[0].exactVersion, '9.9.9');
  assert.equal(result.dependencies.find((item) => item.name === 'client').version, '1.2.3');
  assert.equal((await correlate(value)).findings[0].status, 'affected-known-version');
});

test('canonical versions are exact strings including prereleases and build metadata', async (t) => {
  for (const version of ['0.0.0', '1.2.3', '1.2.3-rc.1', '1.2.3-alpha-beta', '1.2.3+build.01', '1.2.3-0+build']) await t.test(version, async () => {
    const value = lock();
    value.packages['node_modules/client'].version = version;
    assert.equal((await loadNpmDependencyInventory(await file(value))).dependencies.find((item) => item.name === 'client').version, version);
  });
});

test('noncanonical versions and ranges remain unknown without coercion or semver solving', async (t) => {
  for (const version of ['v1.2.3', '01.2.3', '1.2', '^1.2.3', 'latest', '1.2.3-01', '1.2.3 ', '9007199254740992.0.0', 'git+ssh://private.invalid/repo', 123]) await t.test(String(version), async () => {
    const value = lock();
    value.packages['node_modules/client'].version = version;
    const item = (await loadNpmDependencyInventory(await file(value))).dependencies.find((item) => item.name === 'client');
    assert.equal(item.version, null);
    assert.equal(item.resolution, 'unknown');
    assert.equal(item.reason, 'noncanonical-version');
    assert.equal((await correlate(value)).findings[0].status, 'unknown');
  });
});

test('links, local and git sources, aliases, missing versions and unsupported locations remain unresolved', async (t) => {
  for (const [entry, reason] of [
    [{ version: '1.2.3', link: true, resolved: '../workspace' }, 'link'],
    [{ version: '1.2.3', resolved: 'file:../workspace' }, 'unsupported-source'],
    [{ version: '1.2.3', resolved: '../workspace' }, 'unsupported-source'],
    [{ version: '1.2.3', resolved: 'git+https://example.invalid/repo.git' }, 'unsupported-source'],
    [{ name: 'actual-package', version: '1.2.3' }, 'package-alias'],
    [{}, 'missing-version'],
  ]) await t.test(reason, async () => {
    const value = lock();
    value.packages['node_modules/client'] = entry;
    const item = (await loadNpmDependencyInventory(await file(value))).dependencies.find((item) => item.location === 'node_modules/client');
    assert.equal(item.resolution, 'unknown');
    assert.equal(item.reason, reason);
    assert.equal(item.version, null);
  });
  const value = lock();
  value.packages['../secret-workspace'] = { name: 'workspace-package', version: '1.2.3' };
  const item = (await loadNpmDependencyInventory(await file(value))).dependencies.find((item) => item.name === 'workspace-package');
  assert.equal(item.location, null);
  assert.equal(item.relationship, 'unknown');
  assert.equal(item.reason, 'unsupported-location');
});

test('resolved URLs, integrity strings and private declaration selectors never appear in output or errors', async () => {
  const secret = 'SENSITIVE-FIXTURE-VALUE';
  const value = lock();
  value.packages[''].dependencies.client = `git+https://user:${secret}@private.invalid/package.git`;
  value.packages['node_modules/client'].resolved = `https://user:${secret}@registry.invalid/client.tgz`;
  value.packages['node_modules/client'].integrity = secret;
  value.packages[`private/${secret}`] = { version: '1.2.3' };
  const inventory = await loadNpmDependencyInventory(await file(value));
  const report = await correlate(value);
  for (const result of [inventory, report]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('registry.invalid'), false);
    assert.equal(Object.hasOwn(result, 'resolved'), false);
    assert.equal(Object.hasOwn(result, 'integrity'), false);
  }
});

test('a nested transitive version is correlated separately from its hoisted version', async () => {
  const value = lock();
  value.packages['node_modules/client/node_modules/client'] = { version: '1.0.0' };
  const report = await correlate(value);
  assert.equal(report.findings.length, 2);
  const affected = report.findings.find((item) => item.version === '1.2.3');
  const unlisted = report.findings.find((item) => item.version === '1.0.0');
  assert.equal(affected.status, 'affected-known-version');
  assert.equal(unlisted.status, 'unaffected-within-listed-versions');
  assert.equal(affected.exploitability, 'not-assessed');
  assert.equal(report.installation, 'not-verified');
  assert.equal(report.coverage, 'provided-advisories-and-exact-versions-only');
  assert.ok(report.limitations.some((item) => item.includes('not a complete vulnerability assessment')));
});

test('withdrawn advisories do not assert an active affected-version finding', async () => {
  const report = await correlate(lock(), catalog([advisory({ withdrawn: true })]));
  assert.equal(report.findings[0].status, 'withdrawn-advisory');
  assert.equal(report.findings[0].reason, 'advisory-withdrawn');
});

test('absent packages, unresolved versions and empty advisory catalogs never mean no vulnerabilities', async () => {
  const absent = await correlate(lock(), catalog([advisory({ package: 'not-recorded' })]));
  assert.equal(absent.findings[0].status, 'unknown');
  assert.equal(absent.findings[0].reason, 'package-not-recorded');
  const value = lock();
  value.packages['node_modules/client'].link = true;
  const unresolved = await correlate(value);
  assert.equal(unresolved.findings[0].status, 'unknown');
  assert.equal(unresolved.unresolvedDependencies, 1);
  const empty = await correlate(lock(), catalog([]));
  assert.deepEqual(empty.findings, []);
  assert.equal(Object.hasOwn(empty, 'secure'), false);
  assert.equal(Object.hasOwn(empty, 'vulnerable'), false);
  assert.equal(empty.coverage, 'provided-advisories-and-exact-versions-only');
});

test('exact-version matching does not silently strip build metadata or coerce versions', async () => {
  const value = lock();
  value.packages['node_modules/client'].version = '1.2.3+fixture';
  assert.equal((await correlate(value)).findings[0].status, 'unaffected-within-listed-versions');
  assert.equal((await correlate(value, catalog([advisory({ affectedVersions: ['1.2.3+fixture'] })]))).findings[0].status, 'affected-known-version');
});

test('advisory normalization sorts exact evidence and returns immutable validated data', async () => {
  const value = catalog([advisory({ affectedVersions: ['2.0.0', '1.2.3'] })]);
  const result = normalizeNpmAdvisories(value);
  assert.deepEqual(result.advisories[0].affectedVersions, ['1.2.3', '2.0.0']);
  assert.equal(result.advisories[0].withdrawn, false);
  assert.equal(result.coverage, 'explicit-exact-versions-only');
  assert.throws(() => result.advisories.push(advisory()), TypeError);
  value.advisories[0].affectedVersions.push('3.0.0');
  assert.equal(result.advisories[0].affectedVersions.length, 2);
  assert.deepEqual(await loadNpmAdvisories(await file(catalog())), normalizeNpmAdvisories(catalog()));
});

test('duplicate IDs, versions, unsupported ecosystems and ranges are rejected', async (t) => {
  for (const value of [
    catalog([advisory(), advisory()]), catalog([advisory({ affectedVersions: ['1.2.3', '1.2.3'] })]),
    catalog([advisory({ affectedVersions: [] })]), catalog([advisory({ affectedVersions: ['<2.0.0'] })]),
    catalog([advisory({ affectedVersions: ['v1.2.3'] })]), catalog([advisory({ ecosystem: 'pypi' })]),
    catalog([advisory({ package: '../wrong' })]), catalog([advisory({ script: 'untrusted' })]),
    { schemaVersion: 1, advisories: [], secret: 'untrusted' },
  ]) await t.test(JSON.stringify(value), () => {
    assert.throws(() => normalizeNpmAdvisories(value), (error) => error.name === 'PlumberError');
  });
});

test('advisory references require HTTPS without credentials, query strings or fragments', async (t) => {
  for (const sourceURL of ['http://example.invalid/advisory', 'file:///private', 'https://user:secret@example.invalid/advisory', 'https://example.invalid/advisory?token=secret', 'https://example.invalid/advisory#fragment', 'https://example.invalid/with space', 'not-a-url']) await t.test(sourceURL, () => {
    assert.throws(() => normalizeNpmAdvisories(catalog([advisory({ sourceURL })])), { name: 'PlumberError', code: 'INVALID_INPUT' });
  });
});

test('accessors, proxies, symbols, custom prototypes, sparse arrays and executable fields are rejected without executing them', () => {
  let executed = 0;
  const getter = catalog();
  Object.defineProperty(getter.advisories[0], 'package', { get() { executed += 1; return 'client'; } });
  assert.throws(() => normalizeNpmAdvisories(getter), { code: 'INVALID_INPUT' });
  const arrayGetter = catalog();
  Object.defineProperty(arrayGetter.advisories, '0', { get() { executed += 1; return advisory(); } });
  assert.throws(() => normalizeNpmAdvisories(arrayGetter), { code: 'INVALID_INPUT' });
  const proxied = new Proxy(catalog(), { ownKeys() { executed += 1; return []; } });
  assert.throws(() => normalizeNpmAdvisories(proxied), { code: 'INVALID_INPUT' });
  const symbolic = catalog();
  symbolic[Symbol('hidden')] = 'value';
  assert.throws(() => normalizeNpmAdvisories(symbolic), { code: 'INVALID_INPUT' });
  assert.throws(() => normalizeNpmAdvisories(Object.create({ schemaVersion: 1 })), { code: 'INVALID_INPUT' });
  const sparse = catalog();
  sparse.advisories = Array(1);
  assert.throws(() => normalizeNpmAdvisories(sparse), { code: 'INVALID_INPUT' });
  const executable = catalog();
  executable.toJSON = () => { executed += 1; return {}; };
  assert.throws(() => normalizeNpmAdvisories(executable), { code: 'INVALID_INPUT' });
  assert.equal(executed, 0);
});

test('duplicate JSON keys including escaped spellings never silently overwrite dependency evidence', async (t) => {
  for (const json of [
    '{"lockfileVersion":2,"lockfileVersion":3,"packages":{"":{}}}',
    '{"lockfileVersion":3,"packages":{"":{},"node_modules/client":{"version":"1.0.0"},"node_modules/client":{"version":"2.0.0"}}}',
    '{"lockfileVersion":3,"packages":{"":{},"node_modules/client":{"version":"1.0.0","ver\\u0073ion":"2.0.0"}}}',
  ]) await t.test(json, async () => {
    await assert.rejects(loadNpmDependencyInventory(await file(json)), { code: 'INVALID_INPUT' });
  });
  await assert.rejects(loadNpmAdvisories(await file('{"schemaVersion":1,"advisories":[],"advisories":[]}')), { code: 'INVALID_INPUT' });
});

test('malformed lockfiles and unsupported lock versions fail instead of returning an empty inventory', async (t) => {
  for (const value of [null, [], {}, { lockfileVersion: 1 }, { lockfileVersion: 4 }, { lockfileVersion: 3, packages: {} }, { lockfileVersion: 3, packages: { '': {}, 'node_modules/a': null } }, { lockfileVersion: 3, packages: { '': { dependencies: [] } } }]) await t.test(JSON.stringify(value), async () => {
    await assert.rejects(loadNpmDependencyInventory(await file(value)), (error) => error.name === 'PlumberError');
  });
  const flags = lock();
  flags.packages['node_modules/client'].dev = 'yes';
  await assert.rejects(loadNpmDependencyInventory(await file(flags)), { code: 'INVALID_INPUT' });
});

test('dependency, advisory, byte, depth and correlation limits fail explicitly', async (t) => {
  await t.test('dependencies', async () => {
    const value = { lockfileVersion: 3, packages: { '': {} } };
    for (let index = 0; index < 5001; index += 1) value.packages[`node_modules/p${index}`] = { version: '1.0.0' };
    await assert.rejects(loadNpmDependencyInventory(await file(value)), { code: 'INVALID_INPUT' });
  });
  await t.test('advisories', () => {
    assert.throws(() => normalizeNpmAdvisories(catalog(Array.from({ length: 1001 }, (_, index) => advisory({ id: `ID-${index}` })))), { code: 'INVALID_INPUT' });
  });
  for (const [label, value] of [['bytes', Buffer.alloc(4 * 1024 * 1024 + 1, 32)], ['depth', '{"x":'.repeat(65) + 'null' + '}'.repeat(65)], ['UTF-8', Buffer.from([0xff])], ['nonfinite', '{"lockfileVersion":1e400}']]) await t.test(label, async () => {
    await assert.rejects(loadNpmDependencyInventory(await file(value)), { code: 'INVALID_INPUT' });
  });
  await t.test('correlation budget', async () => {
    const value = { lockfileVersion: 3, packages: { '': {} } };
    for (let index = 0; index < 500; index += 1) value.packages[`node_modules/parent-${index}/node_modules/shared`] = { version: '1.2.3' };
    const advisories = catalog(Array.from({ length: 41 }, (_, index) => advisory({ id: `ID-${index}`, package: 'shared' })));
    await assert.rejects(correlate(value, advisories), { code: 'STATE_LIMIT' });
  });
});

test('local inventory and correlation never fetch sources or execute package scripts', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network access permitted.'); };
  try {
    const value = lock();
    value.packages[''].scripts = { postinstall: 'untrusted-script-data' };
    value.packages['node_modules/client'].hasInstallScript = true;
    assert.equal((await correlate(value)).findings[0].status, 'affected-known-version');
    await assert.rejects(loadNpmDependencyInventory('https://example.invalid/package-lock.json'), { code: 'INVALID_INPUT' });
    await assert.rejects(loadNpmAdvisories('https://example.invalid/advisories.json'), { code: 'INVALID_INPUT' });
  } finally { globalThis.fetch = original; }
});
