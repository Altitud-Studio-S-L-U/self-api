import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWorkerServiceConfig, renderWorkerServiceManifest } from '../dist/index.js';

const config = { schemaVersion: 1, statePath: '/var/lib/keepseam', openApi: { enginePath: '/opt/keepseam/oasdiff' }, sources: {} };
const windows = { schemaVersion: 1, statePath: 'C:\\Keepseam state', sources: {} };
const render = overrides => renderWorkerServiceManifest({ config, configPath: '/etc/keepseam/worker.json', target: 'systemd', nodePath: '/usr/bin/node', cliPath: '/opt/keepseam/cli.js', user: 'keepseam', ...overrides });

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

test('cloud sharing remains explicit and contains only file references, never credentials or code', () => {
  const cloud = { credentialsPath: '/etc/keepseam/cloud.json', statePath: '/var/lib/keepseam-cloud', integrationIds: ['a'.repeat(64)] };
  const result = normalizeWorkerServiceConfig({ ...config, cloud }, 'systemd');
  assert.equal(result.cloud.intervalMs, 60000); assert(Object.isFrozen(result.cloud.integrationIds));
  for (const bad of [{ ...cloud, privateJwk: {} }, { ...cloud, integrationIds: [] }, { ...cloud, integrationIds: ['a'.repeat(64), 'a'.repeat(64)] },
    { ...cloud, statePath: config.statePath }]) assert.throws(() => normalizeWorkerServiceConfig({ ...config, cloud: bad }, 'systemd'));
  const ids = []; Object.defineProperty(ids, '0', { get() { assert.fail('must not call an untrusted getter'); } });
  assert.throws(() => normalizeWorkerServiceConfig({ ...config, cloud: { ...cloud, integrationIds: ids } }, 'systemd'), /accessors/);
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
  assert.match(content, /User=keepseam\n/); assert.match(content, /Restart=on-failure/);
  assert.match(content, /ProtectSystem=strict/); assert.match(content, /TimeoutStopSec=180/);
  assert.doesNotMatch(content, /\/bin\/(?:sh|bash)|run-approved|sudo|curl/);
  for (const overrides of [{ user: 'root' }, { user: 'keepseam\nUser=root' }, { name: 'x\n' }, { target: undefined }]) assert.throws(() => render(overrides));
});

test('launchd XML encodes metacharacters and delegates keep-alive without daemonizing', () => {
  const content = render({ target: 'launchd', configPath: '/etc/keep & "seam".json' });
  assert.match(content, /keep &amp; &quot;seam&quot;\.json/);
  assert.match(content, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(content, /<key>UserName<\/key><string>keepseam<\/string>/);
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(content, /worker-service\.log/);
});

test('Windows manifest uses a passwordless low-privilege SCM account, bounded signal shutdown and wrapper logs', () => {
  const content = render({ target: 'windows', config: windows, configPath: 'C:\\Keepseam & data\\worker.json',
    cliPath: 'C:\\Program Files\\Keepseam\\cli.js', nodePath: 'C:\\Program Files\\nodejs\\node.exe', user: undefined });
  assert.match(content, /<domain>NT AUTHORITY<\/domain><user>LocalService<\/user>/);
  assert.match(content, /&quot;C:\\Keepseam &amp; data\\worker\.json&quot;/);
  assert.match(content, /<arguments>.*&quot;run&quot;/);
  assert.match(content, /<stoptimeout>180 sec<\/stoptimeout>/);
  assert.match(content, /<sizeThreshold>1024<\/sizeThreshold><keepFiles>2<\/keepFiles>/);
  assert.doesNotMatch(content, /<stoparguments>|<password>|<download|LocalSystem|<interactive|cmd\.exe|powershell/);
});
