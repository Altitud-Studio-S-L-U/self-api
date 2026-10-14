import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PlumberError } from './errors.js';

/** Inspect native permissions; initialize only a directory this call just created. */
export function checkWindowsPermissions(paths: readonly string[], privateAccess: boolean, createdDirectory?: string): void {
  if (process.platform !== 'win32') return;
  const script = `
$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json -InputObject $env:KEEPSEAM_ACL_PATHS
$allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($env:KEEPSEAM_ACL_CREATED) {
  $directory = Get-Item -LiteralPath $env:KEEPSEAM_ACL_CREATED
  if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { Write-Output 'invalid-directory'; exit 2 }
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
  foreach ($sid in $allowed) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  Set-Acl -LiteralPath $directory.FullName -AclObject $acl
}
foreach ($path in $paths) {
  $acl = Get-Acl -LiteralPath $path
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($allowed -notcontains $owner) { Write-Output 'owner-rejected'; exit 2 }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($allowed -contains $sid) { continue }
    if ($env:KEEPSEAM_ACL_PRIVATE -eq '1') { Write-Output 'grantee-rejected'; exit 2 }
    $write = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    if (($rule.FileSystemRights -band $write) -ne 0) { Write-Output 'write-rejected'; exit 2 }
  }
}
`;
  try {
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
    execFileSync(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, PSModulePath: join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules'),
        KEEPSEAM_ACL_PATHS: JSON.stringify(paths), KEEPSEAM_ACL_PRIVATE: privateAccess ? '1' : '0',
        KEEPSEAM_ACL_CREATED: createdDirectory ?? '' }, windowsHide: true, stdio: 'pipe', timeout: 30_000, maxBuffer: 4096 });
  } catch (error) {
    const reason = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout).trim() : '';
    const details = ['invalid-directory', 'owner-rejected', 'grantee-rejected', 'write-rejected'].includes(reason) ? ` (${reason})` : '';
    throw new PlumberError('INVALID_INPUT', `Private state requires restricted native ACLs on configuration, state and credentials${details}.`);
  }
}
