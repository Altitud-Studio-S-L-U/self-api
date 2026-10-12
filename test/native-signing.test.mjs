import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeSigningReceipt} from '../tooling/native-signing.mjs';
test('Linux signing requires TUF while unconfigured macOS never claims notarization',async()=>{
  assert.deepEqual(await nativeSigningReceipt('/synthetic/unused',{platform:'linux',env:{}}),{kind:'not-required',verified:false,publisher:null});
  assert.deepEqual(await nativeSigningReceipt('/synthetic/unused',{platform:'darwin',env:{}}),{kind:'none',verified:false,publisher:null});
});
test('Windows publisher receipt requires actual verifier status and exact configured certificate subject',async()=>{
  const execute=async()=>({stdout:JSON.stringify({status:'NotSigned',publisher:null,thumbprint:null})});
  assert.equal((await nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{KEEPSEAM_WINDOWS_PUBLISHER:'CN=Synthetic Publisher'},execute})).verified,false);
  const verified=async()=>({stdout:JSON.stringify({status:'Valid',publisher:'CN=Synthetic Publisher',thumbprint:'a'.repeat(40)})});
  assert.deepEqual(await nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{KEEPSEAM_WINDOWS_PUBLISHER:'CN=Synthetic Publisher'},execute:verified}),{kind:'authenticode',verified:true,publisher:'CN=Synthetic Publisher'});
  assert.equal((await nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{KEEPSEAM_WINDOWS_PUBLISHER:'CN=Other Publisher'},execute:verified})).verified,false);
});
test('partial Windows signing configuration and macOS ad-hoc assessment cannot become publisher receipts',async()=>{
  await assert.rejects(nativeSigningReceipt('/synthetic/unused',{platform:'win32',env:{KEEPSEAM_WINDOWS_SIGN_CERT_SHA1:'a'.repeat(40)}}),/Incomplete/u);
  await assert.rejects(nativeSigningReceipt('/synthetic/unused',{platform:'darwin',env:{KEEPSEAM_APPLE_PUBLISHER:'Developer ID Application: Synthetic'},execute:async(command)=>({stderr:command.endsWith('codesign')?'Authority=Developer ID Application: Synthetic\n':'source=Unnotarized Developer ID'})}),/notarized/u);
});
