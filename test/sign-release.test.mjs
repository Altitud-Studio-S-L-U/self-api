import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BaseFetcher, Updater } from 'tuf-js';
import { buildSignedRelease, canonicalTuf } from '../tooling/sign-release.mjs';
import {signReleaseConfiguration,writeSignedRelease} from '../tooling/sign-release-cli.mjs';
import {refreshReleaseConfiguration} from '../tooling/refresh-release-cli.mjs';
import {refreshSignedRelease} from '../tooling/refresh-release.mjs';
import {requireImportBundleBounds} from '../tooling/release-tuf.mjs';
import {checkWindowsPermissions} from '../dist/windows-permissions.js';
import {writeReleaseDelivery} from '../tooling/release-delivery.mjs';

function fixture() {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const key={keytype:'ed25519',scheme:'ed25519',keyval:{public:Buffer.from(publicKey.export({format:'jwk'}).x,'base64url').toString('hex')}};
  const keyid=createHash('sha256').update(canonicalTuf(key)).digest('hex');
  const signed={_type:'root',spec_version:'1.0.31',version:1,expires:'2099-01-01T00:00:00Z',consistent_snapshot:false,
    keys:{[keyid]:key},roles:Object.fromEntries(['root','targets','snapshot','timestamp'].map(role=>[role,{keyids:[keyid],threshold:1}]))};
  const rootBytes=Buffer.from(JSON.stringify({signed,signatures:[{keyid,sig:sign(null,Buffer.from(canonicalTuf(signed)),privateKey).toString('hex')}]}));
  return {rootBytes,rootSha256:createHash('sha256').update(rootBytes).digest('hex'),
    roleKeys:Object.fromEntries(['targets','snapshot','timestamp'].map(role=>[role,[{keyid,key:privateKey}]])),
    version:'0.2.0',sequence:1,sourceRevision:'a'.repeat(40),notes:{es:'Fixture sintética',en:'Synthetic fixture'},requirements:{es:'Node 24.21',en:'Node 24.21'},
    artifacts:[{os:'any',arch:'any',fileName:'keepseam-client-0.2.0.tgz',bytes:Buffer.from('Synthetic inert SDK fixture')}],documentation:Buffer.from('%PDF-1.7 Synthetic inert document fixture client-version=0.2.0 |'),keyid};
}
test('refresh reserves the Cloud revision field within the existing thirty kilobyte body limit', () => {
  const bundle = { manifest: 'm'.repeat(16384), metadata: { targets: '', snapshot: '{}', timestamp: '{}' } };
  const input = { requestId: '00000000-0000-4000-8000-000000000000', bundle };
  bundle.metadata.targets = 't'.repeat(30000 - Buffer.byteLength(JSON.stringify(input)));
  assert.equal(Buffer.byteLength(JSON.stringify(input)), 30000);
  assert.doesNotThrow(() => requireImportBundleBounds(bundle));
  assert.throws(() => requireImportBundleBounds(bundle, { refresh: true }), /bounded Cloud import contract/u);
  const refreshInput = { ...input, expectedRevision: 2147483646 };
  bundle.metadata.targets = bundle.metadata.targets.slice(Buffer.byteLength(JSON.stringify(refreshInput)) - 30000);
  assert.equal(Buffer.byteLength(JSON.stringify(refreshInput)), 30000);
  assert.doesNotThrow(() => requireImportBundleBounds(bundle, { refresh: true }));
});
class FixtureFetcher extends BaseFetcher {
  constructor(files){super();this.files=files;}
  async fetch(url){const bytes=this.files.get(url);assert(bytes,`Unexpected URL ${url}`);return new ReadableStream({start(controller){controller.enqueue(new Uint8Array(bytes));controller.close();}});}
}
test('release builder produces metadata accepted by the real TUF verifier with exact manifest and SDK hashes',async t=>{
  const signed=buildSignedRelease(fixture()),directory=await mkdtemp(join(tmpdir(),'keepseam-sign-release-test-'));
  t.after(()=>rm(directory,{recursive:true}));await mkdir(join(directory,'metadata'));await writeFile(join(directory,'metadata/root.json'),signed.root);
  const base='https://release.example.test/',files=new Map([...signed.metadata].map(([path,bytes])=>[`${base}metadata/${path}`,bytes]));
  const verifier=new Updater({metadataDir:join(directory,'metadata'),metadataBaseUrl:`${base}metadata/`,fetcher:new FixtureFetcher(files),config:{maxRootRotations:0,maxDelegations:0}});
  await verifier.refresh();
  for(const [path,bytes] of signed.targets){const target=await verifier.getTargetInfo(path);assert.equal(target.length,bytes.length);assert.equal(target.hashes.sha256,createHash('sha256').update(bytes).digest('hex'));}
  assert.equal(signed.manifest.publicationEligible,true);assert.equal(JSON.parse(signed.targets.get('channels/stable.json')).minimumNodeVersion,'24.21.0');
});
test('unsigned Windows executable remains a signed-metadata draft and never gains publisher verification',()=>{
  const input=fixture();input.artifacts.push({os:'windows',arch:'x64',fileName:'keepseam-0.2.0-win32-x64.tar.gz',bytes:Buffer.from('Synthetic unsigned executable archive')});
  const release=buildSignedRelease(input);assert.equal(release.manifest.publicationEligible,false);
  assert.deepEqual(release.manifest.artifacts[1].nativeSignature,{kind:'none',verified:false,publisher:null});
});
test('signing requires pinned root, role keys matching its identity and sufficient distinct signatures',()=>{
  const input=fixture();assert.throws(()=>buildSignedRelease({...input,rootSha256:'b'.repeat(64)}));
  assert.throws(()=>buildSignedRelease({...input,documentation:undefined}),/PDF/u);
  assert.throws(()=>buildSignedRelease({...input,roleKeys:{...input.roleKeys,targets:[]}}),/threshold/u);
  const other=generateKeyPairSync('ed25519');assert.throws(()=>buildSignedRelease({...input,roleKeys:{...input.roleKeys,targets:[{keyid:input.keyid,key:other.privateKey}]}}),/match/u);
  assert.throws(()=>buildSignedRelease({...input,roleKeys:{...input.roleKeys,targets:[...input.roleKeys.targets,...input.roleKeys.targets]}}),/duplicated/u);
});
test('release construction rejects metadata that cannot fit the bounded Cloud import contract',()=>{
  const input=fixture();
  assert.throws(()=>buildSignedRelease({...input,notes:{es:'字'.repeat(4000),en:'字'.repeat(4000)},requirements:{es:'字'.repeat(2000),en:'字'.repeat(2000)}}),/bounded Cloud import/u);
  for(const nativeSignature of [{kind:'not-required',verified:false,publisher:'a'.repeat(257)},
    {kind:'not-required',verified:false,publisher:null,privateContext:'never-export'}]) {
    assert.throws(()=>buildSignedRelease({...input,artifacts:[{...input.artifacts[0],nativeSignature}]}),/native signing receipt/u);
  }
});
test('operator signing command produces a real TUF feed and inert import bundle without publishing or exposing keys',async t=>{
  const input=fixture(),directory=await realpath(await mkdtemp(join(tmpdir(),'keepseam-release-sign-config-')));checkWindowsPermissions([directory],true,directory);t.after(()=>rm(directory,{recursive:true}));
  const rootFile=join(directory,'root.json'),keyFile=join(directory,'role.pem'),artifactFile=join(directory,input.artifacts[0].fileName),documentationFile=join(directory,'technical-guide.pdf');
  await writeFile(rootFile,input.rootBytes,{mode:0o600});await writeFile(keyFile,input.roleKeys.targets[0].key.export({format:'pem',type:'pkcs8'}),{mode:0o600});await writeFile(artifactFile,input.artifacts[0].bytes,{mode:0o600});await writeFile(documentationFile,input.documentation,{mode:0o600});
  const config={schemaVersion:1,rootFile,rootSha256:input.rootSha256,roleKeys:Object.fromEntries(['targets','snapshot','timestamp'].map(role=>[role,[{keyid:input.keyid,file:keyFile}]])),version:input.version,sequence:input.sequence,sourceRevision:input.sourceRevision,notes:input.notes,requirements:input.requirements,documentationFile,artifacts:[{os:'any',arch:'any',fileName:input.artifacts[0].fileName,file:artifactFile}]};
  const path=join(directory,'configuration.json');await writeFile(path,JSON.stringify(config),{mode:0o600});
  await writeFile(documentationFile,Buffer.from('%PDF-1.7 Synthetic wrong edition client-version=0.2.00 |'),{mode:0o600});
  await assert.rejects(signReleaseConfiguration(path,join(directory,'wrong-document')),/client version/u);
  await writeFile(documentationFile,input.documentation,{mode:0o600});
  const result=await signReleaseConfiguration(path,join(directory,'outputs')),bundle=JSON.parse(await readFile(join(result.directory,'import-bundle.json'),'utf8'));
  assert.equal(result.publicationEligible,true);assert.equal(JSON.parse(bundle.manifest).documentation.sha256,createHash('sha256').update(input.documentation).digest('hex'));
  assert.doesNotMatch(JSON.stringify(bundle),/PRIVATE KEY/u);
  const delivery=JSON.parse(await readFile(join(result.deliveryDirectory,'delivery.json'),'utf8'));
  const request=JSON.parse(await readFile(join(result.deliveryDirectory,'import-bundle.json'),'utf8'));
  assert.equal(request.requestId,delivery.importRequestId);assert.deepEqual(request.bundle,bundle);assert.equal(delivery.published,false);
  assert.deepEqual(await readFile(join(result.deliveryDirectory,'cloud-artifacts',input.artifacts[0].fileName)),input.artifacts[0].bytes);
  assert.deepEqual(await readFile(join(result.deliveryDirectory,'trust/root.json')),input.rootBytes);
  for(const file of delivery.files){const bytes=await readFile(join(result.deliveryDirectory,file.path));assert.equal(bytes.length,file.sizeBytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);}
  const updater=new Updater({metadataDir:join(result.directory,'metadata'),metadataBaseUrl:'https://synthetic-feed.invalid/metadata/',fetcher:new FixtureFetcher(new Map(['targets','snapshot','timestamp'].map(role=>[`https://synthetic-feed.invalid/metadata/${role}.json`,Buffer.from(bundle.metadata[role])]))),config:{maxRootRotations:0,maxDelegations:0}});
  await updater.refresh();assert.equal((await updater.getTargetInfo('channels/stable.json')).hashes.sha256,createHash('sha256').update(await readFile(join(result.directory,'targets/channels/stable.json'))).digest('hex'));
  const inputs=join(directory,'reviewed-inputs');await mkdir(inputs,{mode:0o700});
  await writeFile(join(inputs,input.artifacts[0].fileName),input.artifacts[0].bytes,{mode:0o600});await writeFile(join(inputs,'technical-guide.pdf'),input.documentation,{mode:0o600});
  const previousInput=process.env.KEEPSEAM_RELEASE_INPUT_DIRECTORY,previousRevision=process.env.KEEPSEAM_RELEASE_SOURCE_REVISION;
  try {
    process.env.KEEPSEAM_RELEASE_INPUT_DIRECTORY=inputs;process.env.KEEPSEAM_RELEASE_SOURCE_REVISION='b'.repeat(40);
    await assert.rejects(signReleaseConfiguration(path,join(directory,'wrong-source')),/reviewed release source/u);
    process.env.KEEPSEAM_RELEASE_SOURCE_REVISION=input.sourceRevision;
    const relocated=await signReleaseConfiguration(path,join(directory,'relocated'));
    assert.deepEqual(await readFile(join(relocated.deliveryDirectory,'cloud-artifacts',input.artifacts[0].fileName)),input.artifacts[0].bytes);
  } finally {
    if(previousInput===undefined)delete process.env.KEEPSEAM_RELEASE_INPUT_DIRECTORY;else process.env.KEEPSEAM_RELEASE_INPUT_DIRECTORY=previousInput;
    if(previousRevision===undefined)delete process.env.KEEPSEAM_RELEASE_SOURCE_REVISION;else process.env.KEEPSEAM_RELEASE_SOURCE_REVISION=previousRevision;
  }
});
test('delivery refuses altered artifact bytes or native receipts before creating output',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'keepseam-release-delivery-test-')));t.after(()=>rm(directory,{recursive:true}));
  const signed=buildSignedRelease(fixture()),sdk=signed.manifest.artifacts[0];signed.targets.set(sdk.target,Buffer.from('Changed unreviewed bytes'));
  await assert.rejects(writeReleaseDelivery(signed,join(directory,'changed')),/bytes differ/u);
  const original=buildSignedRelease(fixture());
  await assert.rejects(writeReleaseDelivery(original,join(directory,'receipt'),{nativeReceipts:[{schemaVersion:1,fileName:sdk.fileName,archiveSha256:'f'.repeat(64),executableSha256:'b'.repeat(64),nativeSignature:sdk.nativeSignature}]}),/does not bind/u);
});

