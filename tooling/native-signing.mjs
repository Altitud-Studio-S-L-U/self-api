import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {lstat,mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const unsigned={kind:'none',verified:false,publisher:null};

/** Publisher certificates remain operator-provisioned. Configuration alone
 * never establishes a signature; only the platform verifier can do so. */
export async function nativeSigningReceipt(executable,{platform=process.platform,env=process.env,execute=run,bundleDirectory,stagingDirectory,additionalExecutables=[]}={}) {
  if(platform==='linux')return{kind:'not-required',verified:false,publisher:null};
  if(platform==='win32') {
    const certificate=env.SELF_MANAGED_API_WINDOWS_SIGN_CERT_SHA1;
    if(env.SELF_MANAGED_API_REQUIRE_NATIVE_SIGNING==='1'&&!certificate)throw new Error('Windows publisher signing is required but not configured.');
    if(certificate!==undefined) {
      const tool=env.SELF_MANAGED_API_SIGNTOOL_PATH,timestamp=env.SELF_MANAGED_API_WINDOWS_TIMESTAMP_URL;
      if(!/^[a-fA-F0-9]{40}$/u.test(certificate) || !tool || !isAbsolute(tool) || !timestamp)throw new Error('Incomplete Windows signing configuration.');
      const url=new URL(timestamp);
      if(url.protocol!=='https:' || url.username || url.password || url.hash || !env.SELF_MANAGED_API_WINDOWS_PUBLISHER)throw new Error('Invalid Windows signing configuration.');
      const info=await lstat(tool);if(!info.isFile() || info.isSymbolicLink())throw new Error('Invalid SignTool path.');
      await execute(tool,['sign','/sha1',certificate,'/fd','SHA256','/tr',timestamp,'/td','SHA256',executable],{windowsHide:true,timeout:120000,maxBuffer:8192});
    }
    const script="$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath $env:SELF_MANAGED_API_NATIVE_EXECUTABLE;@{status=[string]$s.Status;publisher=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null};thumbprint=if($s.SignerCertificate){$s.SignerCertificate.Thumbprint}else{$null}}|ConvertTo-Json -Compress";
    const verificationEnvironment={...env,SELF_MANAGED_API_NATIVE_EXECUTABLE:executable};
    // Windows PowerShell 5 must discover its own built-in Security module;
    // inheriting PowerShell 7's module path can select an incompatible assembly.
    for(const key of Object.keys(verificationEnvironment))if(key.toLowerCase()==='psmodulepath')delete verificationEnvironment[key];
    const result=await execute(join(env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:verificationEnvironment,windowsHide:true,timeout:30000,maxBuffer:8192});
    const receipt=JSON.parse(result.stdout);
    const verified=receipt.status==='Valid' && typeof env.SELF_MANAGED_API_WINDOWS_PUBLISHER==='string' && receipt.publisher===env.SELF_MANAGED_API_WINDOWS_PUBLISHER
      && (!certificate || receipt.thumbprint?.toLowerCase()===certificate.toLowerCase());
    if(certificate && !verified)throw new Error('Windows publisher verification failed.');
    return verified?{kind:'authenticode',verified:true,publisher:receipt.publisher}:unsigned;
  }
  if(platform==='darwin') {
    const identity=env.SELF_MANAGED_API_APPLE_SIGN_IDENTITY,profile=env.SELF_MANAGED_API_APPLE_NOTARY_PROFILE;
    if(env.SELF_MANAGED_API_REQUIRE_NATIVE_SIGNING==='1'&&(!identity||!profile))throw new Error('macOS publisher signing and notarization are required but not configured.');
    if(identity!==undefined || profile!==undefined) {
      if(typeof identity!=='string' || !/^[a-fA-F0-9]{40}$/u.test(identity) || typeof profile!=='string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(profile)
        || !/^Developer ID Application: [^\r\n]{1,180} \([A-Z0-9]{10}\)$/u.test(env.SELF_MANAGED_API_APPLE_PUBLISHER??'')
        || !bundleDirectory || !stagingDirectory || !isAbsolute(bundleDirectory) || !isAbsolute(stagingDirectory))throw new Error('Incomplete macOS signing configuration.');
      const executables=[executable,...additionalExecutables];
      if(executables.length>8 || new Set(executables.map(file=>resolve(file))).size!==executables.length)throw new Error('Invalid macOS signing files.');
      for(const directory of [bundleDirectory,stagingDirectory]){const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid macOS signing directory.');}
      for(const file of executables){
        const local=relative(bundleDirectory,file),info=await lstat(file);
        if(!local || local==='..' || local.startsWith('..'+sep) || isAbsolute(local) || !info.isFile() || info.isSymbolicLink() || info.nlink!==1)throw new Error('Invalid macOS signing files.');
        const args=['--force','--options','runtime','--timestamp','--sign',identity];
        if(file===executable)args.push('--entitlements',fileURLToPath(new URL('./macos-entitlements.plist',import.meta.url)));
        args.push(file);await execute('/usr/bin/codesign',args,{timeout:120000,maxBuffer:8192});
        await execute('/usr/bin/codesign',['--verify','--strict','--verbose=2',file],{timeout:30000,maxBuffer:8192});
        const detail=await execute('/usr/bin/codesign',['--display','--verbose=4',file],{timeout:30000,maxBuffer:8192});
        if(!(detail.stderr??'').split('\n').includes(`Authority=${env.SELF_MANAGED_API_APPLE_PUBLISHER}`))throw new Error('macOS publisher verification failed.');
      }
      const directory=join(stagingDirectory,`notarization-${randomUUID()}`);await mkdir(directory,{mode:0o700});
      const archive=join(directory,'submission.zip'),log=join(directory,'notary-log.json');
      await execute('/usr/bin/ditto',['-c','-k','--keepParent',bundleDirectory,archive],{timeout:120000,maxBuffer:8192});
      // One bounded submit/wait, using a pre-provisioned Keychain profile. No password enters argv or release artifacts.
      const submission=await execute('/usr/bin/xcrun',['notarytool','submit',archive,'--keychain-profile',profile,'--wait','--timeout','12m','--output-format','json'],{timeout:780000,maxBuffer:8192});
      let value;try{value=JSON.parse(submission.stdout);}catch{throw new Error('Invalid macOS notarization result.');}
      if(value.status!=='Accepted'||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value.id??'')))throw new Error('macOS notarization was not accepted.');
      await execute('/usr/bin/xcrun',['notarytool','log',value.id,'--keychain-profile',profile,log],{timeout:30000,maxBuffer:8192});
      const info=await lstat(log);if(!info.isFile()||info.isSymbolicLink()||info.size>512000)throw new Error('Invalid macOS notarization log.');
      const result=JSON.parse(await readFile(log,'utf8'));
      if(result.status!=='Accepted'||(result.issues??[]).some(issue=>issue.severity==='error'))throw new Error('macOS notarization log rejected.');
      // Apple cannot staple standalone executables or ZIPs. Gatekeeper obtains their accepted tickets online.
    }
    if(!env.SELF_MANAGED_API_APPLE_PUBLISHER)return unsigned;
    await execute('/usr/bin/codesign',['--verify','--strict','--verbose=2',executable],{timeout:30000,maxBuffer:8192});
    const detail=await execute('/usr/bin/codesign',['--display','--verbose=4',executable],{timeout:30000,maxBuffer:8192});
    const publisher=(detail.stderr??'').split('\n').find(line=>line.startsWith('Authority='))?.slice('Authority='.length);
    const assessment=await execute('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',executable],{timeout:30000,maxBuffer:8192});
    if(publisher!==env.SELF_MANAGED_API_APPLE_PUBLISHER || !(assessment.stderr??'').includes('source=Notarized Developer ID'))throw new Error('macOS notarized publisher verification failed.');
    for(const file of additionalExecutables){
      const assessment=await execute('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',file],{timeout:30000,maxBuffer:8192});
      if(!(assessment.stderr??'').includes('source=Notarized Developer ID'))throw new Error('macOS notarized engine verification failed.');
    }
    return{kind:'developer-id-notarized',verified:true,publisher};
  }
  throw new Error('Unsupported native signing platform.');
}
