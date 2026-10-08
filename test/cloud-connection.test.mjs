import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { join,relative,isAbsolute,resolve } from 'node:path';
import { importJWK,jwtVerify,calculateJwkThumbprint } from 'jose';
import { generateCloudWorkerIdentity,createCloudTransport,syncWorkerToCloud,registerLocalSubscription,observeOnce,listMaintenanceJobs } from 'plumber';
import { deriveCloudIdentifier } from 'plumber/protocol';
import { openWorkerStore } from '../dist/worker-store.js';

const opaque=()=>randomBytes(32).toString('hex');
async function receiver(t,identity) {
  let baseUrl,drop=false,reject=false;const access=opaque(),events=[],proofs=new Set();let tokens=0;
  const server=createServer(async(req,res)=>{
    try {
      const verified=await jwtVerify(req.headers.dpop,await importJWK(identity.publicJwk,'ES256'),{algorithms:['ES256']});
      assert.equal(verified.protectedHeader.typ,'dpop+jwt');assert.equal(verified.protectedHeader.jwk.d,undefined);
      assert.equal(await calculateJwkThumbprint(verified.protectedHeader.jwk),identity.fingerprint);
      assert.equal(verified.payload.htm,'POST');assert.equal(verified.payload.htu,`${baseUrl}${req.url}`);
      assert(!proofs.has(verified.payload.jti));proofs.add(verified.payload.jti);
      const chunks=[];for await(const part of req)chunks.push(part);const raw=Buffer.concat(chunks).toString();
      res.setHeader('content-type','application/json');
      if (req.url==='/api/worker/v1/token') {
        tokens++;assert.equal(verified.payload.ath,undefined);
        const form=new URLSearchParams(raw);assert.equal(form.get('client_id'),identity.installationId);assert.equal(form.get('scope'),'worker:status');
        res.end(JSON.stringify({access_token:access,token_type:'DPoP',expires_in:300,scope:'worker:status'}));return;
      }
      assert.equal(req.headers.authorization,`DPoP ${access}`);assert.equal(verified.payload.ath,createHash('sha256').update(access).digest('base64url'));
      if(reject){res.statusCode=401;res.end('{}');return;}
      const event=JSON.parse(raw),duplicate=events.some(existing=>existing.eventId===event.eventId);events.push(event);
      if(drop){drop=false;res.destroy();return;}
      res.end(JSON.stringify({eventId:event.eventId,sequence:event.sequence,status:duplicate?'duplicate':'accepted'}));
    }catch(error){res.statusCode=500;res.end('{}');server.emit('fixture-error',error);}
  });
  const errors=[];server.on('fixture-error',error=>errors.push(error));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));baseUrl=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);});
  return {baseUrl,events,drop(){drop=true;},revoke(){reject=true;},get tokens(){return tokens;}};
}

test('client signs scoped key-bound requests, caches token, rejects remote HTTP and fails closed on revocation',async t=>{
  const identity=await generateCloudWorkerIdentity(),server=await receiver(t,identity);
  const credentials={...identity,baseUrl:server.baseUrl,projectId:opaque(),clientSecret:opaque(),allowLocalHttp:true};
  assert.throws(()=>createCloudTransport({...credentials,baseUrl:'http://api.example.test'}),{code:'INVALID_CONFIGURATION'});
  assert.throws(()=>createCloudTransport({...credentials,baseUrl:'https://api.example.test/extra'}),{code:'INVALID_CONFIGURATION'});
  const transport=createCloudTransport(credentials),event={schemaVersion:1,eventId:opaque(),installationId:identity.installationId,projectId:credentials.projectId,sequence:0,recordedAt:new Date().toISOString(),body:{type:'runner-status',state:'idle',reason:'none',pendingJobs:0}};
  assert.equal((await transport.send(event)).status,'accepted');assert.equal((await transport.send(event)).status,'duplicate');assert.equal(server.tokens,1);
  await assert.rejects(transport.send({...event,sourceCode:'private'}));assert.equal(server.events.length,2);
  server.revoke();await assert.rejects(transport.send({...event,eventId:opaque(),sequence:1}),{code:'AUTHORIZATION_REJECTED'});
});

