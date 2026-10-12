import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BaseFetcher, Updater } from 'tuf-js';
import { buildSignedRelease, canonicalTuf } from '../tooling/sign-release.mjs';
import {signReleaseConfiguration} from '../tooling/sign-release-cli.mjs';
import {checkWindowsPermissions} from '../dist/windows-permissions.js';

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
    artifacts:[{os:'any',arch:'any',fileName:'keepseam-client-0.2.0.tgz',bytes:Buffer.from('Synthetic inert SDK fixture')}],documentation:Buffer.from('%PDF-1.7 Synthetic inert document fixture'),keyid};
}
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
  const result=await signReleaseConfiguration(path,join(directory,'outputs')),bundle=JSON.parse(await readFile(join(result.directory,'import-bundle.json'),'utf8'));
  assert.equal(result.publicationEligible,true);assert.equal(JSON.parse(bundle.manifest).documentation.sha256,createHash('sha256').update(input.documentation).digest('hex'));
  assert.doesNotMatch(JSON.stringify(bundle),/PRIVATE KEY/u);
  const updater=new Updater({metadataDir:join(result.directory,'metadata'),metadataBaseUrl:'https://synthetic-feed.invalid/metadata/',fetcher:new FixtureFetcher(new Map(['targets','snapshot','timestamp'].map(role=>[`https://synthetic-feed.invalid/metadata/${role}.json`,Buffer.from(bundle.metadata[role])]))),config:{maxRootRotations:0,maxDelegations:0}});
  await updater.refresh();assert.equal((await updater.getTargetInfo('channels/stable.json')).hashes.sha256,createHash('sha256').update(await readFile(join(result.directory,'targets/channels/stable.json'))).digest('hex'));
});