const metadataVersions = release => Object.fromEntries([...release.metadata].map(([name, bytes]) => [name.replace('.json', ''), JSON.parse(bytes.toString()).signed.version]));
function refreshed(input, previous, now = Date.now()) {
  return refreshSignedRelease({ rootBytes: previous.root, rootSha256: input.rootSha256,
    manifestSha256: createHash('sha256').update(previous.importBundle.manifest).digest('hex'),
    previousBundle: previous.importBundle, targets: previous.targets, roleKeys: input.roleKeys, now });
}
async function verifierCache(t, initial) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'keepseam-refresh-tuf-test-')));
  t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, 'root.json'), initial.root);
  return { directory, verifier: release => new Updater({ metadataDir: directory, metadataBaseUrl: 'https://release.example.test/metadata/',
    fetcher: new FixtureFetcher(new Map([...release.metadata].map(([name, bytes]) => [`https://release.example.test/metadata/${name}`, bytes]))),
    config: { maxRootRotations: 0, maxDelegations: 0 } }) };
}

test('expired cached timestamp recovers with a legitimate refresh without changing product, root, targets or useful snapshot', async t => {
  const input = fixture(), previous = buildSignedRelease({ ...input, now: Date.now() - 2 * 3600000 });
  const cache = await verifierCache(t, previous);
  for (const [name, bytes] of previous.metadata) await writeFile(join(cache.directory, name), bytes);
  await assert.rejects(cache.verifier(previous).refresh(), /expired/u);
  const next = refreshed(input, previous);
  assert.deepEqual(metadataVersions(next), { targets: 1, snapshot: 1, timestamp: 2 });
  assert.deepEqual(next.root, previous.root); assert.equal(next.importBundle.manifest, previous.importBundle.manifest);
  assert.deepEqual(next.targets, previous.targets);
  for (const role of ['targets.json', 'snapshot.json']) assert.deepEqual(next.metadata.get(role), previous.metadata.get(role));
  const verifier = cache.verifier(next); await verifier.refresh();
  assert.equal((await verifier.getTargetInfo('release-manifest.json')).hashes.sha256, createHash('sha256').update(previous.importBundle.manifest).digest('hex'));
  const expires = Date.parse(JSON.parse(next.metadata.get('timestamp.json')).signed.expires);
  assert(expires > Date.now() && expires <= Date.now() + 3600000);
});

