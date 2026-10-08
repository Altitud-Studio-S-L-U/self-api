import { posix, win32 } from 'node:path';
import { isProxy } from 'node:util/types';
import { PlumberError } from './errors.js';

export type WorkerServiceTarget = 'systemd' | 'launchd' | 'windows';
export interface WorkerServiceConfig {
  readonly schemaVersion: 1;
  readonly statePath: string;
  readonly allowHttp: boolean;
  readonly openApi?: { readonly enginePath: string; readonly intervalMs: number };
  readonly sources?: { readonly intervalMs: number };
  readonly cloud?: { readonly credentialsPath: string; readonly statePath: string; readonly integrationIds: readonly string[]; readonly intervalMs: number };
}

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Service configuration must contain plain objects.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptors[key]!, 'value'))) {
    invalid('Service configuration contains an unknown field or accessor.');
  }
  return value as Record<string, unknown>;
}

/** Service paths are absolute and literal: no expansion, traversal, UNC, device names or alternate streams. */
export function servicePath(value: unknown, target: WorkerServiceTarget): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/u.test(value)
    || /^[\\/]{2}/u.test(value)) invalid('Service paths must be absolute, local and at most 4 KiB.');
  if (target === 'windows') {
    if (!/^[a-z]:\\/iu.test(value) || /[<>"|?*%]/u.test(value) || value.slice(2).includes(':') || value.includes('/')) {
      invalid('Windows service paths require a drive, backslashes, and literal names without environment expansion.');
    }
    const parts = value.slice(3).split('\\');
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
      invalid('Windows service paths contain an ambiguous or reserved segment.');
    }
    return win32.normalize(value);
  }
  if (!posix.isAbsolute(value) || value.includes('\\') || value.split('/').slice(1).some(part => !part || part === '.' || part === '..')) {
    invalid('Unix service paths must be normalized absolute local paths.');
  }
  return value;
}

function interval(value: unknown, fallback: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1000 || result > 3_600_000) {
    invalid('Service intervals must be integer milliseconds between 1000 and 3600000.');
  }
  return result;
}

export function normalizeWorkerServiceConfig(value: unknown, target: WorkerServiceTarget = process.platform === 'win32' ? 'windows' : 'systemd'): WorkerServiceConfig {
  if (!['systemd', 'launchd', 'windows'].includes(target)) invalid('Choose systemd, launchd or windows.');
  const config = record(value, ['schemaVersion', 'statePath', 'allowHttp', 'openApi', 'sources', 'cloud']);
  if (config['schemaVersion'] !== 1 || (config['allowHttp'] !== undefined && typeof config['allowHttp'] !== 'boolean')) {
    invalid('Service configuration requires schemaVersion 1 and an explicit boolean HTTP policy.');
  }
  const statePath = servicePath(config['statePath'], target);
  let openApi: WorkerServiceConfig['openApi'];
  if (config['openApi'] !== undefined) {
    const input = record(config['openApi'], ['enginePath', 'intervalMs']);
    openApi = Object.freeze({ enginePath: servicePath(input['enginePath'], target), intervalMs: interval(input['intervalMs'], 60_000) });
  }
  let sources: WorkerServiceConfig['sources'];
  if (config['sources'] !== undefined) {
    const input = record(config['sources'], ['intervalMs']);
    sources = Object.freeze({ intervalMs: interval(input['intervalMs'], 900_000) });
  }
  if (!openApi && !sources) invalid('Enable at least one registered observation profile: openApi or sources.');
  let cloud: WorkerServiceConfig['cloud'];
  if (config['cloud'] !== undefined) {
    if (!openApi) invalid('Cloud projection currently requires registered OpenAPI subscriptions.');
    const input = record(config['cloud'], ['credentialsPath', 'statePath', 'integrationIds', 'intervalMs']);
    const ids = input['integrationIds'];
    if (!Array.isArray(ids) || isProxy(ids) || Object.getPrototypeOf(ids) !== Array.prototype || ids.length < 1 || ids.length > 100) {
      invalid('Cloud sharing requires an ordinary bounded list of subscription IDs.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(ids);
    if (Reflect.ownKeys(descriptors).length !== ids.length + 1 || Array.from({ length: ids.length }, (_, index) => descriptors[String(index)])
      .some(descriptor => !descriptor || !Object.hasOwn(descriptor, 'value'))) invalid('Cloud subscription lists cannot contain holes or accessors.');
    if (new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id))) invalid('Cloud sharing requires 1–100 unique local subscription IDs.');
    const cloudPath = servicePath(input['statePath'], target);
    if (cloudPath.toLowerCase() === statePath.toLowerCase()) invalid('Cloud transport state requires its own directory.');
    cloud = Object.freeze({ credentialsPath: servicePath(input['credentialsPath'], target), statePath: cloudPath,
      integrationIds: Object.freeze([...ids] as string[]), intervalMs: interval(input['intervalMs'], 60_000) });
  }
  return Object.freeze({ schemaVersion: 1, statePath, allowHttp: config['allowHttp'] === true,
    ...(openApi ? { openApi } : {}), ...(sources ? { sources } : {}), ...(cloud ? { cloud } : {}) });
}

