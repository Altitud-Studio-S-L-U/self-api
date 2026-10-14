import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServiceFixture } from '../tooling/service-fixture.mjs';
import { createLicenseFixture } from '../tooling/license-fixture.mjs';
import { runWorkerService, normalizeWorkerServiceConfig, CloudConnectionError, WorkerLicenseStore } from '../dist/index.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';
import { generateCloudWorkerIdentity } from '../dist/cloud-connection.js';
import { verifyWorkerLicense } from '../dist/worker-license.js';

async function fixture(t) {
  const parent=resolve('work/test-worker-service-license');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(await realpath(parent),'case-'));checkWindowsPermissions([directory],true,directory);
  let running, controller=new AbortController();
  t.after(async()=>{controller.abort();await running?.catch(()=>{});await rm(directory,{recursive:true});});
  const original=await createServiceFixture(directory),config=JSON.parse(await readFile(original.configPath,'utf8'));
  return {directory,config,controller,setRunning(value){running=value;},status:()=>JSON.parse(readFileSync(join(config.statePath,'worker-service.status.json'),'utf8'))};
}
function controlGate(signal) {
  const gate=Promise.withResolvers();
  const release=()=>{signal.removeEventListener('abort',release);gate.resolve();};
  // A cancelled fixture must release its mock transport before teardown drains the daemon.
  if(signal.aborted)release();else signal.addEventListener('abort',release,{once:true});
  return {promise:gate.promise,resolve:release};
}

test('an already cancelled control fixture starts released',async()=>{
  const controller=new AbortController();controller.abort();
  const gate=controlGate(controller.signal);let released=false;
  gate.promise.then(()=>{released=true;});await Promise.resolve();
  assert.equal(released,true);
});