test('expired parent metadata renews its own version and exact hash references without rebuilding targets', async t => {
  for (const days of [2, 8]) {
    const input = fixture(), previous = buildSignedRelease({ ...input, now: Date.now() - days * 86400000 }), next = refreshed(input, previous);
    assert.deepEqual(metadataVersions(next), { targets: days === 2 ? 1 : 2, snapshot: 2, timestamp: 2 });
    assert.deepEqual(next.targets, previous.targets); assert.equal(next.importBundle.manifest, previous.importBundle.manifest);
    assert.deepEqual(JSON.parse(next.metadata.get('targets.json')).signed.targets, JSON.parse(previous.metadata.get('targets.json')).signed.targets);
    const cache = await verifierCache(t, previous); await cache.verifier(next).refresh();
  }
});

test('refresh never outlives its pinned root or overflows a metadata version', () => {
  const input = fixture(), now = Date.now(), expiry = new Date(now + 1800000).toISOString();
  const root = JSON.parse(input.rootBytes); root.signed.expires = expiry;
  root.signatures = [{ keyid: input.keyid, sig: sign(null, Buffer.from(canonicalTuf(root.signed)), input.roleKeys.targets[0].key).toString('hex') }];
  input.rootBytes = Buffer.from(JSON.stringify(root)); input.rootSha256 = createHash('sha256').update(input.rootBytes).digest('hex');
  const previous = buildSignedRelease({ ...input, now: now - 2 * 3600000 }), next = refreshed(input, previous, now);
  for (const bytes of next.metadata.values()) assert.equal(JSON.parse(bytes).signed.expires, expiry);
  const maximum = buildSignedRelease({ ...input, metadataVersions: { targets: 1, snapshot: 1, timestamp: 2147483646 }, now });
  assert.throws(() => refreshed(input, maximum, now), /metadata versions/u);
});

