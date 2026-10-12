import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,join} from 'node:path';
import {lstat} from 'node:fs/promises';
const run=promisify(execFile);
const unsigned={kind:'none',verified:false,publisher:null};

/** Publisher certificates remain operator-provisioned. Configuration alone
 * never establishes a signature; only the platform verifier can do so. */
export async function nativeSigningReceipt(executable,{platform=process.platform,env=process.env,execute=run}={}) {
  if(platform==='linux')return{kind:'not-required',verified:false,publisher:null};
  if(platform==='win32') {
    const certificate=env.KEEPSEAM_WINDOWS_SIGN_CERT_SHA1;
    if(certificate!==undefined) {
      const tool=env.KEEPSEAM_SIGNTOOL_PATH,timestamp=env.KEEPSEAM_WINDOWS_TIMESTAMP_URL;
      if(!/^[a-fA-F0-9]{40}$/u.test(certificate) || !tool || !isAbsolute(tool) || !timestamp)throw new Error('Incomplete Windows signing configuration.');
      const url=new URL(timestamp);
      if(url.protocol!=='https:' || url.username || url.password || url.hash || !env.KEEPSEAM_WINDOWS_PUBLISHER)throw new Error('Invalid Windows signing configuration.');
      const info=await lstat(tool);if(!info.isFile() || info.isSymbolicLink())throw new Error('Invalid SignTool path.');
      await execute(tool,['sign','/sha1',certificate,'/fd','SHA256','/tr',timestamp,'/td','SHA256',executable],{windowsHide:true,timeout:120000,maxBuffer:8192});
    }
    const script="$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath $env:KEEPSEAM_NATIVE_EXECUTABLE;@{status=[string]$s.Status;publisher=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null};thumbprint=if($s.SignerCertificate){$s.SignerCertificate.Thumbprint}else{$null}}|ConvertTo-Json -Compress";
    const result=await execute(join(env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...env,KEEPSEAM_NATIVE_EXECUTABLE:executable},windowsHide:true,timeout:30000,maxBuffer:8192});
    const receipt=JSON.parse(result.stdout);
    const verified=receipt.status==='Valid' && typeof env.KEEPSEAM_WINDOWS_PUBLISHER==='string' && receipt.publisher===env.KEEPSEAM_WINDOWS_PUBLISHER
      && (!certificate || receipt.thumbprint?.toLowerCase()===certificate.toLowerCase());
    if(certificate && !verified)throw new Error('Windows publisher verification failed.');
    return verified?{kind:'authenticode',verified:true,publisher:receipt.publisher}:unsigned;
  }
  if(platform==='darwin') {
    if(!env.KEEPSEAM_APPLE_PUBLISHER)return unsigned;
    await execute('/usr/bin/codesign',['--verify','--strict','--verbose=2',executable],{timeout:30000,maxBuffer:8192});
    const detail=await execute('/usr/bin/codesign',['--display','--verbose=4',executable],{timeout:30000,maxBuffer:8192});
    const publisher=(detail.stderr??'').split('\n').find(line=>line.startsWith('Authority='))?.slice('Authority='.length);
    const assessment=await execute('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',executable],{timeout:30000,maxBuffer:8192});
    if(publisher!==env.KEEPSEAM_APPLE_PUBLISHER || !(assessment.stderr??'').includes('source=Notarized Developer ID'))throw new Error('macOS notarized publisher verification failed.');
    return{kind:'developer-id-notarized',verified:true,publisher};
  }
  throw new Error('Unsupported native signing platform.');
}
