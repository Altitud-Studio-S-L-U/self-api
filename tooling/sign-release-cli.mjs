import {createHash,createPrivateKey,randomUUID} from 'node:crypto';
import {constants,lstatSync,openSync,closeSync,readSync,fstatSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildSignedRelease} from './sign-release.mjs';
import {releaseNativeReceipts} from './release-export.mjs';
import {releaseRepositoryFiles} from './release-repository.mjs';
import {checkServicePath,checkWindowsServiceAcl} from '../dist/worker-service-state.js';
import {checkWindowsPermissions} from '../dist/windows-permissions.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function boundedFile(path,limit,privateAccess=false) {
  if(typeof path!=='string' || !isAbsolute(path))throw new Error('Signing input requires an absolute local path.');
  checkServicePath(path,privateAccess?'secret':'config');checkWindowsServiceAcl(path,privateAccess);
  const before=lstatSync(path,{bigint:true});
  if(before.size>BigInt(limit))throw new Error('Signing input exceeds its bounded size.');
  const fd=openSync(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW|constants.O_NONBLOCK));
  try {
    const opened=fstatSync(fd,{bigint:true});if(opened.dev!==before.dev || opened.ino!==before.ino || opened.size!==before.size || opened.nlink!==1n || !opened.isFile())throw new Error('Signing input changed.');
    const bytes=Buffer.alloc(Number(opened.size)+1);let length=0;
    while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,length);if(count===0)break;length+=count;}
    const after=fstatSync(fd,{bigint:true});
    if(length!==Number(opened.size) || after.size!==opened.size || after.mtimeNs!==opened.mtimeNs || after.ctimeNs!==opened.ctimeNs)throw new Error('Signing input changed.');
    return bytes.subarray(0,length);
  }finally{closeSync(fd);}
}

export function loadReleaseRoleKeys(input,requiredRoles=['targets','snapshot','timestamp']) {
  const allowed=['targets','snapshot','timestamp'];
  if(!input || Object.keys(input).some(role=>!allowed.includes(role)) || requiredRoles.some(role=>!allowed.includes(role))
    || new Set(requiredRoles).size!==requiredRoles.length)throw new Error('Invalid release role keys.');
  return Object.fromEntries(requiredRoles.map(role=>{
    const items=input[role];if(!Array.isArray(items) || items.length<1 || items.length>5)throw new Error('Invalid release role keys.');
    return[role,items.map(item=>{if(!item || Object.keys(item).sort().join(',')!=='file,keyid')throw new Error('Invalid release role key.');return{keyid:item.keyid,key:createPrivateKey(boundedFile(item.file,8192,true))};})];
  }));
}

export async function writeSignedRelease(signed,outputParent,{prefix='signed',nativeReceipts=[]}={}) {
  if(!['signed','refreshed'].includes(prefix))throw new Error('Invalid signed release output kind.');
  const repositoryFiles=releaseRepositoryFiles(signed);
  const receipts=releaseNativeReceipts(signed,nativeReceipts);
  await mkdir(outputParent,{recursive:true,mode:0o700});
  const directory=join(outputParent,`${prefix}-${signed.manifest.version}-${randomUUID()}`);await mkdir(directory,{mode:0o700});checkWindowsPermissions([directory],true,directory);
  for(const [name,bytes] of new Map([['metadata/root.json',signed.root],...Array.from(signed.metadata,([name,bytes])=>[`metadata/${name}`,bytes]),...Array.from(signed.targets,([name,bytes])=>[`targets/${name}`,bytes]),...Array.from(repositoryFiles,([name,bytes])=>[`repository/${name}`,bytes]),...receipts,['release-bundle.json',Buffer.from(JSON.stringify(signed.releaseBundle))]])) {
    const target=join(directory,name);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});
  }
  return{directory,repositoryDirectory:join(directory,'repository'),version:signed.manifest.version,sequence:signed.manifest.sequence,publicationEligible:signed.manifest.publicationEligible,
    manifestSha256:hash(signed.targets.get('release-manifest.json')),
    metadataVersions:Object.fromEntries([...signed.metadata].map(([name,bytes])=>[name.replace('.json',''),JSON.parse(bytes.toString()).signed.version]))};
}

