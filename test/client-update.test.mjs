import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { checkClientUpdate, stageClientUpdate, readClientUpdateStatus, ClientUpdateError } from '../dist/client-update.js';
import { ReleaseFetcher, releaseBaseUrl } from '../dist/client-update-fetcher.js';
import { runClientUpdateCli } from '../dist/client-update-cli.js';
import { buildSignedRelease } from '../tooling/sign-release.mjs';
import { refreshSignedRelease } from '../tooling/refresh-release.mjs';
import { releaseRepositoryFiles } from '../tooling/release-repository.mjs';
import { importJWK, jwtVerify } from 'jose';
import { generateCloudWorkerIdentity } from '../dist/cloud-connection.js';
import { CloudUpdateAuthorization } from '../dist/client-update-auth.js';

const base = resolve('work/test-client-updates');
let parent;
const metadataUrl = 'https://releases.example.test/metadata/';
const targetsUrl = 'https://releases.example.test/targets/';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex') } };
const keyid = sha(canonical(key));
const expires = '2099-01-01T00:00:00Z';
const envelope = signed => Buffer.from(JSON.stringify({ signed, signatures: [{ keyid, sig: sign(null, Buffer.from(canonical(signed)), privateKey).toString('hex') }] }));
const root = envelope({ _type: 'root', spec_version: '1.0.31', version: 1, expires, consistent_snapshot: false,
  keys: { [keyid]: key }, roles: Object.fromEntries(['root', 'timestamp', 'snapshot', 'targets'].map(role => [role, { keyids: [keyid], threshold: 1 }])) });
const consistentRoot = envelope({ ...JSON.parse(root).signed, consistent_snapshot: true });
const descriptor = (bytes, version) => ({ ...(version ? { version } : {}), length: bytes.length, hashes: { sha256: sha(bytes) } });

// Ephemeral Ed25519 keys and inert bytes exercise the real TUF verifier. These
// fixtures never establish trust in a production repository or execute a package.
function repository({ version = '0.2.0', sequence = 1, metadataVersion = sequence, expiration = {}, modifyRelease = value => value, signer = envelope } = {}) {
  const artifact = Buffer.from(`inert-package-fixture-${version}`);
  const target = `packages/keepseam-client/${version}/keepseam-client-${version}.tgz`;
  const release = modifyRelease({ schemaVersion: 1, channel: 'stable', version, sequence,
    artifact: { target, sha256: sha(artifact), byteLength: artifact.length }, minimumNodeVersion: '24.11.1' });
  const channel = Buffer.from(JSON.stringify(release));
  const targets = signer({ _type: 'targets', spec_version: '1.0.31', version: metadataVersion, expires: expiration.targets ?? expires,
    targets: { 'channels/stable.json': descriptor(channel), [target]: descriptor(artifact) } });
  const snapshot = signer({ _type: 'snapshot', spec_version: '1.0.31', version: metadataVersion, expires: expiration.snapshot ?? expires,
    meta: { 'targets.json': descriptor(targets, metadataVersion) } });
  const timestamp = signer({ _type: 'timestamp', spec_version: '1.0.31', version: metadataVersion, expires: expiration.timestamp ?? expires,
    meta: { 'snapshot.json': descriptor(snapshot, metadataVersion) } });
  return { artifact, release, files: new Map([
    [`${metadataUrl}timestamp.json`, timestamp], [`${metadataUrl}snapshot.json`, snapshot], [`${metadataUrl}targets.json`, targets],
    [`${targetsUrl}channels/stable.json`, channel], [`${targetsUrl}${target}`, artifact],
  ]) };
}