test('refresh refuses changed manifest, artifact, root, unauthenticated metadata and expired root', () => {
  const input = fixture(), previous = buildSignedRelease(input);
  const options = { rootBytes: previous.root, rootSha256: input.rootSha256,
    manifestSha256: createHash('sha256').update(previous.importBundle.manifest).digest('hex'),
    previousBundle: previous.importBundle, targets: previous.targets, roleKeys: input.roleKeys };
  assert.throws(() => refreshSignedRelease({ ...options, previousBundle: { ...previous.importBundle,
    manifest: JSON.stringify({ ...previous.manifest, sourceRevision: 'b'.repeat(40) }) } }), /manifest mismatch/u);
  const changedTargets = new Map(previous.targets); changedTargets.set(previous.manifest.artifacts[0].target, Buffer.from('unreviewed bytes'));
  assert.throws(() => refreshSignedRelease({ ...options, targets: changedTargets }), /target bytes changed/u);
  assert.throws(() => refreshSignedRelease({ ...options, rootBytes: fixture().rootBytes }), /root mismatch/u);
  const timestamp = JSON.parse(previous.importBundle.metadata.timestamp); timestamp.signed.version++;
  assert.throws(() => refreshSignedRelease({ ...options, previousBundle: { ...previous.importBundle,
    metadata: { ...previous.importBundle.metadata, timestamp: JSON.stringify(timestamp) } } }), /metadata signature/u);
  assert.throws(() => refreshSignedRelease({ ...options, now: Date.parse('2099-01-01T00:00:01Z') }), /expired pinned TUF root/u);
});

