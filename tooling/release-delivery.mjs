import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireValue=(condition,message)=>{if(!condition)throw new Error(message);};

/** Projects the exact output of buildSignedRelease into the existing Cloud
 * filesystem/import contract. It never provisions trust or publishes a row. */
export async function writeReleaseDelivery(release,directory,{requestId=randomUUID(),nativeReceipts=[]}={}) {
  requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId),'Invalid delivery request identity.');
  const {manifest,root,targets,importBundle}=release;
  requireValue(JSON.stringify(manifest)===importBundle.manifest && Buffer.isBuffer(root),'Release delivery does not match its signed manifest.');
  const metadata=JSON.parse(importBundle.manifest),files=[];
  const payload={requestId,bundle:importBundle},payloadBytes=Buffer.from(JSON.stringify(payload));
  requireValue(payloadBytes.length<=30000,'Release delivery exceeds the Cloud import limit.');
  const targetRecords=[...metadata.artifacts,metadata.documentation];
  const names=new Set();
  for(const record of targetRecords) {
    requireValue(typeof record.fileName==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:tgz|zip|tar\.gz|pdf)$/u.test(record.fileName)
      && !record.fileName.includes('..') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(record.fileName) && !names.has(record.fileName),'Invalid delivery artifact filename.');
    names.add(record.fileName);
    const bytes=targets.get(record.target);
    requireValue(Buffer.isBuffer(bytes)&&bytes.length===record.sizeBytes&&hash(bytes)===record.sha256,'Delivery artifact bytes differ from signed metadata.');
    files.push({path:`cloud-artifacts/${record.fileName}`,bytes});
  }
  for(const receipt of nativeReceipts) {
    const artifact=metadata.artifacts.find(value=>value.fileName===receipt.fileName);
    requireValue(artifact && receipt.schemaVersion===1 && artifact.sha256===receipt.archiveSha256
      && /^[a-f0-9]{64}$/u.test(receipt.executableSha256)
      && JSON.stringify(receipt.nativeSignature)===JSON.stringify(artifact.nativeSignature),'Delivery native receipt does not bind its signed archive.');
    files.push({path:`native-receipts/${receipt.fileName}.signing.json`,bytes:Buffer.from(JSON.stringify({schemaVersion:1,fileName:receipt.fileName,
      archiveSha256:receipt.archiveSha256,executableSha256:receipt.executableSha256,nativeSignature:receipt.nativeSignature}))});
  }
  files.push({path:'trust/root.json',bytes:root},{path:'import-bundle.json',bytes:payloadBytes});
  requireValue(new Set(files.map(value=>value.path)).size===files.length,'Duplicate delivery path.');
  const inventory={schemaVersion:1,version:metadata.version,sequence:metadata.sequence,sourceRevision:metadata.sourceRevision,
    rootSha256:hash(root),manifestSha256:hash(Buffer.from(importBundle.manifest)),importRequestId:requestId,
    publicationEligible:metadata.publicationEligible,published:false,
    files:files.map(({path,bytes})=>({path,sha256:hash(bytes),sizeBytes:bytes.length}))};
  // The signed directory is new and private. Refuse replacement of a prior delivery.
  await mkdir(directory,{mode:0o700});
  await mkdir(join(directory,'cloud-artifacts'),{mode:0o700});await mkdir(join(directory,'trust'),{mode:0o700});
  if(nativeReceipts.length)await mkdir(join(directory,'native-receipts'),{mode:0o700});
  for(const {path,bytes} of files)await writeFile(join(directory,path),bytes,{flag:'wx',mode:0o600});
  await writeFile(join(directory,'delivery.json'),JSON.stringify(inventory,null,2)+'\n',{flag:'wx',mode:0o600});
  return inventory;
}
