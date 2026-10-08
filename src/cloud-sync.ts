import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { closeSync,lstatSync,mkdirSync,openSync,realpathSync } from 'node:fs';
import { isAbsolute,join,parse,relative,resolve,sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCloudTransport,type CloudCredentials,type CloudTransport } from './cloud-connection.js';
import { decodeCloudStatusEvent,deriveCloudIdentifier,encodeCloudStatusEvent,type CloudStatusEvent } from './cloud-protocol.js';
import { openExistingWorkerStore } from './worker.js';
import type { ExecutionIntent,WorkerJob } from './worker-store.js';
import { PlumberError } from './errors.js';

export interface CloudSyncOptions {
  readonly statePath:string;readonly cloudStatePath:string;readonly credentials:CloudCredentials;
  /** Cancellation interrupts transport, retains unacknowledged outbox entries and releases sync ownership. */
  readonly signal?:AbortSignal;
  /** Only these explicitly approved local subscriptions may contribute metadata. */
  readonly integrationIds:readonly string[];
}
export interface CloudSyncResult {readonly sent:number;readonly pending:number;readonly state:'synced'|'busy'|'pending';}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const appId=0x4b53434c;
function invalid(message:string):never {throw new PlumberError('INVALID_INPUT',message);}
function nested(parent:string,child:string):boolean {const path=relative(parent,child);return path==='' || (!path.startsWith(`..${sep}`) && path!=='..' && !isAbsolute(path));}
function secureDirectory(value:string):string {
  if (!value || /^[\\/]{2}/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) invalid('Cloud state requires a local directory.');
  const tail=process.platform==='win32' && /^[a-z]:[\\/]/iu.test(value)?value.slice(2):value;
  if (tail.includes(':') || /(?:^|[\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[. ]|$)/iu.test(tail)) invalid('Cloud state does not support device paths or alternate streams.');
  if (process.platform==='win32' && tail.split(/[\\/]/u).some(part=>part!=='.' && part!=='..' && /[. ]$/u.test(part))) invalid('Cloud state does not support ambiguous path segments.');
  const path=resolve(value),root=parse(path).root;let current=root;
  for (const part of ['',...path.slice(root.length).split(sep).filter(Boolean)]) {
    if (part) current=join(current,part);
    let info;
    try {info=lstatSync(current);}catch(error){
      if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
      try {mkdirSync(current,{mode:0o700});}catch(creation){if ((creation as NodeJS.ErrnoException).code!=='EEXIST') throw creation;}
      info=lstatSync(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) invalid('Cloud state ancestors must be real directories.');
  }
  return realpathSync(path);
}
async function database(directory:string):Promise<DatabaseSync> {
  const path=join(directory,'cloud.sqlite3');
  for (const suffix of ['','-journal','-wal','-shm']) {
    try {const info=lstatSync(path+suffix);if (!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || (process.platform!=='win32' && (info.mode&0o077)!==0)) invalid('Cloud state must be a private regular file.');}
    catch(error){if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  }
  try {const fd=openSync(path,'wx',0o600);closeSync(fd);}catch(error){if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path,{timeout:1000,allowExtension:false,enableDoubleQuotedStringLiterals:false});
  try {
    const actual=Number(db.prepare('PRAGMA application_id').get()!['application_id']);
    if (actual!==appId && (actual!==0 || Number(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get()!['count'])!==0)) invalid('Cloud state belongs to another application.');
    db.exec(`PRAGMA application_id=${appId}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),installation TEXT NOT NULL,project TEXT NOT NULL,next_sequence INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_until INTEGER);
      CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY,event TEXT NOT NULL CHECK(length(event)<=4096));
      CREATE TABLE IF NOT EXISTS projected(job_id TEXT PRIMARY KEY,digest TEXT NOT NULL);`);
    return db;
  }catch(error){db.close();throw error;}
}

/** Only enumerated states and counts cross this boundary; the report remains local. */
export function summarizeCloudJob(job:WorkerJob,execution:ExecutionIntent|undefined,installationId:string):Extract<CloudStatusEvent['body'],{type:'maintenance-status'}> {
  let state:Extract<CloudStatusEvent['body'],{type:'maintenance-status'}>['state']='decision-required';
  let reason:CloudStatusEvent['body']['reason']='approval-required';
  if (execution?.status==='queued' || execution?.status==='running') {state='proposal-ready';reason='none';}
  else if (execution?.status==='completed' && execution.outcome) {
    if (['passed','improved'].includes(execution.outcome.status)) {state='validated';reason='none';}
    else if (['regression','failed'].includes(execution.outcome.status)) {state='validation-failed';reason='validation-failed';}
    else {state='blocked';reason='runtime-unavailable';}
  } else if (execution?.status==='blocked' || execution?.status==='interrupted') {
    state='blocked';reason=execution.reason==='stale-evidence'?'stale-evidence':execution.reason==='approval-invalid'?'approval-expired':'runtime-unavailable';
  }
  const operations=new Set(job.report.matches.map(match=>job.report.comparison.changes[match.changeIndex]).filter(change=>change?.operation && change.path).map(change=>`${change!.operation} ${change!.path}`));
  // The worker selects test files, not individual test cases. A completely
  // passing candidate proves every selected target; partial case counts aren't known.
  const selectedTests=execution?.testPaths.length??0;
  return {type:'maintenance-status',integrationId:deriveCloudIdentifier(job.subscriptionId,installationId),jobId:deriveCloudIdentifier(job.id,installationId),state,reason,
    affectedOperations:operations.size,selectedTests,passingTests:state==='validated'?selectedTests:0};
}

export async function syncWorkerToCloud(options:CloudSyncOptions):Promise<CloudSyncResult> {
  const transport=createCloudTransport(options.credentials,options.signal === undefined ? {} : {signal:options.signal});
  return sync(options,transport);
}

async function sync(options:CloudSyncOptions,transport:CloudTransport):Promise<CloudSyncResult> {
  if (!Array.isArray(options.integrationIds) || options.integrationIds.length<1 || options.integrationIds.length>100 || new Set(options.integrationIds).size!==options.integrationIds.length
    || options.integrationIds.some(id=>typeof id!=='string' || !/^[a-f0-9]{64}$/u.test(id))) invalid('Select between 1 and 100 unique local subscriptions to share.');
  const store=await openExistingWorkerStore(options.statePath);
  let jobs:WorkerJob[],executions:ExecutionIntent[],blocked=false;
  try {
    const subscriptions=store.listSubscriptions();
    if (options.integrationIds.some(id=>!subscriptions.some(subscription=>subscription.id===id))) invalid('Every shared subscription must exist in this worker.');
    for (const subscription of subscriptions) if (nested(subscription.consumerRoot,resolve(options.cloudStatePath))) invalid('Cloud state must remain outside every consumer codebase.');
    blocked=subscriptions.some(subscription=>options.integrationIds.includes(subscription.id) && subscription.lastError!==null);
    jobs=store.listJobs().filter(job=>options.integrationIds.includes(job.subscriptionId));
    executions=store.listExecutionIntents();
  } finally {store.close();}
  const directory=secureDirectory(options.cloudStatePath),db=await database(directory),owner=randomUUID();
  const allowed=new Set(options.integrationIds.map(id=>deriveCloudIdentifier(id,transport.installationId)));
  let sent=0;
  const pending=()=>Number(db.prepare('SELECT count(*) AS count FROM outbox').get()!['count']);
  const renew=()=>{
    if (Number(db.prepare('UPDATE identity SET lease_until=? WHERE id=1 AND lease_owner=? AND lease_until>?').run(Date.now()+30_000,owner,Date.now()).changes)!==1) invalid('Cloud sync lease expired; retry with its persisted outbox.');
  };
  const flush=async()=>{
    while (sent<50) {
      const row=db.prepare('SELECT sequence,event FROM outbox ORDER BY sequence LIMIT 1').get();if (!row) break;
      const event=decodeCloudStatusEvent(String(row['event']));
      if (event.body.type==='maintenance-status' && !allowed.has(event.body.integrationId)) invalid('Pending Cloud events require their original sharing approval.');
      renew();await transport.send(event);renew();
      db.prepare('DELETE FROM outbox WHERE sequence=?').run(Number(row['sequence']));sent++;
    }
  };
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO identity(id,installation,project) VALUES(1,?,?)').run(transport.installationId,transport.projectId);
      const identity=db.prepare('SELECT * FROM identity WHERE id=1').get()!;
      if (identity['installation']!==transport.installationId || identity['project']!==transport.projectId) invalid('Cloud state is bound to another installation or project.');
      if (Number(identity['lease_until'])>Date.now()) {db.exec('COMMIT');return {sent:0,pending:pending(),state:'busy'};}
      db.prepare('UPDATE identity SET lease_owner=?,lease_until=? WHERE id=1').run(owner,Date.now()+30_000);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    await flush();
    if (pending()) return {sent,pending:pending(),state:'pending'};
    renew();db.exec('BEGIN IMMEDIATE');
    try {
      let next=Number(db.prepare('SELECT next_sequence FROM identity WHERE id=1').get()!['next_sequence']);
      const enqueue=(body:CloudStatusEvent['body'],recordedAt=new Date().toISOString())=>{
        if (next>1_000_000 || pending()>=1000) throw new PlumberError('STATE_LIMIT','Cloud outbox limit reached; retain state and enroll a new installation explicitly.');
        const event=encodeCloudStatusEvent({schemaVersion:1,eventId:randomBytes(32).toString('hex'),installationId:transport.installationId,projectId:transport.projectId,sequence:next,recordedAt,body});
        db.prepare('INSERT INTO outbox(sequence,event) VALUES(?,?)').run(next++,event);
      };
      const bodies=jobs.map(job=>{
        const execution=executions.filter(item=>item.jobId===job.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.updatedAt.localeCompare(a.updatedAt))[0];
        return {body:summarizeCloudJob(job,execution,transport.installationId),recordedAt:execution?.updatedAt??job.createdAt};
      });
      for (const {body,recordedAt} of bodies) {
        const digest=hash(JSON.stringify(body));
        if (db.prepare('SELECT digest FROM projected WHERE job_id=?').get(body.jobId)?.['digest']===digest) continue;
        // Reserve one slot for the heartbeat. Remaining jobs stay unprojected
        // in the durable worker store and are picked up after this batch drains.
        if (pending()>=999) break;
        enqueue(body,recordedAt);db.prepare('INSERT INTO projected(job_id,digest) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET digest=excluded.digest').run(body.jobId,digest);
      }
      const pendingJobs=bodies.filter(({body})=>!['validated','published','merged','no-impact'].includes(body.state)).length;
      const validating=executions.some(item=>item.status==='running' && jobs.some(job=>job.id===item.jobId));
      enqueue({type:'runner-status',state:validating?'validating':blocked?'blocked':pendingJobs?'review-required':'idle',reason:blocked?'runtime-unavailable':pendingJobs?'approval-required':'none',pendingJobs});
      db.prepare('UPDATE identity SET next_sequence=? WHERE id=1').run(next);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    await flush();return {sent,pending:pending(),state:pending()?'pending':'synced'};
  } finally {
    db.prepare('UPDATE identity SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND lease_owner=?').run(owner);db.close();
  }
}