export interface WorkerServiceManifestOptions {
  readonly config: unknown;
  readonly configPath: string;
  readonly target: WorkerServiceTarget;
  readonly nodePath: string;
  readonly cliPath: string;
  /** systemd only; defaults to system. User services inherit the non-root manager's identity. */
  readonly scope?: 'system' | 'user';
  /** Unix system account; invalid for systemd user scope. Windows uses LocalService without a password. */
  readonly user?: string;
  readonly name?: string;
}
const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
// systemd performs its own quoting/specifier/environment expansion; it never runs a shell here.
const systemd = (value: string, environment = false): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => environment ? '$$' : '$')}"`;
const windowsArgument = (value: string): string => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/\\+$/gu, '$&$&')}"`;

export function renderWorkerServiceManifest(options: WorkerServiceManifestOptions): string {
  if (!['systemd', 'launchd', 'windows'].includes(options.target)) invalid('Choose systemd, launchd or windows.');
  const scope = options.scope === undefined ? 'system' : options.scope;
  if (!['system', 'user'].includes(scope) || (options.scope !== undefined && options.target !== 'systemd')) invalid('Service scope is system or user and applies only to systemd.');
  if (scope === 'user' && options.user !== undefined) invalid('User services inherit their manager identity; omit the user option.');
  const config = normalizeWorkerServiceConfig(options.config, options.target);
  const configPath = servicePath(options.configPath, options.target);
  const node = servicePath(options.nodePath, options.target);
  const cli = servicePath(options.cliPath, options.target);
  const name = options.name ?? 'keepseam';
  if (typeof name !== 'string' || !/^[a-z][a-z0-9]{0,31}$/u.test(name)) invalid('Service name must contain 1–32 lowercase letters and digits, starting with a letter.');
  if (options.target === 'windows') {
    if (options.user !== undefined) invalid('Windows manifests use LocalService; custom password accounts are not generated.');
    const args = (action: string): string => [cli, 'worker-service', action, '--config', configPath].map(windowsArgument).join(' ');
    return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${name}</id><name>Keepseam ${name}</name>
  <description>Local contract observation. Changes require separate approval.</description>
  <executable>${xml(node)}</executable>
  <arguments>${xml(args('run'))}</arguments>
  <workingdirectory>${xml(config.statePath)}</workingdirectory>
  <startmode>Automatic</startmode><delayedAutoStart/>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <onfailure action="restart" delay="30 sec"/><onfailure action="restart" delay="60 sec"/><onfailure action="restart" delay="5 min"/>
  <resetfailure>1 hour</resetfailure><stoptimeout>180 sec</stoptimeout>
  <logpath>${xml(config.statePath)}</logpath>
  <log mode="roll-by-size"><sizeThreshold>1024</sizeThreshold><keepFiles>2</keepFiles></log>
</service>
`;
  }
  const user = options.user;
  if (scope === 'system' && (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(user) || user === 'root')) invalid('Choose a dedicated non-root Unix account.');
  if (options.target === 'systemd') {
    const writePaths = [config.statePath, ...(config.cloud ? [config.cloud.statePath] : [])].map(value => systemd(value)).join(' ');
    return `[Unit]
Description=Keepseam local contract observer
${scope === 'user' ? 'AssertUser=!root' : 'After=network-online.target\nWants=network-online.target'}
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
${scope === 'user' ? 'PrivateUsers=true' : `User=${user}`}
UMask=0077
WorkingDirectory=${config.statePath.replaceAll('%', '%%')}
ExecStart=${[node, cli, 'worker-service', 'run', '--config', configPath].map(value => systemd(value, true)).join(' ')}
Restart=on-failure
RestartSec=30
TimeoutStopSec=180
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=${scope === 'user' ? 'read-only' : 'true'}
ReadWritePaths=${writePaths}
RestrictSUIDSGID=true
LockPersonality=true
LimitCORE=0
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30
LogRateLimitBurst=30

[Install]
WantedBy=${scope === 'user' ? 'default.target' : 'multi-user.target'}
`;
  }
  const args = [node, cli, 'worker-service', 'run', '--config', configPath].map(value => `    <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.keepseam.${name}</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>UserName</key><string>${xml(user!)}</string>
  <key>WorkingDirectory</key><string>${xml(config.statePath)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>180</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}
