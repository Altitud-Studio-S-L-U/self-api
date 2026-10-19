import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isProxy } from 'node:util/types';
import { calculateJwkThumbprint, importJWK, type JWK } from 'jose';
import { generateCloudWorkerIdentity, type CloudCredentials } from './cloud-connection.js';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';
import { normalizeWorkerServiceConfig, servicePath, type WorkerServiceConfig, type WorkerServiceTarget } from './worker-service-config.js';
import { checkServicePath } from './worker-service-state.js';

/** One private directory holds the installation key, then the enrolled credentials and the service configuration. */
export const workerSetupFiles = Object.freeze({ pending: 'identity.pending.json', credentials: 'credentials.json', config: 'worker.json', lock: 'setup.lock', state: 'state' });
export const defaultCloudOrigin = 'https://keepseam.com';
/** Kept equal to package.json engines by test. */
export const supportedNode = Object.freeze({ major: 24, minor: 21 });

export interface WorkerPublicIdentity { readonly installationId: string; readonly publicJwk: JWK; readonly fingerprint: string }
export interface WorkerSetupResult { readonly credentialsPath: string; readonly configPath: string; readonly statePath: string; readonly fingerprint: string }
export interface WorkerDoctorCheck { readonly id: string; readonly status: 'ok' | 'warn' | 'fail'; readonly code?: string }
export interface WorkerDoctorReport { readonly ok: boolean; readonly checks: readonly WorkerDoctorCheck[] }
export interface WorkerDoctorOptions {
  readonly directory: string;
  /** Opt-in: one GET of the Cloud liveness endpoint. It proves network reach only, not authentication or enrollment. */
  readonly online?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly nodeVersion?: string;
  readonly fetch?: typeof fetch;
}
interface PendingIdentity { readonly installationId: string; readonly privateJwk: JWK; readonly cloudOrigin: string; readonly statePath: string }

