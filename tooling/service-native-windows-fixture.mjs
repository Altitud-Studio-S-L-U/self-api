import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const powershell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
async function entries(statePath) {
  assert.equal(process.platform, 'win32');
  assert.equal(await realpath(statePath), resolve(statePath));
  const paths = [];
  async function visit(path) {
    const info = await lstat(path);
    assert(!info.isSymbolicLink() && (info.isDirectory() || (info.isFile() && info.nlink === 1)), 'Native fixture cannot contain links or special files');
    paths.push({ path, directory: info.isDirectory() });
    assert(paths.length <= 100, 'Native fixture state exceeds its bounded file count');
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  }
  await visit(statePath);
  assert(paths[0].directory);
  return paths;
}
function run(script, paths) {
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, PSModulePath: join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules'), SELF_MANAGED_API_NATIVE_FIXTURE_PATHS: JSON.stringify(paths) },
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 65_536,
  });
}
const prelude = `
$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json -InputObject $env:SELF_MANAGED_API_NATIVE_FIXTURE_PATHS
$allowed = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')
`;

/** Transfer only the caller's disposable state/config to the generated LocalService account. */
export async function provisionWindowsServiceFixture(directory, fixture) {
  assert.equal(await realpath(directory), resolve(directory));
  for (const path of [fixture.statePath, fixture.configPath]) {
    const child = relative(directory, path);
    assert(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    let current = directory;
    for (const part of child.split(sep)) { current = join(current, part); assert(!(await lstat(current)).isSymbolicLink()); }
  }
  const paths = await entries(fixture.statePath);
  const configInfo = await lstat(fixture.configPath);
  assert(configInfo.isFile() && configInfo.nlink === 1);
  paths.push({ path: fixture.configPath, directory: false, config: true });
  // Transfer ownership before changing access. A non-elevated caller must fail
  // here without losing its existing grants. icacls updates the DACL/owner alone;
  // replacing a .NET security descriptor can unnecessarily request SACL privilege.
  const grants = JSON.parse(run(`${prelude}
$result = foreach ($item in $paths) {
  $acl = Get-Acl -LiteralPath $item.path
  $grantees = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Select-Object -Unique)
  [pscustomobject]@{ path = $item.path; grantees = $grantees }
}
ConvertTo-Json -InputObject @($result) -Compress
`, paths));
  const icacls = args => execFileSync(join(systemRoot, 'System32/icacls.exe'), args, { windowsHide: true, stdio: 'pipe', timeout: 30_000 });
  for (const item of paths) icacls([item.path, '/setowner', '*S-1-5-32-544']);
  for (const item of paths) {
    const inherit = item.directory ? '(OI)(CI)' : '';
    icacls([item.path, '/inheritance:r', '/grant:r', `*S-1-5-18:${inherit}F`, `*S-1-5-32-544:${inherit}F`, `*S-1-5-19:${inherit}${item.config ? 'RX' : 'F'}`]);
    const previous = grants.find(grant => grant.path === item.path);
    assert(previous && Array.isArray(previous.grantees));
    for (const sid of previous.grantees) {
      assert(/^S-[0-9-]+$/u.test(sid));
      if (!['S-1-5-18', 'S-1-5-32-544', 'S-1-5-19'].includes(sid)) icacls([item.path, '/remove:g', `*${sid}`]);
    }
  }
  await assertWindowsServiceFixtureAcl(fixture.statePath);
}

/** Privileged acceptance inspection uses the service's identity, never the runner SID. */
function assertAclPaths(paths) {
  run(`${prelude}
foreach ($item in $paths) {
  $acl = Get-Acl -LiteralPath $item.path
  if ($item.path -eq $paths[0].path -and -not $acl.AreAccessRulesProtected) { throw 'Native fixture root must protect its private inherited permissions' }
  if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Native fixture owner is not a service principal' }
  $serviceWrite = $false
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($allowed -notcontains $sid) { throw 'Native fixture grants access outside its service principals' }
    if ($sid -eq 'S-1-5-19' -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $serviceWrite = $true }
  }
  if (-not $serviceWrite) { throw 'Native fixture does not grant LocalService control of its private state' }
}
`, paths);
}
export async function assertWindowsServiceFixtureAcl(statePath) {
  assertAclPaths(await entries(statePath));
}

/** Read acceptance evidence without reopening customer-owned stores as a different account. */
export async function readWindowsServiceEvidence(statePath, subscriptionId) {
  // Verify stable files while the service is running. Its short-lived journals
  // and status replacements can disappear between directory enumeration and ACL
  // inspection; new files inherit the already verified private state DACL.
  const paths = [];
  for (const path of [statePath, join(statePath, 'source-observations.sqlite3'), join(statePath, 'worker.sqlite3')]) {
    assert.equal(await realpath(path), resolve(path));
    const info = await lstat(path);
    assert(!info.isSymbolicLink() && (path === statePath ? info.isDirectory() : info.isFile() && info.nlink === 1));
    paths.push({ path, directory: info.isDirectory() });
  }
  assertAclPaths(paths);
  const options = { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false, timeout: 1000 };
  const sources = new DatabaseSync(join(statePath, 'source-observations.sqlite3'), options);
  try {
    assert.equal(sources.prepare('PRAGMA application_id').get().application_id, 0x504c5352);
    assert.equal(sources.prepare('PRAGMA user_version').get().user_version, 2);
    const subscription = sources.prepare('SELECT id,last_succeeded_at AS lastSucceededAt,last_error AS lastError,observed_sha AS lastObservedSha FROM source_subscriptions WHERE id=?').get(subscriptionId);
    const observations = sources.prepare('SELECT id,sequence,to_sha AS toSha FROM source_observations WHERE subscription_id=? ORDER BY sequence').all(subscriptionId);
    const worker = new DatabaseSync(join(statePath, 'worker.sqlite3'), options);
    try {
      assert.equal(worker.prepare('PRAGMA application_id').get().application_id, 0x504c554d);
      assert.equal(worker.prepare('PRAGMA user_version').get().user_version, 4);
      return { subscription, observations, jobs: worker.prepare('SELECT count(*) AS n FROM jobs').get().n,
        executionIntents: worker.prepare('SELECT count(*) AS n FROM execution_intents').get().n };
    } finally { worker.close(); }
  } finally { sources.close(); }
}