test('cancellation before observation releases the pending control fixture and drains the daemon',{timeout:60000},async t=>{
  const f=await fixture(t),ready=controlGate(f.controller.signal),entered=Promise.withResolvers();
  const token=JSON.parse(await readFile(f.config.license.leasePath,'utf8'));
  let observations=0,polls=0,released=false;
  ready.promise.then(()=>{released=true;});
  const running=runWorkerService(f.config,{signal:f.controller.signal,dependencies:{
    control:{async poll(){polls++;entered.resolve();f.controller.abort();await ready.promise;return{schemaVersion:1,license:token,pollAfterMs:60000};}},
    async observeSources(){observations++;return{schemaVersion:1,results:[]};},
    async wait(){throw new Error('Cancelled startup must not schedule another wait.');},
  }});f.setRunning(running);
  try {
    await entered.promise;await new Promise(setImmediate);
    assert.equal(released,true,'Cancellation must release the pending control fixture before teardown.');
    const status=await running;
    assert.equal(status.state,'stopped');assert.equal(polls,1);assert.equal(observations,0);
  } finally {ready.resolve();await running.catch(()=>{});}
});
test('automatic daemon without a license stays alive but never invokes any observer',{timeout:60000},async t=>{
  const f=await fixture(t),{license:_license,...input}=f.config;
  let calls=0;
  const running=runWorkerService(input,{signal:f.controller.signal,dependencies:{
    observeSources:async()=>{calls++;throw new Error('Unlicensed work must not run');},
    wait:async()=>{f.controller.abort();},
  }});f.setRunning(running);
  const status=await running;assert.equal(status.automation,'paused');assert.equal(status.licenseReason,'missing');
  assert.equal(status.cycles,0);assert.equal(calls,0);assert.equal(status.state,'stopped');
});
test('signed commercial pause cancels only owned observation, retains evidence and acknowledges paused before a signed resume',{timeout:60000},async t=>{
  const f=await fixture(t),lease=await createLicenseFixture(f.directory),denial=await lease.sign({decision:'suspended',revision:2}),resumption=await lease.sign({revision:3});
  const original=await readFile(join(f.directory,'source.json'));
  let polls=0,observations=0,aborted=false,sawPaused=false,resumed=false;
  const receipts=[],ready=controlGate(f.controller.signal);
  const running=runWorkerService(normalizeWorkerServiceConfig({...f.config,license:lease.license}),{signal:f.controller.signal,dependencies:{
    control:{async poll(input){receipts.push(input);polls++;if(polls===1){await ready.promise;return{schemaVersion:1,license:denial,pollAfterMs:60000};}
      // Resume is requested only after Cloud observes this completed pause;
      // an immediate draining ACK can precede the canceled observer's return.
      if(input.automation==='paused'&&input.observedRevision===2)resumed=true;
      return{schemaVersion:1,license:resumed?resumption:denial,pollAfterMs:60000};}},
    async observeSources(options){observations++;
      if(observations===1){ready.resolve();await new Promise(resolve=>options.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));}
      if(observations===2)f.controller.abort();
      return{schemaVersion:1,results:[]};
    },
    async wait(ms,signal){
      const current=f.status();
      if(current.licenseReason==='suspended' && current.automation==='paused')sawPaused=true;
      // Yield to native crypto completion as well as the other serial loop.
      // Returning an already resolved promise here would starve Node timers.
      if(signal.aborted)return;
      await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});setTimeout(resolve,5);});
    },
  }});f.setRunning(running);
  const result=await running;assert.equal(aborted,true);assert.equal(sawPaused,true);assert.equal(observations,2);
  assert(receipts.some(input=>input.automation==='paused' && input.observedRevision===2));
  assert.equal(result.licenseReason,'allowed');assert.equal(result.automation,'active');
  assert.deepEqual(await readFile(join(f.directory,'source.json')),original,'Customer API/source bytes remain untouched.');
});
test('a signed resume during drain preserves serialized observation and never invents a completed-pause acknowledgement',{timeout:60000},async t=>{
  const f=await fixture(t),lease=await createLicenseFixture(f.directory),denial=await lease.sign({decision:'suspended',revision:2}),resumption=await lease.sign({revision:3});
  const original=await readFile(join(f.directory,'source.json'));
  const ready=controlGate(f.controller.signal),cleanup=controlGate(f.controller.signal);
  const receipts=[];let polls=0,observations=0,active=0,maximumActive=0,aborted=false,cleanedUp=false,resumedDuringDrain=false;
  const running=runWorkerService(normalizeWorkerServiceConfig({...f.config,license:lease.license}),{signal:f.controller.signal,dependencies:{
    control:{async poll(input){
      receipts.push(input);polls++;
      if(polls===1){await ready.promise;return{schemaVersion:1,license:denial,pollAfterMs:60000};}
      if(polls>=3){resumedDuringDrain ||= input.observedRevision===3&&observations===1&&!cleanedUp;cleanup.resolve();}
      return{schemaVersion:1,license:resumption,pollAfterMs:60000};
    }},
    async observeSources(options){
      observations++;active++;maximumActive=Math.max(maximumActive,active);
      try {
        if(observations===1){
          ready.resolve();
          await new Promise(resolve=>options.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
          await cleanup.promise;cleanedUp=true;
        } else f.controller.abort();
        return{schemaVersion:1,results:[]};
      } finally {active--;}
    },
    async wait(_ms,signal){if(signal.aborted)return;await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});setTimeout(resolve,5);});},
  }});f.setRunning(running);
  let result;
  try {result=await running;} finally {cleanup.resolve();}
  assert.equal(aborted,true);assert.equal(resumedDuringDrain,true);assert.equal(observations,2);assert.equal(maximumActive,1);
  assert(receipts.some(input=>input.automation==='draining'&&input.observedRevision===2));
  assert.equal(receipts.some(input=>input.automation==='paused'&&input.observedRevision===2),false,'Cloud must not receive a completed pause that did not happen.');
  assert.equal(result.licenseReason,'allowed');assert.equal(result.automation,'active');
  assert.deepEqual(await readFile(join(f.directory,'source.json')),original,'Customer API/source bytes remain untouched.');
});

test('a control 401 pauses licensed automation immediately and cannot fall back to its offline lease',{timeout:60000},async t=>{
  const f=await fixture(t);let observations=0;
  const running=runWorkerService(f.config,{signal:f.controller.signal,dependencies:{
    control:{async poll(){throw new CloudConnectionError('AUTHORIZATION_REJECTED');}},
    async observeSources(options){observations++;if(!options.signal.aborted)await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));return{schemaVersion:1,results:[]};},
    async wait(){if(f.status().licenseReason==='revoked')f.controller.abort();},
  }});f.setRunning(running);
  const status=await running;assert.equal(status.licenseReason,'revoked');assert.equal(status.automation,'paused');assert(observations<=1);
});