const hex = /^[a-f0-9]{64}$/u;
const coordinate = /^[A-Za-z0-9_-]{43}$/u;
const target = (): WorkerServiceTarget => process.platform === 'win32' ? 'windows' : 'systemd';
function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function plain(value: unknown, keys: readonly string[], message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(message);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptors[key]!, 'value'))) invalid(message);
  return value as Record<string, unknown>;
}
function scalar(value: unknown): string {
  if (typeof value !== 'string' || !coordinate.test(value) || Buffer.from(value, 'base64url').length !== 32
    || Buffer.from(value, 'base64url').toString('base64url') !== value) invalid('The installation key is not a P-256 key.');
  return value;
}
function privateJwk(value: unknown): JWK {
  const key = plain(value, ['kty', 'crv', 'x', 'y', 'd'], 'The installation key is not a P-256 key.');
  if (key['kty'] !== 'EC' || key['crv'] !== 'P-256') invalid('The installation key is not a P-256 key.');
  return { kty: 'EC', crv: 'P-256', x: scalar(key['x']), y: scalar(key['y']), d: scalar(key['d']) };
}
async function publicIdentity(installationId: string, key: JWK): Promise<WorkerPublicIdentity> {
  // Importing proves the private scalar is usable; only the public half leaves this function.
  try { await importJWK(key, 'ES256'); } catch { invalid('The installation key is not a P-256 key.'); }
  const publicJwk = { kty: 'EC', crv: 'P-256', x: key.x!, y: key.y! };
  return Object.freeze({ installationId, publicJwk: Object.freeze(publicJwk), fingerprint: await calculateJwkThumbprint(publicJwk) });
}
function cloudOrigin(value: unknown): string {
  let url: URL;
  if (typeof value !== 'string') invalid('The Cloud address must be an HTTPS origin.');
  try { url = new URL(value); } catch { invalid('The Cloud address must be an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) invalid('The Cloud address must be an HTTPS origin.');
  return value;
}
function credentials(value: unknown): CloudCredentials {
  const input = plain(value, ['baseUrl', 'installationId', 'projectId', 'clientSecret', 'privateJwk'], 'The Cloud credentials are malformed.');
  const { installationId, projectId, clientSecret } = input;
  if (typeof installationId !== 'string' || typeof projectId !== 'string' || typeof clientSecret !== 'string'
    || !hex.test(installationId) || !hex.test(projectId) || !hex.test(clientSecret)) invalid('The Cloud credentials are malformed.');
  return { baseUrl: cloudOrigin(input['baseUrl']), installationId, projectId, clientSecret, privateJwk: privateJwk(input['privateJwk']) };
}

async function missing(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return; }
  if (process.platform !== 'win32') await chmod(path, 0o700);
}
/** link(2) fails with EEXIST instead of replacing, so an existing file is never overwritten, even by a racing writer. */
async function writeExclusive(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') invalid('A setup file already exists; nothing was overwritten.');
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
}
/** Commands on one directory are serialized. A lock left by an interrupted command is reported, never removed automatically. */
async function withSetupLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const path = join(directory, workerSetupFiles.lock);
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') invalid('Another setup command holds this directory, or an interrupted one left setup.lock. Confirm none is running before removing it.');
    throw error;
  }
  try {
    try { await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`); } finally { await handle.close(); }
    return await action();
  } finally { await unlink(path).catch(() => undefined); }
}
function setupDirectory(directory: unknown): string {
  const path = servicePath(directory, target());
  checkServicePath(path, 'directory');
  return path;
}
async function pendingIdentity(directory: string): Promise<PendingIdentity> {
  const path = join(directory, workerSetupFiles.pending);
  checkServicePath(path, 'secret');
  const value = plain(await loadLocalJson(path, 16_384), ['schemaVersion', 'installationId', 'privateJwk', 'cloudOrigin', 'statePath'], 'The pending installation identity is malformed.');
  if (value['schemaVersion'] !== 1 || typeof value['installationId'] !== 'string' || !hex.test(value['installationId'])) invalid('The pending installation identity is malformed.');
  return { installationId: value['installationId'], privateJwk: privateJwk(value['privateJwk']), cloudOrigin: cloudOrigin(value['cloudOrigin']),
    statePath: servicePath(value['statePath'], target()) };
}
/** Writes the expected file, or accepts an identical one left by an interrupted run; anything else is a conflict. */
async function placeOrMatch<T>(path: string, expected: T, kind: 'secret' | 'config', parse: (value: unknown) => T): Promise<void> {
  if (await missing(path)) { await writeExclusive(path, expected); return; }
  checkServicePath(path, kind);
  let stored: T;
  try { stored = parse(await loadLocalJson(path, 64 * 1024)); } catch { invalid(`${path} differs from this enrollment; nothing was changed.`); }
  if (JSON.stringify(stored) !== JSON.stringify(expected)) invalid(`${path} differs from this enrollment; nothing was changed.`);
}

/**
 * Creates the private setup directory and the installation key. The key is generated only here, and only its public half is returned.
 * The Cloud origin chosen now is the only one a later enrollment may come from.
 */
export async function initWorkerSetup(options: { readonly directory: string; readonly statePath?: string; readonly cloudOrigin?: string }): Promise<WorkerPublicIdentity> {
  const directory = servicePath(options.directory, target());
  const origin = cloudOrigin(options.cloudOrigin ?? defaultCloudOrigin);
  const statePath = servicePath(options.statePath ?? join(directory, workerSetupFiles.state), target());
  if (statePath === directory) invalid('The service state needs its own directory.');
  await privateDirectory(directory);
  checkServicePath(directory, 'directory');
  return withSetupLock(directory, async () => {
    if ((await readdir(directory)).some(name => name !== workerSetupFiles.lock)) invalid('Choose a new or empty private directory; setup never reuses existing files.');
    const identity = await generateCloudWorkerIdentity();
    await writeExclusive(join(directory, workerSetupFiles.pending), { schemaVersion: 1, installationId: identity.installationId,
      privateJwk: identity.privateJwk, cloudOrigin: origin, statePath });
    await syncDirectory(directory);
    return publicIdentity(identity.installationId, privateJwk(identity.privateJwk));
  });
}

/** Re-derives the identity to paste in Keepseam Cloud from the local key, before or after enrollment. Read-only. */
export async function readWorkerPublicIdentity(options: { readonly directory: string }): Promise<WorkerPublicIdentity> {
  const directory = setupDirectory(options.directory), enrolled = join(directory, workerSetupFiles.credentials);
  if (!(await missing(enrolled))) {
    checkServicePath(enrolled, 'secret');
    const value = credentials(await loadLocalJson(enrolled, 16_384));
    return publicIdentity(value.installationId, value.privateJwk);
  }
  const pending = await pendingIdentity(directory);
  return publicIdentity(pending.installationId, pending.privateJwk);
}

/**
 * Binds the one-time enrollment from Keepseam Cloud to the local key and writes an observation-only service configuration.
 * Re-running it with the same enrollment resumes an interrupted run; the pending key is removed only after both files are
 * durable and re-read from disk.
 */
export async function completeWorkerSetup(options: { readonly directory: string; readonly enrollment: unknown; readonly intervalMs?: number }): Promise<WorkerSetupResult> {
  const directory = setupDirectory(options.directory);
  return withSetupLock(directory, async () => {
    const pendingPath = join(directory, workerSetupFiles.pending);
    const credentialsPath = join(directory, workerSetupFiles.credentials), configPath = join(directory, workerSetupFiles.config);
    if (await missing(pendingPath)) invalid((await missing(credentialsPath)) ? 'Run setup init first.' : 'Setup is already complete; enroll a new directory to replace it.');
    const pending = await pendingIdentity(directory);
    const enrollment = plain(options.enrollment, ['baseUrl', 'installationId', 'projectId', 'clientSecret'], 'Paste the exact enrollment JSON shown once by Keepseam Cloud.');
    if (enrollment['baseUrl'] !== pending.cloudOrigin) invalid('This enrollment comes from a different Cloud address than the one chosen at init.');
    if (enrollment['installationId'] !== pending.installationId) invalid('This enrollment belongs to a different installation key.');
    const expectedCredentials = credentials({ ...enrollment, privateJwk: pending.privateJwk });
    const expectedConfig = normalizeWorkerServiceConfig({ schemaVersion: 1, statePath: pending.statePath, allowHttp: false,
      sources: options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs } }, target());
    await privateDirectory(pending.statePath);
    checkServicePath(pending.statePath, 'directory');
    await placeOrMatch(credentialsPath, expectedCredentials, 'secret', credentials);
    await placeOrMatch<WorkerServiceConfig>(configPath, expectedConfig, 'config', value => normalizeWorkerServiceConfig(value, target()));
    await syncDirectory(directory);
    checkServicePath(credentialsPath, 'secret'); checkServicePath(configPath, 'config');
    if (JSON.stringify(credentials(await loadLocalJson(credentialsPath, 16_384))) !== JSON.stringify(expectedCredentials)
      || JSON.stringify(normalizeWorkerServiceConfig(await loadLocalJson(configPath, 64 * 1024), target())) !== JSON.stringify(expectedConfig)) {
      invalid('The written setup files could not be verified; the pending key was kept.');
    }
    // The key now lives only in the credentials file.
    await unlink(pendingPath);
    await syncDirectory(directory);
    return Object.freeze({ credentialsPath, configPath, statePath: pending.statePath,
      fingerprint: (await publicIdentity(expectedCredentials.installationId, expectedCredentials.privateJwk)).fingerprint });
  });
}

/** Read-only diagnosis with a stable code per check. Secret values never enter the report. */
export async function diagnoseWorker(options: WorkerDoctorOptions): Promise<WorkerDoctorReport> {
  const checks: WorkerDoctorCheck[] = [];
  const add = (id: string, status: WorkerDoctorCheck['status'], code?: string) => { checks.push(Object.freeze({ id, status, ...(code ? { code } : {}) })); };
  const attempt = async (id: string, code: string, action: () => Promise<void> | void): Promise<boolean> => {
    try { await action(); add(id, 'ok'); return true; } catch { add(id, 'fail', code); return false; }
  };
  const platform = options.platform ?? process.platform;
  add('platform', platform === 'linux' ? 'ok' : 'fail', platform === 'linux' ? undefined : 'PLATFORM_UNSUPPORTED');
  const [major = 0, minor = 0] = (options.nodeVersion ?? process.versions.node).split('.').map(Number);
  const nodeSupported = major === supportedNode.major && minor >= supportedNode.minor;
  add('node', nodeSupported ? 'ok' : 'fail', nodeSupported ? undefined : 'NODE_UNSUPPORTED');
  let directory = '';
  if (!(await attempt('directory', 'DIRECTORY_UNSAFE', () => { directory = setupDirectory(options.directory); }))) return report(checks);
  if (!(await missing(join(directory, workerSetupFiles.lock)))) add('lock', 'fail', 'SETUP_LOCKED');
  const credentialsPath = join(directory, workerSetupFiles.credentials);
  const [hasCredentials, hasPending] = [!(await missing(credentialsPath)), !(await missing(join(directory, workerSetupFiles.pending)))];
  if (hasPending) { add('enrollment', 'fail', hasCredentials ? 'SETUP_INTERRUPTED' : 'SETUP_INCOMPLETE'); if (!hasCredentials) return report(checks); }
  else if (!hasCredentials) { add('enrollment', 'fail', 'SETUP_MISSING'); return report(checks); }
  else add('enrollment', 'ok');
  let enrolled: CloudCredentials | undefined;
  await attempt('credentials', 'CREDENTIALS_INVALID', async () => {
    checkServicePath(credentialsPath, 'secret');
    const value = credentials(await loadLocalJson(credentialsPath, 16_384));
    await publicIdentity(value.installationId, value.privateJwk);
    enrolled = value;
  });
  let config: WorkerServiceConfig | undefined;
  await attempt('config', 'CONFIG_INVALID', async () => {
    const path = join(directory, workerSetupFiles.config);
    checkServicePath(path, 'config');
    config = normalizeWorkerServiceConfig(await loadLocalJson(path, 64 * 1024), target());
  });
  if (config) {
    const current = config;
    await attempt('state', 'STATE_UNSAFE', () => { checkServicePath(current.statePath, 'directory'); });
    // A sources-only service observes locally: it reads no credentials and shares nothing with Cloud.
    add('cloud-sharing', current.cloud ? 'ok' : 'warn', current.cloud ? undefined : 'OBSERVATION_ONLY');
    if ([current.cloud?.credentialsPath, current.license?.credentialsPath].some(path => path !== undefined && path !== credentialsPath)) add('credential-paths', 'warn', 'CREDENTIALS_ELSEWHERE');
  }
  // The existing publication commands read GH_TOKEN themselves; setup neither stores nor changes that authorization.
  const token = (options.environment ?? process.env)['GH_TOKEN'];
  add('github-token', token ? 'ok' : 'warn', token ? 'GH_TOKEN_PRESENT' : 'GH_TOKEN_ABSENT');
  if (options.online && enrolled) {
    const origin = enrolled.baseUrl;
    await attempt('cloud-network', 'CLOUD_UNREACHABLE', async () => {
      const response = await (options.fetch ?? fetch)(`${origin}/api/health/live`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      if (response.status !== 200) throw new Error('unavailable');
    });
  }
  return report(checks);
}
function report(checks: WorkerDoctorCheck[]): WorkerDoctorReport {
  return Object.freeze({ ok: checks.every(check => check.status !== 'fail'), checks: Object.freeze(checks) });
}