before(async () => {
  await mkdir(base, { recursive: true, mode: 0o700 });
  parent = await mkdtemp(join(await realpath(base), 'run-'));
  if (process.platform !== 'win32') await chmod(parent, 0o700);
  if (process.platform !== 'win32') return;
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
foreach ($allowed in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($allowed)
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $env:KEEPSEAM_TEST_DIRECTORY -AclObject $acl
`;
  execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'), KEEPSEAM_TEST_DIRECTORY: parent }, windowsHide: true, stdio: 'pipe', timeout: 30000 });
});
after(async () => {
  if (!parent) return;
  const actual = await realpath(parent);
  assert.equal(dirname(actual), await realpath(base)); assert.ok(basename(actual).startsWith('run-'));
  await rm(actual, { recursive: true, force: true });
});
async function fixture(t, rootBytes = root) {
  const directory = await mkdtemp(join(await realpath(parent), 'update-'));
  const statePath = join(directory, 'state'); await mkdir(statePath, { mode: 0o700 });
  const rootPath = join(directory, 'root.json'); await writeFile(rootPath, rootBytes, { mode: 0o600 });
  t.after(async () => {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), await realpath(parent)); assert.ok(basename(actual).startsWith('update-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { directory, statePath, currentVersion: '0.1.0', repository: { metadataUrl, targetsUrl, rootPath, rootSha256: sha(rootBytes) } };
}
const options = ({ directory: _directory, ...value }) => value;
const reason = expected => error => error instanceof ClientUpdateError && error.reason === expected && !/private-fixture/u.test(error.message);
function transport(repo, { response: override, addresses = [{ address: '8.8.8.8', family: 4 }] } = {}) {
  const calls = [];
  return { calls, resolve: async () => addresses, request: (url, requestOptions, callback) => {
    calls.push(url.href);
    assert.equal(requestOptions.agent, false); assert.equal(requestOptions.rejectUnauthorized, true);
    assert.equal(requestOptions.autoSelectFamily, false); assert.equal(requestOptions.headers.authorization, undefined);
    requestOptions.lookup(url.hostname, { all: false }, (error, address, family) => { assert.equal(error, null); assert.equal(address, addresses[0].address); assert.equal(family, addresses[0].family); });
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      assert.equal(request.maxHeadersCount, 0);
      const bytes = repo.files.get(url.href);
      const selected = override?.(url.href, bytes) ?? { body: bytes ?? Buffer.alloc(0), statusCode: bytes ? 200 : 404 };
      const response = Readable.from(selected.chunks ?? [selected.body]);
      Object.assign(response, { statusCode: selected.statusCode ?? 200, headers: selected.headers ?? {}, rawHeaders: selected.rawHeaders ?? [] });
      callback(response);
    });
    return request;
  } };
}
const dependencies = ({ calls: _calls, ...value }) => value;

test('real signatures gate check and stage; repeated checks preserve pending approval without redownload', async t => {
  const item = await fixture(t), repo = repository(), connection = transport(repo);
  assert.equal(await readClientUpdateStatus({ statePath: item.statePath }), null);
  const checked = await checkClientUpdate(options(item), dependencies(connection));
  assert.equal(checked.state, 'available'); assert.equal(checked.artifactPath, null); assert.equal(checked.installation, 'not-authorized');
  assert.equal(connection.calls.filter(url => url.endsWith('.tgz')).length, 0);
  const staged = await stageClientUpdate(options(item), dependencies(connection));
  assert.equal(staged.state, 'downloaded-awaiting-approval'); assert.equal(staged.installation, 'not-authorized');
  assert.deepEqual(await readFile(staged.artifactPath), repo.artifact);
  assert.deepEqual(await readClientUpdateStatus({ statePath: item.statePath }), staged);
  assert.equal((await checkClientUpdate(options(item), dependencies(connection))).state, 'downloaded-awaiting-approval');
  assert.equal((await stageClientUpdate(options(item), dependencies(connection))).state, 'downloaded-awaiting-approval');
  assert.equal(connection.calls.filter(url => url.endsWith('.tgz')).length, 1);
  assert.ok((await readdir(item.statePath)).every(name => !name.startsWith('check-')));
});

test('operator release metadata is compatible with public SDK check and staging without installation', async t => {
  const item = await fixture(t), artifact = Buffer.from('Synthetic inert package: staged, never extracted or executed.');
  const signed = buildSignedRelease({ rootBytes: root, rootSha256: sha(root),
    roleKeys: Object.fromEntries(['targets', 'snapshot', 'timestamp'].map(role => [role, [{ keyid, key: privateKey }]])),
    version: '0.2.0', sequence: 1, sourceRevision: 'a'.repeat(40),
    notes: { es: 'Prueba sintética', en: 'Synthetic test' }, requirements: { es: 'Node 24.21', en: 'Node 24.21' },
    artifacts: [{ os: 'any', arch: 'any', fileName: 'keepseam-client-0.2.0.tgz', bytes: artifact }],
    documentation: Buffer.from('%PDF-1.7 Synthetic inert documentation fixture') });
  const connection = transport({ files: new Map([
    ...[...signed.metadata].map(([path, bytes]) => [`${metadataUrl}${path}`, bytes]),
    ...[...signed.targets].map(([path, bytes]) => [`${targetsUrl}${path}`, bytes]),
  ]) });
  const checked = await checkClientUpdate(options(item), dependencies(connection));
  assert.equal(checked.state, 'available'); assert.equal(checked.release.minimumNodeVersion, '24.21.0');
  assert.equal(connection.calls.filter(url => url.endsWith('.tgz')).length, 0);
  const staged = await stageClientUpdate(options(item), dependencies(connection));
  assert.equal(staged.state, 'downloaded-awaiting-approval'); assert.equal(staged.installation, 'not-authorized');
  assert.deepEqual(await readFile(staged.artifactPath), artifact);
  assert.deepEqual(await readClientUpdateStatus({ statePath: item.statePath }), staged);
});

test('public SDK retains expired cached timestamp and accepts only a legitimate operator renewal', async t => {
  const item = await fixture(t), actualNow = Date.now(), oldNow = actualNow - 2 * 3600000;
  const roleKeys = Object.fromEntries(['targets', 'snapshot', 'timestamp'].map(role => [role, [{ keyid, key: privateKey }]]));
  const previous = buildSignedRelease({ rootBytes: root, rootSha256: sha(root), roleKeys, now: oldNow,
    version: '0.2.0', sequence: 1, sourceRevision: 'a'.repeat(40),
    notes: { es: 'Prueba sintética', en: 'Synthetic test' }, requirements: { es: 'Node 24.21', en: 'Node 24.21' },
    artifacts: [{ os: 'any', arch: 'any', fileName: 'keepseam-client-0.2.0.tgz', bytes: Buffer.from('Same inert package before and after renewal') }],
    documentation: Buffer.from('%PDF-1.7 Synthetic documentation fixture') });
  const connection = release => transport({ files: new Map([
    ...[...release.metadata].map(([path, bytes]) => [`${metadataUrl}${path}`, bytes]),
    ...[...release.targets].map(([path, bytes]) => [`${targetsUrl}${path}`, bytes]),
  ]) });
  // The public SDK creates and later reuses its own cache. No private DB writes.
  t.mock.timers.enable({ apis: ['Date'], now: oldNow });
  try {
    const original = await checkClientUpdate(options(item), dependencies(connection(previous)));
    assert.equal(original.state, 'available');
    t.mock.timers.setTime(actualNow);
    await assert.rejects(checkClientUpdate(options(item), dependencies(connection(previous))), reason('verification-failed'));
    const next = refreshSignedRelease({ rootBytes: root, rootSha256: sha(root), roleKeys, previousBundle: previous.importBundle,
      manifestSha256: sha(previous.importBundle.manifest), targets: previous.targets, now: actualNow });
    const refreshed = await checkClientUpdate(options(item), dependencies(connection(next)));
    assert.equal(refreshed.state, 'available'); assert.deepEqual(refreshed.release, original.release);
    const staged = await stageClientUpdate(options(item), dependencies(connection(next)));
    assert.equal(staged.installation, 'not-authorized'); assert.deepEqual(await readFile(staged.artifactPath), previous.targets.get(previous.manifest.artifacts[0].target));
    await assert.rejects(checkClientUpdate(options(item), dependencies(connection(previous))), reason('verification-failed'));
  } finally { t.mock.timers.reset(); }
});

test('the installed version is up to date and never downloads an unnecessary package', async t => {
  const item = await fixture(t), connection = transport(repository({ version: '0.1.0' }));
  assert.equal((await stageClientUpdate(options(item), dependencies(connection))).state, 'up-to-date');
  assert.equal(connection.calls.filter(url => url.endsWith('.tgz')).length, 0);
});

function consistentRelease({ version = '0.2.0', sequence = 1, now = Date.now() } = {}) {
  return buildSignedRelease({ rootBytes: consistentRoot, rootSha256: sha(consistentRoot),
    roleKeys: Object.fromEntries(['targets', 'snapshot', 'timestamp'].map(role => [role, [{ keyid, key: privateKey }]])),
    version, sequence, sourceRevision: 'a'.repeat(40), now,
    notes: { es: 'Fixture sintética', en: 'Synthetic fixture' }, requirements: { es: 'Node 24.21', en: 'Node 24.21' },
    artifacts: [{ os: 'any', arch: 'any', fileName: `keepseam-client-${version}.tgz`, bytes: Buffer.from(`Inert reviewed SDK ${version}`) }],
    documentation: Buffer.from('%PDF-1.7 Inert reviewed documentation') });
}
const repositoryUrls = release => new Map([...releaseRepositoryFiles(release)].map(([path, bytes]) => [`https://releases.example.test/${path}`, bytes]));

test('public SDK follows consistent transport names and stages exact bytes while the repository advances', async t => {
  const item = await fixture(t, consistentRoot), previous = consistentRelease(), next = consistentRelease({ version: '0.3.0', sequence: 2 });
  // Both immutable generations are retained while the mutable timestamp moves.
  const files = new Map([...repositoryUrls(previous), ...repositoryUrls(next)]);
  files.set(`${metadataUrl}timestamp.json`, previous.metadata.get('timestamp.json'));
  const connection = transport({ files }, { response: (url, bytes) => {
    if (url === `${metadataUrl}timestamp.json`) files.set(url, next.metadata.get('timestamp.json'));
    return { body: bytes ?? Buffer.alloc(0), statusCode: bytes ? 200 : 404 };
  } });
  const staged = await stageClientUpdate(options(item), dependencies(connection));
  assert.equal(staged.state, 'downloaded-awaiting-approval'); assert.equal(staged.installation, 'not-authorized');
  assert.equal(staged.release.version, '0.2.0');
  assert.deepEqual(await readFile(staged.artifactPath), previous.targets.get(previous.manifest.artifacts[0].target));
  assert.ok(connection.calls.includes(`${metadataUrl}1.snapshot.json`));
  assert.ok(connection.calls.includes(`${metadataUrl}1.targets.json`));
  assert.ok(connection.calls.some(url => /\/[a-f0-9]{64}\.stable\.json$/u.test(url)));
  assert.ok(connection.calls.some(url => /\/[a-f0-9]{64}\.keepseam-client-0\.2\.0\.tgz$/u.test(url)));
  assert.equal(connection.calls.some(url => /metadata\/(?:root|snapshot|targets)\.json$/u.test(url)), false);
  const updated = await checkClientUpdate(options(item), dependencies(connection));
  assert.equal(updated.release.version, '0.3.0'); assert.equal(updated.installation, 'not-authorized');
});

for (const target of ['snapshot', 'targets', 'channel', 'artifact']) test(`consistent ${target} from another signed generation is rejected`, async t => {
  const item = await fixture(t, consistentRoot), previous = consistentRelease(), next = consistentRelease({ version: '0.3.0', sequence: 2 });
  const files = repositoryUrls(previous), replacements = repositoryUrls(next);
  const suffix = target === 'snapshot' ? '.snapshot.json' : target === 'targets' ? '.targets.json' : target === 'channel' ? '.stable.json' : '.tgz';
  const destination = [...files.keys()].find(path => path.endsWith(suffix));
  const replacement = [...replacements.entries()].find(([path]) => path.endsWith(suffix));
  assert.ok(destination); assert.ok(replacement); files.set(destination, replacement[1]);
  await assert.rejects(stageClientUpdate(options(item), dependencies(transport({ files }))), reason('verification-failed'));
  const status = await readClientUpdateStatus({ statePath: item.statePath });
  assert.equal(status.installation, 'not-authorized'); assert.equal(status.artifactPath, null);
  assert.equal((await readdir(item.statePath)).some(name => name.endsWith('.tgz')), false);
});

test('consistent freshness renewal preserves targets and cached trust while rollback remains blocked', async t => {
  const item = await fixture(t, consistentRoot), now = Date.now(), oldNow = now - 2 * 3600000;
  const previous = consistentRelease({ now: oldNow });
  t.mock.timers.enable({ apis: ['Date'], now: oldNow });
  try {
    const original = await checkClientUpdate(options(item), dependencies(transport({ files: repositoryUrls(previous) })));
    t.mock.timers.setTime(now);
    await assert.rejects(checkClientUpdate(options(item), dependencies(transport({ files: repositoryUrls(previous) }))), reason('verification-failed'));
    const next = refreshSignedRelease({ rootBytes: consistentRoot, rootSha256: sha(consistentRoot),
      previousBundle: previous.importBundle, manifestSha256: sha(previous.importBundle.manifest), targets: previous.targets,
      roleKeys: { timestamp: [{ keyid, key: privateKey }] }, now });
    for (const role of ['targets.json', 'snapshot.json']) assert.deepEqual(next.metadata.get(role), previous.metadata.get(role));
    assert.deepEqual(next.targets, previous.targets); assert.deepEqual(next.root, previous.root);
    const connection = transport({ files: repositoryUrls(next) });
    const updated = await stageClientUpdate(options(item), dependencies(connection));
    assert.deepEqual(updated.release, original.release); assert.equal(updated.installation, 'not-authorized');
    assert.deepEqual(await readFile(updated.artifactPath), previous.targets.get(previous.manifest.artifacts[0].target));
    await assert.rejects(checkClientUpdate(options(item), dependencies(transport({ files: repositoryUrls(previous) }))), reason('verification-failed'));
    const future = consistentRelease({ version: '0.3.0', sequence: 3 });
    await checkClientUpdate(options(item), dependencies(transport({ files: repositoryUrls(future) })));
    await assert.rejects(checkClientUpdate(options(item), dependencies(connection)), reason('verification-failed'));
  } finally { t.mock.timers.reset(); }
});

test('untrusted bootstrap bytes cannot start HTTP or initialize trusted state', async t => {
  const item = await fixture(t), connection = transport(repository());
  await writeFile(item.repository.rootPath, Buffer.concat([root, Buffer.from(' ')]));
  await assert.rejects(checkClientUpdate(options(item), dependencies(connection)), reason('verification-failed'));
  assert.equal(connection.calls.length, 0); assert.equal(await readClientUpdateStatus({ statePath: item.statePath }), null);
});

for (const role of ['timestamp', 'snapshot', 'targets']) test(`expired ${role} metadata fails closed`, async t => {
  const item = await fixture(t), connection = transport(repository({ expiration: { [role]: '2000-01-01T00:00:00Z' } }));
  await assert.rejects(stageClientUpdate(options(item), dependencies(connection)), reason('verification-failed'));
  assert.equal(connection.calls.filter(url => url.endsWith('.tgz')).length, 0);
  assert.equal((await readClientUpdateStatus({ statePath: item.statePath })).state, 'blocked');
});

test('TUF metadata rollback remains rejected across calls with persisted highest trusted versions', async t => {
  const item = await fixture(t);
  await checkClientUpdate(options(item), dependencies(transport(repository({ sequence: 2, metadataVersion: 2 }))));
  await assert.rejects(checkClientUpdate(options(item), dependencies(transport(repository({ sequence: 1, metadataVersion: 1 })))), reason('verification-failed'));
  assert.equal((await readClientUpdateStatus({ statePath: item.statePath })).release.sequence, 2);
});

test('even newly signed metadata cannot downgrade the accepted release or rewrite a release sequence', async t => {
  for (const next of [{ version: '0.1.5', sequence: 3 }, { version: '0.3.0', sequence: 1 }, { version: '0.3.0', sequence: 2 }]) {
    const item = await fixture(t);
    await checkClientUpdate(options(item), dependencies(transport(repository({ sequence: 2, metadataVersion: 2 }))));
    await assert.rejects(checkClientUpdate(options(item), dependencies(transport(repository({ ...next, metadataVersion: 3 })))), reason('version-rollback'));
  }
});

test('signature failures and altered package bytes never produce a staged receipt', async t => {
  for (const which of ['timestamp.json', '.tgz']) {
    const item = await fixture(t), repo = repository();
    const connection = transport(repo, { response: (url, bytes) => url.endsWith(which) ? { body: Buffer.from(bytes.toString().replace(which === '.tgz' ? 'inert' : '2099', which === '.tgz' ? 'alter' : '2098')) } : undefined });
    await assert.rejects(stageClientUpdate(options(item), dependencies(connection)), reason('verification-failed'));
    assert.equal((await readClientUpdateStatus({ statePath: item.statePath })).installation, 'not-authorized');
    assert.equal((await readdir(item.statePath)).some(name => name.endsWith('.tgz')), false);
  }
});

test('signed channel fields cannot escape staging, execute instructions, or require an unsupported runtime', async t => {
  for (const modifyRelease of [value => ({ ...value, artifact: { ...value.artifact, target: '../../private-fixture' } }),
    value => ({ ...value, install: 'private-fixture' }), value => ({ ...value, minimumNodeVersion: '99.0.0' }),
    value => ({ ...value, artifact: { ...value.artifact, byteLength: 33 * 1024 * 1024 } })]) {
    const item = await fixture(t), connection = transport(repository({ modifyRelease }));
    await assert.rejects(stageClientUpdate(options(item), dependencies(connection)), reason('verification-failed'));
    assert.equal(connection.calls.filter(url => url.endsWith('.tgz')).length, 0);
  }
});

test('changing repository identity cannot reset an existing trusted history', async t => {
  const item = await fixture(t);
  await checkClientUpdate(options(item), dependencies(transport(repository())));
  const next = { ...options(item), repository: { ...item.repository, metadataUrl: 'https://other.example.test/metadata/' } };
  const connection = transport(repository());
  await assert.rejects(checkClientUpdate(next, dependencies(connection)), reason('verification-failed'));
  assert.equal(connection.calls.length, 0);
  assert.equal((await checkClientUpdate(options(item), dependencies(transport(repository())))).state, 'available');
});

test('local artifact tampering is detected again by status and cannot be replaced silently', async t => {
  const item = await fixture(t), repo = repository();
  const staged = await stageClientUpdate(options(item), dependencies(transport(repo)));
  await writeFile(staged.artifactPath, 'private-fixture');
  await assert.rejects(readClientUpdateStatus({ statePath: item.statePath }), reason('verification-failed'));
  await assert.rejects(stageClientUpdate(options(item), dependencies(transport(repo))), reason('verification-failed'));
});

test('staging is capped at three packages without deleting or overwriting retained versions', async t => {
  const item = await fixture(t);
  for (let sequence = 1; sequence <= 3; sequence++) await stageClientUpdate(options(item), dependencies(transport(repository({ version: `0.${sequence + 1}.0`, sequence }))));
  await assert.rejects(stageClientUpdate(options(item), dependencies(transport(repository({ version: '0.5.0', sequence: 4 })))), reason('cache-full'));
  assert.equal((await readdir(item.statePath)).filter(name => name.endsWith('.tgz')).length, 3);
});

test('all DNS addresses are public and requests cannot redirect to another destination', async t => {
  for (const addresses of [[{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], [{ address: '169.254.169.254', family: 4 }]]) {
    const item = await fixture(t), connection = transport(repository(), { addresses });
    await assert.rejects(checkClientUpdate(options(item), dependencies(connection)), reason('verification-failed')); assert.equal(connection.calls.length, 0);
  }
  const item = await fixture(t), connection = transport(repository(), { response: () => ({ statusCode: 302, body: Buffer.alloc(0), headers: { location: 'https://127.0.0.1/private-fixture' } }) });
  await assert.rejects(checkClientUpdate(options(item), dependencies(connection)), reason('verification-failed')); assert.equal(connection.calls.length, 1);
});

test('root 404 ends rotation, but root 403 fails instead of silently preserving revoked access', async t => {
  const item = await fixture(t), connection = transport(repository(), { response: url => url.endsWith('.root.json') ? { statusCode: 403, body: Buffer.alloc(0) } : undefined });
  await assert.rejects(checkClientUpdate(options(item), dependencies(connection)), reason('verification-failed')); assert.equal(connection.calls.length, 1);
});

test('a resolver that ignores cancellation cannot keep an aborted check alive', async t => {
  const item = await fixture(t), controller = new AbortController();
  let entered; const resolving = new Promise(done => { entered = done; });
  const checking = checkClientUpdate({ ...options(item), signal: controller.signal }, { resolve: () => { entered(); return new Promise(() => {}); }, request: () => assert.fail('must not connect') });
  await resolving; controller.abort();
  await assert.rejects(checking, reason('cancelled'));
  assert.equal((await readClientUpdateStatus({ statePath: item.statePath })).reason, 'cancelled');
});

test('URL canonicalization and target traversal are rejected before transport', async t => {
  for (const url of ['http://releases.example.test/', 'https://127.0.0.1/', 'https://releases.example.test/a/../',
    'https://releases.example.test/%2e%2e/', 'https://releases.example.test:8443/', 'https://user:private-fixture@releases.example.test/',
    'https://releases.example.test/?token=private-fixture']) assert.throws(() => releaseBaseUrl(url));
  const item = await fixture(t), connection = transport(repository());
  const fetcher = new ReleaseFetcher(metadataUrl, targetsUrl, item.statePath, new AbortController().signal, dependencies(connection));
  for (const url of [`${targetsUrl}../private-fixture`, `${targetsUrl}%2e%2e/private-fixture`, 'https://other.example.test/targets/file']) {
    await assert.rejects(fetcher.downloadBytes(url, 100));
  }
  assert.equal(connection.calls.length, 0);
});

test('untrusted content length, compression and actual chunk sizes are bounded', async t => {
  for (const response of [{ body: Buffer.alloc(10), headers: { 'content-length': '11' } }, { body: Buffer.alloc(10), headers: { 'content-encoding': 'gzip' } },
    { body: Buffer.alloc(17), headers: {} }, { body: Buffer.alloc(1), headers: { 'content-length': '9999999999' } },
    { body: Buffer.alloc(1), rawHeaders: Array(130).fill('x') }]) {
    const item = await fixture(t), repo = repository(), connection = transport(repo, { response: () => response });
    const fetcher = new ReleaseFetcher(metadataUrl, targetsUrl, item.statePath, new AbortController().signal, dependencies(connection));
    await assert.rejects(fetcher.downloadBytes(`${metadataUrl}timestamp.json`, 16));
    assert.deepEqual(await readdir(item.statePath), []);
  }
});

test('root key rotation requires old and new signatures and persists even if later downloads fail', async t => {
  const nextKeys = generateKeyPairSync('ed25519');
  const nextKey = { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: Buffer.from(nextKeys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex') } };
  const nextId = sha(canonical(nextKey));
  const signer = signed => Buffer.from(JSON.stringify({ signed, signatures: [{ keyid: nextId, sig: sign(null, Buffer.from(canonical(signed)), nextKeys.privateKey).toString('hex') }] }));
  const signed = { _type: 'root', spec_version: '1.0.31', version: 2, expires, consistent_snapshot: false,
    keys: { [nextId]: nextKey }, roles: Object.fromEntries(['root', 'timestamp', 'snapshot', 'targets'].map(role => [role, { keyids: [nextId], threshold: 1 }])) };
  const rotated = JSON.parse(signer(signed));
  const trustedRotation = Buffer.from(JSON.stringify({ ...rotated, signatures: [...rotated.signatures, ...JSON.parse(envelope(signed)).signatures] }));
  const repo = repository({ signer }), item = await fixture(t);
  repo.files.set(`${metadataUrl}2.root.json`, signer(signed));
  await assert.rejects(checkClientUpdate(options(item), dependencies(transport(repo))), reason('verification-failed'));
  repo.files.set(`${metadataUrl}2.root.json`, trustedRotation);
  const interruption = transport(repo, { response: url => url.endsWith('timestamp.json') ? { statusCode: 500, body: Buffer.alloc(0) } : undefined });
  await assert.rejects(checkClientUpdate(options(item), dependencies(interruption)), reason('verification-failed'));
  // An old signing key is not accepted after this interrupted but verified rotation.
  await assert.rejects(checkClientUpdate(options(item), dependencies(transport(repository()))), reason('verification-failed'));
  const recovered = transport(repo);
  assert.equal((await checkClientUpdate(options(item), dependencies(recovered))).state, 'available');
  assert.equal(recovered.calls[0], `${metadataUrl}3.root.json`);
  assert.equal(recovered.calls.includes(`${metadataUrl}2.root.json`), false);
});

test('corrupt trusted metadata storage cannot fall back to the bootstrap root', async t => {
  const item = await fixture(t);
  await checkClientUpdate(options(item), dependencies(transport(repository())));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(item.statePath, 'client-updates.sqlite3'));
  try { db.prepare('UPDATE metadata SET bytes=? WHERE name=?').run(Buffer.from('private-fixture'), 'root.json'); }
  finally { db.close(); }
  const connection = transport(repository());
  await assert.rejects(checkClientUpdate(options(item), dependencies(connection)), reason('verification-failed'));
  assert.equal(connection.calls.length, 0);
});

test('a concurrent operation cannot race or reset the first updater transaction', async t => {
  const item = await fixture(t), controller = new AbortController();
  let entered; const resolving = new Promise(done => { entered = done; });
  const first = checkClientUpdate({ ...options(item), signal: controller.signal }, { resolve: () => { entered(); return new Promise(() => {}); } });
  await resolving;
  try { await assert.rejects(checkClientUpdate(options(item), dependencies(transport(repository()))), reason('verification-failed')); }
  finally { controller.abort(); }
  await assert.rejects(first, reason('cancelled'));
});

test('CLI status is offline and unsupported installation, repeated options and version overrides fail', async t => {
  const item = await fixture(t), configPath = join(item.directory, 'updates.json');
  await writeFile(configPath, JSON.stringify({ statePath: item.statePath, repository: item.repository }), { mode: 0o600 });
  let stdout = '', stderr = '';
  const output = { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } };
  assert.equal(await runClientUpdateCli(['client-update', 'status', '--config', configPath], output), 0);
  assert.deepEqual(JSON.parse(stdout), { status: null }); assert.equal(stderr, '');
  for (const args of [['client-update', 'install', '--config', configPath], ['client-update', 'status', '--config', configPath, '--config', configPath],
    ['client-update', 'stage', '--config', configPath, '--current-version', '99.0.0']]) {
    stdout = ''; stderr = '';
    assert.equal(await runClientUpdateCli(args, output), 2); assert.equal(stdout, ''); assert.equal(JSON.parse(stderr).error.code, 'CLIENT_UPDATE_FAILED');
  }
});

test('an explicitly configured but expired bootstrap root still fails TUF freshness checks', async t => {
  const item = await fixture(t);
  const expired = envelope({ ...JSON.parse(root).signed, expires: '2000-01-01T00:00:00Z' });
  await writeFile(item.repository.rootPath, expired);
  item.repository.rootSha256 = sha(expired);
  const connection = transport(repository());
  await assert.rejects(stageClientUpdate(options(item), dependencies(connection)), reason('verification-failed'));
  assert.equal(connection.calls.some(url => url.endsWith('.tgz')), false);
});

test('interrupted attempt storage is bounded without deleting existing attempts or trusted history', async t => {
  const item = await fixture(t);
  for (const value of ['1', '2', '3']) await mkdir(join(item.statePath, `check-${value.repeat(8)}-${value.repeat(4)}-${value.repeat(4)}-${value.repeat(4)}-${value.repeat(12)}`), { mode: 0o700 });
  const connection = transport(repository());
  await assert.rejects(stageClientUpdate(options(item), dependencies(connection)), reason('cache-full'));
  assert.equal(connection.calls.length, 0);
  assert.equal((await readdir(item.statePath)).filter(name => name.startsWith('check-')).length, 3);
});

test('SDK input getters and proxies never run during validation', async () => {
  let invoked = 0;
  const input = { currentVersion: '0.1.0', repository: {} };
  Object.defineProperty(input, 'statePath', { get() { invoked++; throw new Error('private-fixture'); } });
  await assert.rejects(checkClientUpdate(input), reason('verification-failed'));
  await assert.rejects(checkClientUpdate(new Proxy({}, { ownKeys() { invoked++; throw new Error('private-fixture'); } })), reason('verification-failed'));
  assert.equal(invoked, 0);
});

const cloudBase = 'https://cloud.example.test';
const cloudMetadata = `${cloudBase}/api/worker/v1/updates/metadata/`;
const cloudTargets = `${cloudBase}/api/worker/v1/updates/targets/`;
async function cloudFixture(t, rootBytes = consistentRoot) {
  const item = await fixture(t, rootBytes), identity = await generateCloudWorkerIdentity();
  const credentials = { baseUrl: cloudBase, installationId: identity.installationId, projectId: randomBytes(32).toString('hex'),
    clientSecret: randomBytes(32).toString('hex'), privateJwk: identity.privateJwk };
  const credentialsPath = join(item.directory, 'worker-credentials.json');
  await writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
  return { item: { ...item, repository: { kind: 'cloud', baseUrl: cloudBase, credentialsPath,
    rootPath: item.repository.rootPath, rootSha256: item.repository.rootSha256 } }, credentials, identity };
}
function cloudFiles(signed) {
  return new Map([...releaseRepositoryFiles(signed)].map(([path, bytes]) => [`${cloudBase}/api/worker/v1/updates/${path}`, bytes]));
}
async function cloudTransport(fixture, files, override = () => undefined) {
  const key = await importJWK(fixture.identity.publicJwk, 'ES256'), seen = new Set(), calls = [], tokens = new Set();
  const respond = async (url, options, body) => {
    calls.push({ url: url.href, method: options.method });
    const headers = new Headers(options.headers), proof = headers.get('dpop'); assert.ok(proof);
    for (const name of ['cookie', 'origin', 'range']) assert.equal(headers.get(name), null);
    const jwt = await jwtVerify(proof, key, { algorithms: ['ES256'], typ: 'dpop+jwt' });
    assert.equal(jwt.payload.htm, options.method); assert.equal(jwt.payload.htu, url.href);
    assert.deepEqual(jwt.protectedHeader.jwk, fixture.identity.publicJwk); assert.equal(jwt.protectedHeader.jwk.d, undefined);
    assert.equal(typeof jwt.payload.jti, 'string'); assert.equal(seen.has(jwt.payload.jti), false); seen.add(jwt.payload.jti);
    assert.ok(Math.abs(jwt.payload.iat - Math.floor(Date.now() / 1000)) <= 1);
    if (options.method === 'POST') {
      assert.equal(url.href, `${cloudBase}/api/worker/v1/token`); assert.equal(jwt.payload.ath, undefined);
      assert.equal(headers.get('authorization'), null);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), { grant_type: 'client_credentials', client_id: fixture.credentials.installationId,
        client_secret: fixture.credentials.clientSecret, scope: 'worker:updates' });
      const value = randomBytes(32).toString('hex'); tokens.add(value);
      const tokenBody = Buffer.from(JSON.stringify({ access_token: value, token_type: 'DPoP', expires_in: 300, scope: 'worker:updates' }));
      return override(url, tokenBody) ?? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: tokenBody };
    }
    assert.equal(options.method, 'GET'); assert.equal(body, undefined);
    const authorization = headers.get('authorization'); assert.match(authorization, /^DPoP [a-f0-9]{64}$/u);
    const token = authorization.slice(5); assert.ok(tokens.has(token));
    assert.equal(jwt.payload.ath, createHash('sha256').update(token).digest('base64url'));
    const bytes = files.get(url.href);
    return override(url, bytes) ?? { statusCode: bytes ? 200 : 404, body: bytes ?? Buffer.alloc(0) };
  };
  const transport = { calls, respond, resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: (url, options, callback) => {
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false);
    assert.equal(options.servername, 'cloud.example.test');
    options.lookup(url.hostname, { all: false }, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    const request = new EventEmitter();
    request.end = body => { void respond(url, options, body).then(selected => {
      const response = Readable.from(selected.chunks ?? [selected.body]);
      Object.assign(response, { statusCode: selected.statusCode, headers: selected.headers ?? {}, rawHeaders: selected.rawHeaders ?? [] });
      callback(response);
    }, error => request.emit('error', error)); };
    return request;
  } };
  return transport;
}
const cloudDependencies = connection => ({ resolve: connection.resolve, request: connection.request });

test('Cloud update uses real HTTP with cryptographically verified purpose-bound DPoP and stages signed SDK bytes', async t => {
  const f = await cloudFixture(t), signed = consistentRelease(), connection = await cloudTransport(f, cloudFiles(signed)), failures = [];
  // The trusted HTTPS seam points only this synthetic server at loopback. The
  // product still validates public DNS and TLS options; no real Cloud is claimed.
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const selected = await connection.respond(new URL(request.url, cloudBase), { method: request.method, headers: request.headers },
        request.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined);
      response.writeHead(selected.statusCode, selected.headers); response.end(selected.body);
    } catch (error) { failures.push(error); response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const dependencies = { resolve: connection.resolve, request: (url, options, callback) => {
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.method === 'POST' || options.method === 'GET', true);
    assert.equal(url.origin, cloudBase); assert.equal(options.agent, false);
    options.lookup(url.hostname, { all: false }, (error, address) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
    return httpRequest({ host: '127.0.0.1', port: server.address().port, path: url.pathname, method: options.method,
      headers: options.headers, signal: options.signal, agent: false, maxHeaderSize: options.maxHeaderSize }, callback);
  } };
  const staged = await stageClientUpdate(options(f.item), dependencies);
  assert.deepEqual(failures, []); assert.equal(staged.state, 'downloaded-awaiting-approval'); assert.equal(staged.installation, 'not-authorized');
  assert.deepEqual(await readFile(staged.artifactPath), signed.targets.get(signed.manifest.artifacts[0].target));
  assert.equal(connection.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(connection.calls.length, 7); assert.equal((await readClientUpdateStatus({ statePath: f.item.statePath })).release.version, '0.2.0');
  const stateBytes = await readFile(join(f.item.statePath, 'client-updates.sqlite3'));
  assert.equal(stateBytes.includes(f.credentials.clientSecret), false); assert.equal(stateBytes.includes(f.credentials.privateJwk.d), false);
});

test('Cloud auth failures, throttling and temporary errors make one attempt and preserve TUF antirollback history', async t => {
  for (const [statusCode, expected] of [[401, 'authorization-rejected'], [403, 'authorization-rejected'], [429, 'rate-limited'], [503, 'network-unavailable'], [410, 'release-withdrawn']]) {
    const f = await cloudFixture(t), signed = consistentRelease({ sequence: 2 });
    await checkClientUpdate(options(f.item), cloudDependencies(await cloudTransport(f, cloudFiles(signed))));
    const failure = await cloudTransport(f, cloudFiles(signed), url => url.pathname.endsWith('timestamp.json') ? { statusCode, body: Buffer.from('private-fixture'), headers: { 'content-type': 'text/html' } } : undefined);
    await assert.rejects(checkClientUpdate(options(f.item), cloudDependencies(failure)), reason(expected));
    assert.equal(failure.calls.filter(call => call.url.endsWith('timestamp.json')).length, 1);
    const status = await readClientUpdateStatus({ statePath: f.item.statePath }); assert.equal(status.reason, expected); assert.equal(status.release.sequence, 2);
    await assert.rejects(checkClientUpdate(options(f.item), cloudDependencies(await cloudTransport(f, cloudFiles(consistentRelease({ sequence: 1 }))))), reason('verification-failed'));
    assert.equal((await checkClientUpdate(options(f.item), cloudDependencies(await cloudTransport(f, cloudFiles(signed))))).state, 'available');
  }
});

test('Cloud bounded error codes identify trust, targets, freshness and feed failures without exposing provider bodies', async t => {
  for (const [code, expected] of [['UPDATE_TRUST_EXPIRED', 'trust-expired'], ['UPDATE_TARGETS_EXPIRED', 'targets-expired'],
    ['UPDATE_FRESHNESS_EXPIRED', 'metadata-expired'], ['UPDATE_FEED_UNAVAILABLE', 'feed-unavailable'], ['toString', 'network-unavailable']]) {
    const f = await cloudFixture(t), connection = await cloudTransport(f, cloudFiles(consistentRelease()), url => url.pathname.endsWith('timestamp.json')
      ? { statusCode: 503, body: Buffer.from(JSON.stringify({ error: { code, requestId: 'synthetic', retryable: true, private: 'private-fixture' } })), headers: { 'content-type': 'application/json' } } : undefined);
    await assert.rejects(checkClientUpdate(options(f.item), cloudDependencies(connection)), reason(expected));
    assert.equal(connection.calls.length, 3);
  }
});

test('Cloud rejects wrong token scope, excessive lifetimes, malformed credentials and ambiguous destinations before download', async t => {
  for (const input of [{ scope: 'worker:control' }, { scope: 'worker:status' }, { expires_in: 301 }, { token_type: 'Bearer' }]) {
    const f = await cloudFixture(t), connection = await cloudTransport(f, cloudFiles(consistentRelease()), url => url.pathname.endsWith('/token')
      ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ access_token: 'a'.repeat(64), expires_in: 300, scope: 'worker:updates', token_type: 'DPoP', ...input })) } : undefined);
    await assert.rejects(checkClientUpdate(options(f.item), cloudDependencies(connection)), reason('verification-failed')); assert.equal(connection.calls.length, 1);
  }
  const f = await cloudFixture(t), connection = await cloudTransport(f, cloudFiles(consistentRelease()));
  for (const baseUrl of ['https://other.example.test', `${cloudBase}/`, `${cloudBase}?key=private-fixture`, `${cloudBase}/api`, `${cloudBase}:8443`, 'http://cloud.example.test', 'https://127.0.0.1']) {
    await assert.rejects(checkClientUpdate({ ...options(f.item), repository: { ...f.item.repository, baseUrl } }, cloudDependencies(connection)));
  }
  await assert.rejects(checkClientUpdate({ ...options(f.item), repository: { ...f.item.repository, metadataUrl } }, cloudDependencies(connection)), reason('verification-failed'));
  await writeFile(f.item.repository.credentialsPath, JSON.stringify({ ...f.credentials, allowLocalHttp: true }), { mode: 0o600 });
  await assert.rejects(checkClientUpdate(options(f.item), cloudDependencies(connection)), reason('credentials-unavailable'));
  assert.equal(connection.calls.length, 0);
});