/** The configuration contains public metadata and private-key paths, never key
 * material. Output is a new private local directory; this command has no HTTP. */
export async function signReleaseConfiguration(path,outputParent=resolve(import.meta.dirname,'../work/releases')) {
  const config=JSON.parse(boundedFile(path,32768).toString());
  if(!config || Object.keys(config).filter(key=>key!=='metadataVersions').sort().join(',')!=='artifacts,documentationFile,notes,requirements,roleKeys,rootFile,rootSha256,schemaVersion,sequence,sourceRevision,version' || config.schemaVersion!==1)throw new Error('Invalid release signing configuration.');
  const inputDirectory=process.env.SELF_MANAGED_API_RELEASE_INPUT_DIRECTORY;
  if(inputDirectory) {
    if(!isAbsolute(inputDirectory))throw new Error('Release input directory requires an absolute path.');
    checkServicePath(inputDirectory,'directory');checkWindowsServiceAcl(inputDirectory,false);
    if(!Array.isArray(config.artifacts))throw new Error('Invalid artifacts.');
    for(const artifact of config.artifacts) {
      if(typeof artifact?.fileName!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:tgz|zip|tar\.gz)$/u.test(artifact.fileName) || artifact.fileName.includes('..'))throw new Error('Invalid release input filename.');
      artifact.file=join(inputDirectory,artifact.fileName);
      if(artifact.signingReceiptFile)artifact.signingReceiptFile=join(inputDirectory,`${artifact.fileName}.signing.json`);
    }
    config.documentationFile=join(inputDirectory,'technical-guide.pdf');
  }
  const roleKeys=loadReleaseRoleKeys(config.roleKeys);
  if(!Array.isArray(config.artifacts) || config.artifacts.length>12)throw new Error('Invalid artifacts.');
  const nativeReceipts=[];
  const artifacts=config.artifacts.map(item=>{
    if(!item || Object.keys(item).some(field=>!['os','arch','fileName','file','signingReceiptFile'].includes(field)))throw new Error('Invalid artifact fields.');
    const bytes=boundedFile(item.file,64*1024*1024);let nativeSignature;
    if(item.signingReceiptFile) {
      const receipt=JSON.parse(boundedFile(item.signingReceiptFile,8192).toString());
      if(receipt.schemaVersion!==1 || receipt.fileName!==item.fileName || receipt.archiveSha256!==hash(bytes) || !/^[a-f0-9]{64}$/u.test(receipt.executableSha256))throw new Error('Native receipt does not bind this archive.');
      nativeSignature=receipt.nativeSignature;
      nativeReceipts.push({schemaVersion:1,fileName:receipt.fileName,archiveSha256:receipt.archiveSha256,executableSha256:receipt.executableSha256,nativeSignature});
    }
    return{os:item.os,arch:item.arch,fileName:item.fileName,bytes,...(nativeSignature?{nativeSignature}:{})};
  });
  const documentation=boundedFile(config.documentationFile,8*1024*1024);
  if(!documentation.toString('latin1').includes(`client-version=${config.version} |`))throw new Error('Technical PDF does not identify this client version.');
  if(process.env.SELF_MANAGED_API_RELEASE_SOURCE_REVISION && config.sourceRevision!==process.env.SELF_MANAGED_API_RELEASE_SOURCE_REVISION)throw new Error('Signing configuration differs from the reviewed release source.');
  const signed=buildSignedRelease({...config,rootBytes:boundedFile(config.rootFile,512000),roleKeys,artifacts,documentation});
  return writeSignedRelease(signed,outputParent,{nativeReceipts});
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href) {
  if(process.argv.length!==4 || process.argv[2]!=='--config')throw new Error('Usage: node tooling/sign-release-cli.mjs --config /absolute/operator/config.json');
  try{console.log(JSON.stringify(await signReleaseConfiguration(process.argv[3])));}catch{console.error('Release signing failed; no release was published. Check bounded inputs, key permissions, trust and native receipts.');process.exitCode=1;}
}
