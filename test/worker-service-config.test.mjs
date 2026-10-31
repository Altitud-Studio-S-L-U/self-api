import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeWorkerServiceConfig, renderWorkerServiceManifest } from '../dist/index.js';

const config = { schemaVersion: 1, statePath: '/var/lib/managedapi', openApi: { enginePath: '/opt/managedapi/oasdiff' }, sources: {} };
const windows = { schemaVersion: 1, statePath: 'C:\\Self-managed API state', sources: {} };
const render = overrides => renderWorkerServiceManifest({ config, configPath: '/etc/managedapi/worker.json', target: 'systemd', nodePath: '/usr/bin/node', cliPath: '/opt/managedapi/cli.js', user: 'managedapi', ...overrides });

test('service configuration is explicit, strict and immutable with separate observation intervals', () => {
  const result = normalizeWorkerServiceConfig(config, 'systemd');
  assert.equal(result.allowHttp, false);
  assert.equal(result.openApi.intervalMs, 60000);
  assert.equal(result.sources.intervalMs, 900000);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.openApi));
  assert.throws(() => { result.openApi.intervalMs = 1; });
  for (const invalid of [{ ...config, schemaVersion: 2 }, { ...config, execute: true }, { ...config, allowHttp: 'true' },
    { ...config, sources: { intervalMs: null } }, { ...config, sources: { intervalMs: 999 } },
    { ...config, sources: { intervalMs: 3600001 } }, { ...config, sources: { command: 'run tests' } },
    { schemaVersion: 1, statePath: '/state' }]) assert.throws(() => normalizeWorkerServiceConfig(invalid, 'systemd'));
});

test('standalone service rejects retired remote settings without inspecting them', () => {
  for (const field of ['cloud', 'license']) {
    for (const value of [undefined, null, {}]) {
      assert.throws(() => normalizeWorkerServiceConfig({ ...config, [field]: value }, 'systemd'), /unknown field/);
    }
    const input = { ...config };
    Object.defineProperty(input, field, { get() { assert.fail('must not inspect retired configuration'); } });
    assert.throws(() => normalizeWorkerServiceConfig(input, 'systemd'), /unknown field or accessor/);
  }
  const accessor = { ...config };
  Object.defineProperty(accessor, 'sources', { get() { assert.fail('must not evaluate configuration accessors'); } });
  assert.throws(() => normalizeWorkerServiceConfig(accessor, 'systemd'), /accessor/);
});

test('literal paths reject traversal, interpolation and special device filenames', () => {
  for (const path of ['relative', '/x/../y', '/x/./y', '/x//y', '/x\ny', '//server/share', '/x\\y', '/x/']) {
    assert.throws(() => normalizeWorkerServiceConfig({ ...config, statePath: path }, 'systemd'));
  }
  for (const path of ['C:state', '\\\\server\\share', 'C:\\state\\..\\other', 'C:\\state%USERNAME%', 'C:\\state\\nul', 'C:\\state\\x:stream', 'C:/state', 'C:\\state\\trailing.']) {
    assert.throws(() => normalizeWorkerServiceConfig({ ...windows, statePath: path }, 'windows'));
  }
});

test('systemd renders literal arguments and restricted observation-only account', () => {
  const content = render({ config: { ...config, statePath: '/var/lib/keep $state%f' }, configPath: '/etc/keep "quoted" $conf%f.json' });
  assert.match(content, /WorkingDirectory=\/var\/lib\/keep \$state%%f\n/);
  assert.match(content, /ExecStart=.*"\/etc\/keep \\"quoted\\" \$\$conf%%f\.json"/);
  assert.match(content, /User=managedapi\n/); assert.match(content, /Restart=on-failure/);
  assert.match(content, /ProtectSystem=strict/); assert.match(content, /TimeoutStopSec=180/);
  assert.doesNotMatch(content, /\/bin\/(?:sh|bash)|run-approved|sudo|curl/);
  for (const overrides of [{ user: 'root' }, { user: 'managedapi\nUser=root' }, { name: 'x\n' }, { target: undefined }]) assert.throws(() => render(overrides));
});