test('Cloud request budget includes authentication; target aliases and redirects cannot extend it', async t => {
  const f = await cloudFixture(t), signed = consistentRelease(), connection = await cloudTransport(f, cloudFiles(signed));
  const auth = await CloudUpdateAuthorization.load(cloudBase, f.item.repository.credentialsPath);
  const fetcher = new ReleaseFetcher(cloudMetadata, cloudTargets, f.item.statePath, new AbortController().signal, cloudDependencies(connection), auth);
  for (const path of ['root.json', 'snapshot.json', 'targets.json', '1.root.json?x=1', '%31.root.json', '../token']) await assert.rejects(fetcher.downloadBytes(`${cloudMetadata}${path}`, 16384));
  await assert.rejects(fetcher.downloadBytes(`${cloudTargets}channels/stable.json`, 16384)); assert.equal(connection.calls.length, 0);
  for (let i = 0; i < 39; i++) await fetcher.downloadBytes(`${cloudMetadata}timestamp.json`, 16384);
  assert.equal(connection.calls.length, 40); await assert.rejects(fetcher.downloadBytes(`${cloudMetadata}timestamp.json`, 16384)); assert.equal(connection.calls.length, 40);
  const redirected = await cloudTransport(f, cloudFiles(signed), () => ({ statusCode: 307, body: Buffer.alloc(0), headers: { location: 'https://other.example.test/private-fixture' } }));
  await assert.rejects(checkClientUpdate(options(f.item), cloudDependencies(redirected)), reason('verification-failed')); assert.equal(redirected.calls.length, 1);
});