test('actual local jobs publish only allowlisted summaries and retry a lost acknowledgement with the same sequence',async t=>{
  const root=resolve(import.meta.dirname,'..'),work=join(root,'work/test-cloud-sync');await mkdir(work,{recursive:true});
  const owned=await mkdtemp(join(work,'case-'));t.after(async()=>{const path=relative(work,owned);assert(!isAbsolute(path)&&path.startsWith('case-')&&!path.includes('..'));await rm(owned,{recursive:true,force:true});});
  const consumer=join(owned,'consumer');await mkdir(consumer);await writeFile(join(consumer,'orders.ts'),await readFile(join(root,'fixtures/consumer/orders.ts')));
  const provider=join(owned,'provider.json');await writeFile(provider,await readFile(join(root,'fixtures/orders-v1.json')));
  const statePath=join(owned,'state'),cloudStatePath=join(owned,'cloud');
  const local={statePath,consumerRoot:consumer,sourcePath:provider,baselinePath:provider,providerBaseUrl:'https://orders.example.invalid',label:'Private company label',enginePath:join(root,'work/tools/oasdiff',process.platform==='win32'?'oasdiff.exe':'oasdiff')};
  const subscription=await registerLocalSubscription(local);await writeFile(provider,await readFile(join(root,'fixtures/orders-v2.json')));await observeOnce(local);
  const identity=await generateCloudWorkerIdentity(),server=await receiver(t,identity),credentials={...identity,baseUrl:server.baseUrl,projectId:opaque(),clientSecret:opaque(),allowLocalHttp:true};
  const options={statePath,cloudStatePath,credentials,integrationIds:[subscription.id]};server.drop();
  await assert.rejects(syncWorkerToCloud(options),{code:'NETWORK_UNAVAILABLE'});
  assert.equal(server.events.length,1);const first=server.events[0];
  const result=await syncWorkerToCloud(options);assert.equal(result.state,'synced');assert.equal(result.pending,0);
  assert.deepEqual(server.events[1],first);assert.equal(first.sequence,0);assert.equal(first.body.state,'decision-required');
  assert.equal(first.recordedAt,(await listMaintenanceJobs({statePath}))[0].createdAt,'Connecting later must not invent a newer local job timestamp.');
  const unique=[...new Map(server.events.map(event=>[event.eventId,event])).values()];assert.deepEqual(unique.map(event=>event.sequence),[0,1,2]);
  const sent=JSON.stringify(server.events);for(const forbidden of ['Private company label','orders.ts','orders.example.invalid','sourcePath','consumerRoot','report','diff','prompt']) assert(!sent.includes(forbidden));
  await assert.rejects(syncWorkerToCloud({...options,integrationIds:[]}),{code:'INVALID_INPUT'});
  await assert.rejects(syncWorkerToCloud({...options,cloudStatePath:join(consumer,'cloud')}),{code:'INVALID_INPUT'});
  await assert.rejects(syncWorkerToCloud({...options,credentials:{...credentials,installationId:opaque()}}),{code:'INVALID_INPUT'});
});