test('systemd user scope inherits a non-root manager identity and keeps home read-only except explicit state', () => {
  const content=render({scope:'user',user:undefined,config:{schemaVersion:1,statePath:'/home/operator/private state%v',sources:{}}});
  assert.doesNotMatch(content,/^User=|^Group=|network-online\.target|multi-user\.target/m);
  assert.match(content,/AssertUser=!root\n/);
  assert.match(content,/PrivateUsers=true\n/);
  assert.match(content,/TemporaryFileSystem=\/tmp:rw,nosuid,nodev,size=64M \/var\/tmp:rw,nosuid,nodev,size=64M\n/);
  assert.match(content,/ProtectHome=read-only\n/);
  assert.match(content,/ProtectSystem=strict\n/);
  assert.match(content,/ReadWritePaths="\/home\/operator\/private state%%v"\n/);
  assert.match(content,/WantedBy=default\.target\n/);
  assert.match(content,/Restart=on-failure\nRestartSec=30\n/);
  assert.match(content,/TimeoutStopSec=180\n/);
});

test('each Linux service bounds its process tree and restarts only its own failed unit', () => {
  for (const scope of ['system', 'user']) {
    const content = render(scope === 'user' ? { scope, user: undefined } : { scope });
    for (const directive of ['KillMode=control-group', 'OOMPolicy=stop', 'CPUQuota=100%',
      'MemoryHigh=384M', 'MemoryMax=512M', 'MemorySwapMax=0', 'TasksMax=128',
      'Restart=on-failure', 'RestartSec=30', 'StartLimitIntervalSec=300', 'StartLimitBurst=5']) {
      assert(content.split('\n').includes(directive), `Missing ${directive} in ${scope} service`);
    }
  }
});

test('service scopes reject unsupported managers and user identity switches instead of silently weakening isolation', () => {
  for (const overrides of [{scope:'root'},{scope:null},{scope:'user',user:'operator'},{scope:'user',target:'launchd'},
    {scope:'system',target:'launchd'},{scope:'user',target:'windows',user:undefined}]) assert.throws(()=>render(overrides));
  assert.equal(render({scope:'system'}),render({}));
});

test('public CLI renders user units explicitly and rejects identity options and scope on runtime commands', async () => {
  const parent=resolve('work/test-service-render');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'scope-'));
  try {
    const localConfig=join(directory,'worker.json');
    await writeFile(localConfig,JSON.stringify({schemaVersion:1,statePath:'/home/operator/state',sources:{}}));
    // A root-relative Windows path is readable on the current drive and can be
    // rendered as a Unix path without executing that foreign-platform service.
    const configPath=process.platform==='win32'?localConfig.slice(2).replaceAll('\\','/'):localConfig;
    const args=['worker-service','render','--config',configPath,'--target','systemd','--scope','user','--node','/usr/bin/node','--cli','/opt/managedapi/cli.js'];
    const invoke=extra=>spawnSync(process.execPath,[resolve('dist/cli.js'),...extra],{encoding:'utf8',windowsHide:true});
    const rendered=invoke(args);assert.equal(rendered.status,0,rendered.stderr);
    assert.match(rendered.stdout,/WantedBy=default\.target/);assert.doesNotMatch(rendered.stdout,/^User=/m);
    for(const user of ['root','operator','']) assert.equal(invoke([...args,'--user',user]).status,2);
    assert.equal(invoke([...args,'--scope','system']).status,2);
    for(const action of ['run','status','stop']) assert.equal(invoke(['worker-service',action,'--config',localConfig,'--scope','user']).status,2);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('launchd XML encodes metacharacters and delegates keep-alive without daemonizing', () => {
  const content = render({ target: 'launchd', configPath: '/etc/keep & "seam".json' });
  assert.match(content, /keep &amp; &quot;seam&quot;\.json/);
  assert.match(content, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(content, /<key>UserName<\/key><string>managedapi<\/string>/);
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(content, /worker-service\.log/);
});

test('Windows manifest uses a passwordless low-privilege SCM account, bounded signal shutdown and wrapper logs', () => {
  const content = render({ target: 'windows', config: windows, configPath: 'C:\\Self-managed API & data\\worker.json',
    cliPath: 'C:\\Program Files\\Self-managed API\\cli.js', nodePath: 'C:\\Program Files\\nodejs\\node.exe', user: undefined });
  assert.match(content, /<domain>NT AUTHORITY<\/domain><user>LocalService<\/user>/);
  assert.match(content, /&quot;C:\\Self-managed API &amp; data\\worker\.json&quot;/);
  assert.match(content, /<arguments>.*&quot;run&quot;/);
  assert.match(content, /<stoptimeout>180 sec<\/stoptimeout>/);
  assert.match(content, /<sizeThreshold>1024<\/sizeThreshold><keepFiles>2<\/keepFiles>/);
  assert.doesNotMatch(content, /<stoparguments>|<password>|<download|LocalSystem|<interactive|cmd\.exe|powershell/);
});