test('Cloud TUF expiration is actionable and cannot reset trusted state or authorize staging', async t => {
  const f = await cloudFixture(t), now = Date.now(), old = now - 7200000, signed = consistentRelease({ now: old });
  t.mock.timers.enable({ apis: ['Date'], now: old });
  try {
    await checkClientUpdate(options(f.item), cloudDependencies(await cloudTransport(f, cloudFiles(signed))));
    t.mock.timers.setTime(now);
    await assert.rejects(stageClientUpdate(options(f.item), cloudDependencies(await cloudTransport(f, cloudFiles(signed)))), reason('metadata-expired'));
    assert.equal((await readClientUpdateStatus({ statePath: f.item.statePath })).release.sequence, 1);
    assert.equal((await readdir(f.item.statePath)).some(name => name.endsWith('.tgz')), false);
  } finally { t.mock.timers.reset(); }
  const root = envelope({ ...JSON.parse(consistentRoot).signed, expires: '2000-01-01T00:00:00Z' }), expired = await cloudFixture(t, root);
  await assert.rejects(checkClientUpdate(options(expired.item), cloudDependencies(await cloudTransport(expired, cloudFiles(consistentRelease())))), reason('trust-expired'));
});

test('Cloud authorization shares the absolute 120 second deadline even when DNS never settles', async t => {
  const f = await cloudFixture(t); let resolving;
  const entered = new Promise(resolve => { resolving = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = checkClientUpdate(options(f.item), { resolve: () => { resolving(); return new Promise(() => {}); }, request: () => assert.fail('no connection before public DNS') });
    await entered; t.mock.timers.tick(120_000);
    await assert.rejects(pending, reason('deadline-exceeded'));
    assert.equal((await readClientUpdateStatus({ statePath: f.item.statePath })).reason, 'deadline-exceeded');
  } finally { t.mock.timers.reset(); }
});

test('Cloud auth validates every DNS answer, token response bounds and signed root mode', async t => {
  const f = await cloudFixture(t), connection = await cloudTransport(f, cloudFiles(consistentRelease()));
  await assert.rejects(checkClientUpdate(options(f.item), { request: connection.request, resolve: async () => [] }), reason('network-unavailable'));
  assert.equal(connection.calls.length, 0);
  await assert.rejects(checkClientUpdate(options(f.item), { request: connection.request, resolve: async () => [
    { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
  ] }), reason('verification-failed')); assert.equal(connection.calls.length, 0);
  const legacy = await cloudFixture(t, root);
  await assert.rejects(checkClientUpdate(options(legacy.item), cloudDependencies(connection)), reason('verification-failed')); assert.equal(connection.calls.length, 0);
  for (const response of [{ body: Buffer.alloc(16_385), headers: { 'content-type': 'application/json' } },
    { body: Buffer.alloc(1), headers: { 'content-type': 'application/json', 'content-length': '9999999' } },
    { body: Buffer.alloc(1), headers: { 'content-type': 'text/html' } }]) {
    const invalid = await cloudTransport(f, cloudFiles(consistentRelease()), () => ({ statusCode: 200, ...response }));
    await assert.rejects(checkClientUpdate(options(f.item), cloudDependencies(invalid)), reason('verification-failed')); assert.equal(invalid.calls.length, 1);
  }
});

test('Cloud signed expired target metadata served with HTTP 200 has a distinct failure reason', async t => {
  const f = await cloudFixture(t), repo = repository({ expiration: { targets: '2000-01-01T00:00:00Z' } });
  const files = new Map([...repo.files].map(([url, bytes]) => {
    if (url.startsWith(metadataUrl)) {
      const name = url.slice(metadataUrl.length); return [`${cloudMetadata}${name === 'timestamp.json' ? name : `1.${name}`}`, bytes];
    }
    const path = url.slice(targetsUrl.length), slash = path.lastIndexOf('/');
    return [`${cloudTargets}${path.slice(0, slash + 1)}${sha(bytes)}.${path.slice(slash + 1)}`, bytes];
  }));
  const connection = await cloudTransport(f, files);
  await assert.rejects(stageClientUpdate(options(f.item), cloudDependencies(connection)), reason('targets-expired'));
  assert.equal(connection.calls.some(call => call.url.endsWith('1.targets.json')), true);
  assert.equal(connection.calls.some(call => call.url.includes('/targets/')), false);
});

test('Cloud token renewal during an update retains the original request budget', async t => {
  const f = await cloudFixture(t), signed = consistentRelease(); let advanced = false;
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  try {
    const connection = await cloudTransport(f, cloudFiles(signed), (url, bytes) => {
      if (url.pathname.endsWith('/token')) return { statusCode: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ ...JSON.parse(bytes), expires_in: 16 })) };
      if (!advanced) { advanced = true; t.mock.timers.setTime(now + 2000); }
      return undefined;
    });
    const auth = await CloudUpdateAuthorization.load(cloudBase, f.item.repository.credentialsPath);
    const fetcher = new ReleaseFetcher(cloudMetadata, cloudTargets, f.item.statePath, new AbortController().signal, cloudDependencies(connection), auth);
    for (let i = 0; i < 38; i++) await fetcher.downloadBytes(`${cloudMetadata}timestamp.json`, 16384);
    assert.equal(connection.calls.filter(call => call.method === 'POST').length, 2); assert.equal(connection.calls.length, 40);
    await assert.rejects(fetcher.downloadBytes(`${cloudMetadata}timestamp.json`, 16384)); assert.equal(connection.calls.length, 40);
  } finally { t.mock.timers.reset(); }
});

test('Cloud preserves typed transport errors when TUF wraps snapshot or targets failures', async t => {
  for (const [suffix, statusCode, expected] of [['snapshot.json', 401, 'authorization-rejected'], ['targets.json', 429, 'rate-limited'],
    ['targets.json', 503, 'feed-unavailable']]) {
    const f = await cloudFixture(t), connection = await cloudTransport(f, cloudFiles(consistentRelease()), url => url.pathname.endsWith(suffix)
      ? { statusCode, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: { code: 'UPDATE_FEED_UNAVAILABLE' } })) } : undefined);
    await assert.rejects(checkClientUpdate(options(f.item), cloudDependencies(connection)), reason(expected));
    assert.equal(connection.calls.filter(call => call.url.endsWith(suffix)).length, 1);
    assert.equal((await readClientUpdateStatus({ statePath: f.item.statePath })).reason, expected);
  }
});