test('operator rejects deeply nested root and targets before recursive canonicalization', () => {
  const input = fixture(), previous = buildSignedRelease(input);
  const options = { rootBytes: previous.root, rootSha256: input.rootSha256,
    manifestSha256: createHash('sha256').update(previous.importBundle.manifest).digest('hex'),
    previousBundle: previous.importBundle, targets: previous.targets, roleKeys: input.roleKeys };
  let nested = null; for (let index = 0; index < 1000; index++) nested = [nested];
  const root = JSON.parse(previous.root); root.signed.extra = nested;
  const rootBytes = Buffer.from(JSON.stringify(root));
  const boundedError = error => !(error instanceof RangeError) && /bounded TUF structure/u.test(error.message);
  assert.throws(() => refreshSignedRelease({ ...options, rootBytes, rootSha256: createHash('sha256').update(rootBytes).digest('hex') }), boundedError);
  const targets = JSON.parse(previous.importBundle.metadata.targets); targets.signed.extra = nested;
  assert.throws(() => refreshSignedRelease({ ...options, previousBundle: { ...previous.importBundle,
    metadata: { ...previous.importBundle.metadata, targets: JSON.stringify(targets) } } }), boundedError);
  assert.throws(() => canonicalTuf(Array(4097).fill(null)), boundedError);
});

test('release after repeated refresh uses independent metadata versions; real TUF refuses every role rollback', async t => {
  const input = fixture(); let previous = buildSignedRelease({ ...input, metadataVersions: { targets: 3, snapshot: 3, timestamp: 3 } });
  for (let index = 0; index < 3; index++) previous = refreshed(input, previous);
  assert.deepEqual(metadataVersions(previous), { targets: 3, snapshot: 3, timestamp: 6 });
  const nextInput = { ...input, version: '0.3.0', sequence: 2,
    artifacts: [{ ...input.artifacts[0], fileName: 'keepseam-client-0.3.0.tgz', bytes: Buffer.from('New reviewed SDK fixture') }] };
  for (const versions of [undefined, { targets: 4, snapshot: 2, timestamp: 7 }, { targets: 2, snapshot: 4, timestamp: 7 }]) {
    const cache = await verifierCache(t, previous); await cache.verifier(previous).refresh();
    const rollback = buildSignedRelease({ ...nextInput, ...(versions ? { metadataVersions: versions } : {}) });
    await assert.rejects(cache.verifier(rollback).refresh(), /version|less than/iu);
  }
  const cache = await verifierCache(t, previous); await cache.verifier(previous).refresh();
  const next = buildSignedRelease({ ...nextInput, metadataVersions: { targets: 4, snapshot: 4, timestamp: 7 } });
  const verifier = cache.verifier(next); await verifier.refresh();
  assert.equal(next.manifest.sequence, 2); assert.deepEqual(metadataVersions(next), { targets: 4, snapshot: 4, timestamp: 7 });
  assert.equal((await verifier.getTargetInfo(next.manifest.artifacts[0].target)).hashes.sha256, next.manifest.artifacts[0].sha256);
  for (const invalid of [null, {}, { targets: 1, snapshot: 1, timestamp: 0 }, { targets: 1, snapshot: 1, timestamp: 2147483647 },
    { targets: 1, snapshot: 1, timestamp: 1, root: 1 }]) assert.throws(() => buildSignedRelease({ ...input, metadataVersions: invalid }), /metadata versions/u);
});