test('offline restart retains a newer persisted lease instead of importing stale bootstrap bytes',{timeout:60000},async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-12T12:00:00Z')});
  const f=await fixture(t),lease=await createLicenseFixture(f.directory);
  const store=await WorkerLicenseStore.open(f.config.statePath,lease.credentials,lease.trust);
  try {
    await store.apply(lease.token);
    t.mock.timers.tick(60000);
    await store.apply(await lease.sign(),Date.now(),'authenticated-control');
  } finally { store.close(); }
  const bootstrap=await readFile(lease.license.leasePath);
  let observations=0;
  const running=runWorkerService({...f.config,license:lease.license},{signal:f.controller.signal,dependencies:{
    control:{async poll(){throw new CloudConnectionError('NETWORK_UNAVAILABLE');}},
    async observeSources(){observations++;f.controller.abort();return{schemaVersion:1,results:[]};},
    async wait(){if(f.status().automation==='paused')f.controller.abort();},
  }});f.setRunning(running);
  const status=await running;
  assert.equal(observations,1);assert.equal(status.licenseReason,'allowed');assert.equal(status.automation,'active');
  assert.deepEqual(await readFile(lease.license.leasePath),bootstrap,'Bootstrap bytes cannot overwrite renewed authorization.');
});

test('a real HTTP 503 during offline restart preserves the signed lease and continues permitted observation',{timeout:60000},async t=>{
  const f=await fixture(t);let requests=0;
  const server=createServer(async(request,response)=>{for await(const _chunk of request){}requests++;response.writeHead(503);response.end();});
  await new Promise(accept=>server.listen(0,'127.0.0.1',accept));
  t.after(async()=>{server.closeAllConnections();await new Promise(accept=>server.close(accept));});
  const identity=await generateCloudWorkerIdentity();
  const lease=await createLicenseFixture(f.directory,{credentials:{...identity,baseUrl:`http://127.0.0.1:${server.address().port}`,
    projectId:'b'.repeat(64),clientSecret:'c'.repeat(64),allowLocalHttp:true}});
  const store=await WorkerLicenseStore.open(f.config.statePath,lease.credentials,lease.trust);
  try{await store.apply(lease.token);}finally{store.close();}
  const originalClaims=await verifyWorkerLicense(lease.token,lease.trust,lease.credentials);
  let previousClock=0,previousRunId;
  for(let restart=0;restart<2;restart++){
    const controller=new AbortController();t.after(()=>controller.abort());
    let controlHandled=false,observations=0;
    const running=runWorkerService({...f.config,license:{credentialsPath:lease.license.credentialsPath,trustPath:lease.license.trustPath}},
      {signal:controller.signal,dependencies:{
        async observeSources(){observations++;if(controlHandled&&observations>=2)controller.abort();return{schemaVersion:1,results:[]};},
        async wait(ms,signal){
          if(ms>30_000){controlHandled=true;if(f.status().automation!=='active'||observations>=2)controller.abort();}
          await delay(ms,undefined,{signal});
        },
      }});f.setRunning(running);
    const status=await running;
    assert.equal(controlHandled,true);assert.equal(observations,2);assert.equal(status.automation,'active');assert.equal(status.licenseReason,'allowed');
    assert.notEqual(status.runId,previousRunId);previousRunId=status.runId;
    const database=new DatabaseSync(join(f.config.statePath,'worker-license.sqlite3'),{readOnly:true,allowExtension:false});
    try{
      const persisted=database.prepare('SELECT token,revision,issued,clock,revoked FROM license WHERE id=1').get();
      assert.equal(persisted.token,lease.token);assert.equal(persisted.revoked,0);assert(persisted.clock>=previousClock);previousClock=persisted.clock;
      const claims=await verifyWorkerLicense(persisted.token,lease.trust,lease.credentials);
      assert.equal(claims.iat,originalClaims.iat);assert.equal(claims.exp,originalClaims.exp);assert.equal(claims.entitlementExpiresAt,originalClaims.entitlementExpiresAt);
    }finally{database.close();}
  }
  assert.equal(requests,2,'One failing initial token request per restart; no extra retry is hidden in the transport.');
});
