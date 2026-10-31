import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeSigningReceipt} from '../tooling/native-signing.mjs';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
test('Linux signing requires TUF while unconfigured macOS never claims notarization',async()=>{
  assert.deepEqual(await nativeSigningReceipt('/synthetic/unused',{platform:'linux',env:{}}),{kind:'not-required',verified:false,publisher:null});
  assert.deepEqual(await nativeSigningReceipt('/synthetic/unused',{platform:'darwin',env:{}}),{kind:'none',verified:false,publisher:null});
});
test('macOS configured flow signs both executables, requires Accepted notary log and exact OS verification',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'self-managed-api-native-notary-test-')));t.after(()=>rm(directory,{recursive:true}));
  const bundle=join(directory,'bundle'),staging=join(directory,'staging');await mkdir(bundle);await mkdir(staging);
  const executable=join(bundle,'self-managed-api'),engine=join(bundle,'oasdiff');await writeFile(executable,'Synthetic inert executable');await writeFile(engine,'Synthetic inert engine');
  const calls=[],publisher='Developer ID Application: Synthetic Fixture (ABCDEFGHIJ)',submissionId=randomUUID();
  const execute=async(command,args)=>{
    calls.push({command,args});
    if(args.includes('log'))await writeFile(args.at(-1),JSON.stringify({status:'Accepted',issues:[]}));
    return {stdout:args.includes('submit')?JSON.stringify({status:'Accepted',id:submissionId}):'',
      stderr:command.endsWith('codesign')?`Authority=${publisher}\n`:command.endsWith('spctl')?'source=Notarized Developer ID':''};
  };
  const env={SELF_MANAGED_API_APPLE_PUBLISHER:publisher,SELF_MANAGED_API_APPLE_SIGN_IDENTITY:'a'.repeat(40),SELF_MANAGED_API_APPLE_NOTARY_PROFILE:'synthetic-profile'};
  assert.deepEqual(await nativeSigningReceipt(executable,{platform:'darwin',env,execute,bundleDirectory:bundle,stagingDirectory:staging,additionalExecutables:[engine]}),{kind:'developer-id-notarized',verified:true,publisher});
  const signed=calls.filter(value=>value.args.includes('--sign'));assert.equal(signed.length,2);assert.ok(signed.every(value=>value.args.includes('runtime')&&value.args.includes('--timestamp')));
  assert.equal(signed[0].args.includes('--entitlements'),true);assert.equal(signed[1].args.includes('--entitlements'),false);
  assert.equal(calls.filter(value=>value.args.includes('submit')).length,1);assert.equal(calls.filter(value=>value.args.includes('log')).length,1);
  assert.equal(calls.some(value=>value.args.includes('stapler')),false);assert.equal(calls.some(value=>value.args.includes('--password')),false);
  const entitlements=await readFile(new URL('../tooling/macos-entitlements.plist',import.meta.url),'utf8');assert.match(entitlements,/allow-jit/u);assert.doesNotMatch(entitlements,/get-task-allow|allow-dyld-environment-variables|disable-library-validation/u);
  await assert.rejects(nativeSigningReceipt(executable,{platform:'darwin',env,execute:async(command,args)=>args.includes('submit')?{stdout:JSON.stringify({status:'Invalid',id:submissionId})}:execute(command,args),bundleDirectory:bundle,stagingDirectory:staging,additionalExecutables:[engine]}),/not accepted/u);
});
test('partial macOS signing configuration cannot invoke signing or notarization',async()=>{
  let calls=0;const execute=async()=>{calls++;return {};};
  await assert.rejects(nativeSigningReceipt('/synthetic/unused',{platform:'darwin',env:{SELF_MANAGED_API_APPLE_SIGN_IDENTITY:'a'.repeat(40)},execute}),/Incomplete/u);
  assert.equal(calls,0);
  for(const platform of ['win32','darwin'])await assert.rejects(nativeSigningReceipt('/synthetic/unused',{platform,env:{SELF_MANAGED_API_REQUIRE_NATIVE_SIGNING:'1'},execute}),/required but not configured/u);
  assert.equal(calls,0);
});
test('Windows publisher receipt requires actual verifier status and exact configured certificate subject',async()=>{
  const execute=async()=>({stdout:JSON.stringify({status:'NotSigned',publisher:null,thumbprint:null})});
  assert.equal((await nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{SELF_MANAGED_API_WINDOWS_PUBLISHER:'CN=Synthetic Publisher'},execute})).verified,false);
  const verified=async()=>({stdout:JSON.stringify({status:'Valid',publisher:'CN=Synthetic Publisher',thumbprint:'a'.repeat(40)})});
  assert.deepEqual(await nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{SELF_MANAGED_API_WINDOWS_PUBLISHER:'CN=Synthetic Publisher'},execute:verified}),{kind:'authenticode',verified:true,publisher:'CN=Synthetic Publisher'});
  assert.equal((await nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{SELF_MANAGED_API_WINDOWS_PUBLISHER:'CN=Other Publisher'},execute:verified})).verified,false);
});
test('partial Windows signing configuration and macOS ad-hoc assessment cannot become publisher receipts',async()=>{
  await assert.rejects(nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{SELF_MANAGED_API_WINDOWS_SIGN_CERT_SHA1:'a'.repeat(40)}}),/Incomplete/u);
  await assert.rejects(nativeSigningReceipt('/synthetic/unused',{platform:'darwin',env:{SELF_MANAGED_API_APPLE_PUBLISHER:'Developer ID Application: Synthetic'},execute:async(command)=>({stderr:command.endsWith('codesign')?'Authority=Developer ID Application: Synthetic\n':'source=Unnotarized Developer ID'})}),/notarized/u);
});

test('Windows verifier does not inherit an incompatible PowerShell module search path',async()=>{
  let verificationEnvironment;
  const execute=async(_command,_args,options)=>{
    verificationEnvironment=options.env;
    return{stdout:JSON.stringify({status:'NotSigned',publisher:null,thumbprint:null})};
  };
  assert.deepEqual(await nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{PSModulePath:'PowerShell-7-only-modules',SystemRoot:'C:\\Windows'},execute}),{kind:'none',verified:false,publisher:null});
  assert.equal(Object.keys(verificationEnvironment).some(key=>key.toLowerCase()==='psmodulepath'),false);
  assert.equal(verificationEnvironment.SELF_MANAGED_API_NATIVE_EXECUTABLE,'/synthetic/unused');
});