test('operator refresh writes a separate delivery, preserves original files and refuses altered inputs before output', async t => {
  const input = fixture(), directory = await realpath(await mkdtemp(join(tmpdir(), 'keepseam-release-refresh-config-')));
  checkWindowsPermissions([directory], true, directory); t.after(() => rm(directory, { recursive: true }));
  const previous = buildSignedRelease({ ...input, now: Date.now() - 2 * 3600000 });
  const original = await writeSignedRelease(previous, directory), keyFile = join(directory, 'role.pem');
  await writeFile(keyFile, input.roleKeys.targets[0].key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const config = { schemaVersion: 1, releaseDirectory: original.directory, rootSha256: input.rootSha256, manifestSha256: original.manifestSha256,
    roleKeys: Object.fromEntries(['targets', 'snapshot', 'timestamp'].map(role => [role, [{ keyid: input.keyid, file: keyFile }]])) };
  const configPath = join(directory, 'refresh.json'); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  // The unused offline keys need not be present or readable for hourly renewal.
  config.roleKeys.targets[0].file = join(directory, 'offline-targets-must-not-open.pem');
  config.roleKeys.snapshot[0].file = join(directory, 'offline-snapshot-must-not-open.pem');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const result = await refreshReleaseConfiguration(configPath, directory);
  assert.notEqual(result.directory, original.directory); assert.equal(result.manifestSha256, original.manifestSha256);
  assert.deepEqual(result.metadataVersions, { targets: 1, snapshot: 1, timestamp: 2 });
  assert.deepEqual(await readFile(join(original.directory, 'metadata/timestamp.json')), previous.metadata.get('timestamp.json'));
  const delivery = JSON.parse(await readFile(join(result.deliveryDirectory, 'delivery.json'), 'utf8'));
  assert.equal(delivery.rootSha256, input.rootSha256); assert.equal(delivery.manifestSha256, original.manifestSha256);
  assert.equal(delivery.sourceRevision, input.sourceRevision); assert.equal(delivery.published, false);
  for (const target of previous.manifest.artifacts) assert.deepEqual(await readFile(join(result.deliveryDirectory, 'cloud-artifacts', target.fileName)), previous.targets.get(target.target));
  assert.deepEqual(await readFile(join(result.deliveryDirectory, 'trust/root.json')), previous.root);
  assert.doesNotMatch(await readFile(join(result.deliveryDirectory, 'import-bundle.json'), 'utf8'), /PRIVATE KEY/u);
  const onlyTimestamp = { ...config, releaseDirectory: result.directory, roleKeys: { timestamp: config.roleKeys.timestamp } };
  await writeFile(configPath, JSON.stringify(onlyTimestamp), { mode: 0o600 });
  assert.deepEqual((await refreshReleaseConfiguration(configPath, directory)).metadataVersions, { targets: 1, snapshot: 1, timestamp: 3 });
  const expired = await writeSignedRelease(buildSignedRelease({ ...input, now: Date.now() - 8 * 86400000 }), directory);
  await writeFile(configPath, JSON.stringify({ ...onlyTimestamp, releaseDirectory: expired.directory }), { mode: 0o600 });
  await assert.rejects(refreshReleaseConfiguration(configPath, directory), /Invalid release role keys/u);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(original.directory, 'targets', previous.manifest.artifacts[0].target), Buffer.from('altered'));
  await assert.rejects(refreshReleaseConfiguration(configPath, join(directory, 'rejected')), /target bytes changed/u);
  await assert.rejects(readFile(join(directory, 'rejected/delivery.json')), error => error.code === 'ENOENT');
});