test('a full 1000-job worker makes bounded progress and eventually reports every job exactly once',async t=>{
  const work=resolve('work/test-cloud-capacity');await mkdir(work,{recursive:true});
  const owned=await mkdtemp(join(work,'case-'));
  t.after(async()=>{const path=relative(work,owned);assert(!isAbsolute(path)&&path.startsWith('case-')&&!path.includes('..'));await rm(owned,{recursive:true,force:true});});
  const statePath=join(owned,'worker'),cloudStatePath=join(owned,'cloud'),consumerRoot=join(owned,'consumer');await mkdir(consumerRoot);
  const snapshot=version=>{
    const bytes=Buffer.from(JSON.stringify({openapi:'3.0.3',info:{title:'Controlled outbox capacity fixture',version},paths:{}}));
    return {bytes,metadata:{sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,specificationVersion:'3.0.3',apiVersion:version}};
  };
  const baseline=snapshot('A'),revision=snapshot('B'),subscriptionId=opaque(),jobIds=[];
  const store=await openWorkerStore(statePath);
  try{
    store.register({id:subscriptionId,label:'Controlled outbox capacity fixture',sourcePath:join(owned,'provider.json'),consumerRoot,providerBaseUrl:'https://orders.example.invalid',baseline});
      const report={schemaVersion:1,comparison:{schemaVersion:1,engine:{name:'oasdiff',version:'1.33.0'},base:baseline.metadata,revision:revision.metadata,
        contentChanged:true,status:'no-breaking-changes',changes:[],coverage:'structural-contract-only',consumerImpact:'not-analyzed'},
        inventory:{schemaVersion:1,digest:createHash('sha256').update('controlled-consumer-0').digest('hex'),files:[],calls:[],imports:[],issues:[],skipped:[],packages:[],validationCandidates:[],coverage:'bounded-native-fetch-syntax',codeExecuted:false},
        provider:{origin:'https://orders.example.invalid',basePath:''},matches:[],unmappedChangeIndexes:[],unresolvedCallIds:[],conclusion:'review-required',coverage:'potential-operation-impact'};
      const lease=store.claim(subscriptionId);assert(lease);
      const result=store.completeObservation({lease,snapshot:revision,report});assert.equal(result.created,true);jobIds.push(result.job.id);
  }finally{store.close();}
  // Capacity is the boundary under test. Expand this owned, valid seed in one
  // fixture transaction instead of spending 2,000 fsyncs on observation leases.
  const {DatabaseSync}=await import('node:sqlite');
  const fixtureDb=new DatabaseSync(join(statePath,'worker.sqlite3'));
  try{
    const seed=fixtureDb.prepare('SELECT * FROM jobs WHERE id=?').get(jobIds[0]);
    fixtureDb.exec('BEGIN IMMEDIATE');
    for(let index=1;index<1000;index++){
      const report=JSON.parse(seed.report_json),digest=createHash('sha256').update(`controlled-consumer-${index}`).digest('hex');
      report.inventory.digest=digest;
      const id=createHash('sha256').update(JSON.stringify([subscriptionId,seed.baseline_sha,seed.revision_sha,digest,seed.engine_version])).digest('hex');
      fixtureDb.prepare('INSERT INTO jobs SELECT ?,subscription_id,baseline_sha,revision_sha,?,engine_version,?,created_at FROM jobs WHERE id=?').run(id,digest,JSON.stringify(report),jobIds[0]);jobIds.push(id);
    }
    fixtureDb.exec('COMMIT');
  }finally{fixtureDb.close();}
  assert.equal((await listMaintenanceJobs({statePath})).length,1000);
  const identity=await generateCloudWorkerIdentity(),server=await receiver(t,identity);
  const credentials={...identity,baseUrl:server.baseUrl,projectId:opaque(),clientSecret:opaque(),allowLocalHttp:true};
  const options={statePath,cloudStatePath,credentials,integrationIds:[subscriptionId]};
  let result=await syncWorkerToCloud(options);
  assert.equal(result.sent,50);assert.equal(result.state,'pending');assert(result.pending>0&&result.pending<=1000);
  for(let batch=0;batch<25&&result.state!=='synced';batch++){
    const previous=server.events.length;result=await syncWorkerToCloud(options);
    assert(result.sent>0&&result.sent<=50);assert.equal(server.events.length-previous,result.sent);assert(result.pending<=1000);
  }
  assert.equal(result.state,'synced');assert.equal(result.pending,0);
  const maintenance=server.events.filter(event=>event.body.type==='maintenance-status');
  assert.equal(maintenance.length,1000);assert.equal(new Set(maintenance.map(event=>event.body.jobId)).size,1000);
  assert.deepEqual(new Set(maintenance.map(event=>event.body.jobId)),new Set(jobIds.map(id=>deriveCloudIdentifier(id,identity.installationId))));
  assert.deepEqual(server.events.map(event=>event.sequence),server.events.map((_,index)=>index));
  assert.equal(server.events.at(-1).body.type,'runner-status');assert.equal(server.events.at(-1).body.pendingJobs,1000);
  const previous=maintenance.length;await syncWorkerToCloud(options);
  assert.equal(server.events.filter(event=>event.body.type==='maintenance-status').length,previous,'Unchanged jobs must not be reported again after the final batch.');
});
