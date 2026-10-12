import {createHash,createPrivateKey,randomUUID} from 'node:crypto';
import {constants,lstatSync,openSync,closeSync,readSync,fstatSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildSignedRelease} from './sign-release.mjs';
import {checkServicePath,checkWindowsServiceAcl} from '../dist/worker-service-state.js';
import {checkWindowsPermissions} from '../dist/windows-permissions.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function boundedFile(path,limit,privateAccess=false) {
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

/** The configuration contains public metadata and private-key paths, never key
 * material. Output is a new private local directory; this command has no HTTP. */
export async function signReleaseConfiguration(path,outputParent=resolve(import.meta.dirname,'../work/releases')) {
  const config=JSON.parse(boundedFile(path,32768).toString());
  if(!config || Object.keys(config).sort().join(',')!=='artifacts,documentationFile,notes,requirements,roleKeys,rootFile,rootSha256,schemaVersion,sequence,sourceRevision,version' || config.schemaVersion!==1)throw new Error('Invalid release signing configuration.');
  if(!config.roleKeys || Object.keys(config.roleKeys).sort().join(',')!=='snapshot,targets,timestamp')throw new Error('Invalid release role keys.');
  const roleKeys=Object.fromEntries(['targets','snapshot','timestamp'].map(role=>{
    const items=config.roleKeys?.[role];if(!Array.isArray(items) || items.length<1 || items.length>5)throw new Error('Invalid release role keys.');
    return[role,items.map(item=>{if(!item || Object.keys(item).sort().join(',')!=='file,keyid')throw new Error('Invalid release role key.');return{keyid:item.keyid,key:createPrivateKey(boundedFile(item.file,8192,true))};})];
  }));
  if(!Array.isArray(config.artifacts) || config.artifacts.length>12)throw new Error('Invalid artifacts.');
  const artifacts=config.artifacts.map(item=>{
    if(!item || Object.keys(item).some(field=>!['os','arch','fileName','file','signingReceiptFile'].includes(field)))throw new Error('Invalid artifact fields.');
    const bytes=boundedFile(item.file,64*1024*1024);let nativeSignature;
    if(item.signingReceiptFile) {
      const receipt=JSON.parse(boundedFile(item.signingReceiptFile,8192).toString());
      if(receipt.schemaVersion!==1 || receipt.fileName!==item.fileName || receipt.archiveSha256!==hash(bytes) || !/^[a-f0-9]{64}$/u.test(receipt.executableSha256))throw new Error('Native receipt does not bind this archive.');
      nativeSignature=receipt.nativeSignature;
    }
    return{os:item.os,arch:item.arch,fileName:item.fileName,bytes,...(nativeSignature?{nativeSignature}:{})};
  });
  const signed=buildSignedRelease({...config,rootBytes:boundedFile(config.rootFile,512000),roleKeys,artifacts,documentation:boundedFile(config.documentationFile,8*1024*1024)});
  await mkdir(outputParent,{recursive:true,mode:0o700});
  const directory=join(outputParent,`signed-${config.version}-${randomUUID()}`);await mkdir(directory,{mode:0o700});checkWindowsPermissions([directory],true,directory);
  for(const [name,bytes] of new Map([['metadata/root.json',signed.root],...Array.from(signed.metadata,([name,bytes])=>[`metadata/${name}`,bytes]),...Array.from(signed.targets,([name,bytes])=>[`targets/${name}`,bytes]),['import-bundle.json',Buffer.from(JSON.stringify(signed.importBundle))]])) {
    const target=join(directory,name);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});
  }
  return{directory,version:config.version,sequence:config.sequence,publicationEligible:signed.manifest.publicationEligible,manifestSha256:hash(signed.targets.get('release-manifest.json'))};
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href) {
  if(process.argv.length!==4 || process.argv[2]!=='--config')throw new Error('Usage: node tooling/sign-release-cli.mjs --config /absolute/operator/config.json');
  try{console.log(JSON.stringify(await signReleaseConfiguration(process.argv[3])));}catch{console.error('Release signing failed; no release was published. Check bounded inputs, key permissions, trust and native receipts.');process.exitCode=1;}
}
