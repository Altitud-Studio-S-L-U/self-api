import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { request as httpsRequest } from 'node:https';
import { isProxy } from 'node:util/types';
import { Updater } from 'tuf-js';
import { ExpiredMetadataError, RuntimeError } from 'tuf-js/dist/error.js';
import { ReleaseFetcher, releaseBaseUrl, UPDATE_ARTIFACT_LIMIT, UPDATE_METADATA_LIMIT, WORKER_ARTIFACT_LIMIT } from './client-update-fetcher.js';
import { CloudUpdateAuthorization } from './client-update-auth.js';
import { CLIENT_UPDATE_REASONS, ClientUpdateError, type ClientUpdateReason } from './client-update-errors.js';
import type { PublicAddress } from './public-network.js';
import { checkServicePath, checkWindowsServiceAcl } from './worker-service-state.js';
import { servicePath } from './worker-service-config.js';

export { ClientUpdateError };
export type { ClientUpdateReason };
export interface PublicClientUpdateRepository {
  readonly kind?: 'public';
  readonly metadataUrl: string;
  readonly targetsUrl: string;
  /** Operator-trusted initial TUF root, never discovered from the download server. */
  readonly rootPath: string;
  readonly rootSha256: string;
}
export interface CloudClientUpdateRepository {
  readonly kind: 'cloud';
  readonly baseUrl: string;
  readonly credentialsPath: string;
  readonly rootPath: string;
  readonly rootSha256: string;
}
export type ClientUpdateRepository = PublicClientUpdateRepository | CloudClientUpdateRepository;
export interface ClientUpdateOptions {
  readonly statePath: string;
  readonly currentVersion: string;
  readonly repository: ClientUpdateRepository;
  readonly signal?: AbortSignal;
}
/**
 * The worker selector has no current version: the SDK running the check says nothing about an installed worker. Its
 * archives come only through the authenticated Cloud feed, so a public repository is refused.
 */
export interface WorkerUpdateOptions {
  readonly statePath: string;
  readonly repository: CloudClientUpdateRepository;
  readonly signal?: AbortSignal;
}
export interface ClientUpdateDependencies {
  /** Trusted transport seams for isolated tests; never selected by downloaded metadata. */
  readonly resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly PublicAddress[]>;
  readonly request?: typeof httpsRequest;
}
export interface ClientRelease {
  readonly schemaVersion: 1;
  readonly channel: 'stable';
  readonly version: string;
  readonly sequence: number;
  readonly artifact: { readonly target: string; readonly sha256: string; readonly byteLength: number };
  readonly minimumNodeVersion: string;
}
export interface ClientUpdateStatus {
  readonly schemaVersion: 1;
  readonly state: 'up-to-date' | 'available' | 'downloaded-awaiting-approval' | 'blocked';
  readonly reason: ClientUpdateReason;
  readonly currentVersion: string;
  readonly checkedAt: string;
  readonly release: ClientRelease | null;
  readonly artifactPath: string | null;
  readonly installation: 'not-authorized';
}
/** The portable Linux x64 worker of one signed release, selected from its release manifest. */
export interface WorkerRelease {
  readonly schemaVersion: 1;
  readonly channel: 'stable';
  readonly platform: 'linux-x64';
  readonly version: string;
  readonly sequence: number;
  readonly artifact: { readonly target: string; readonly sha256: string; readonly byteLength: number };
}
/**
 * There is no installation receipt for the worker, so its status never reports one: installedVersion is always null
 * and no state means installed or up to date. A downloaded archive is only a verified candidate awaiting approval.
 */
export interface WorkerUpdateStatus {
  readonly schemaVersion: 1;
  readonly artifact: 'worker-linux-x64';
  readonly state: 'available' | 'downloaded-awaiting-approval' | 'blocked';
  readonly reason: ClientUpdateReason;
  readonly checkedAt: string;
  readonly release: WorkerRelease | null;
  readonly artifactPath: string | null;
  readonly installedVersion: null;
  readonly installation: 'not-authorized';
}

type Kind = 'sdk' | 'worker';
// One state directory serves one artifact. Each updater keeps its own store, application id, trusted metadata and
// anti-rollback watermark, and refuses a directory that holds the other one's store, sidecars or cached archives.
const stores = Object.freeze({
  sdk: { file: 'client-updates.sqlite3', applicationId: 0x4b535550, archive: /^[a-f0-9]{64}\.tgz$/u, extension: '.tgz', limit: UPDATE_ARTIFACT_LIMIT },
  worker: { file: 'worker-updates.sqlite3', applicationId: 0x4b535750, archive: /^[a-f0-9]{64}\.tar\.gz$/u, extension: '.tar.gz', limit: WORKER_ARTIFACT_LIMIT },
});
const other = (kind: Kind): Kind => kind === 'sdk' ? 'worker' : 'sdk';
const MANIFEST_LIMIT = 32 * 1024;
const metadataNames = ['root.json', 'timestamp.json', 'snapshot.json', 'targets.json'] as const;
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
function invalid(): never { throw new ClientUpdateError('verification-failed'); }
function record(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (required.some(key => !Object.hasOwn(descriptors, key)) || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
    || ![...required, ...optional].includes(key) || !Object.hasOwn(descriptors[key]!, 'value'))) invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}
function version(input: unknown): string {
  if (typeof input !== 'string' || !/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/u.test(input)) invalid();
  return input;
}
function compareVersion(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}
function sha(input: unknown): string { if (typeof input !== 'string' || !/^[a-f0-9]{64}$/u.test(input)) invalid(); return input; }
function release(input: unknown): ClientRelease {
  const value = record(input, ['schemaVersion', 'channel', 'version', 'sequence', 'artifact', 'minimumNodeVersion']);
  if (value.schemaVersion !== 1 || value.channel !== 'stable' || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 1) invalid();
  const selectedVersion = version(value.version), minimum = version(value.minimumNodeVersion);
  const artifact = record(value.artifact, ['target', 'sha256', 'byteLength']);
  if (artifact.target !== `packages/keepseam-client/${selectedVersion}/keepseam-client-${selectedVersion}.tgz`
    || !Number.isSafeInteger(artifact.byteLength) || (artifact.byteLength as number) < 1 || (artifact.byteLength as number) > UPDATE_ARTIFACT_LIMIT) invalid();
  return Object.freeze({ schemaVersion: 1, channel: 'stable', version: selectedVersion, sequence: value.sequence as number,
    artifact: Object.freeze({ target: artifact.target as string, sha256: sha(artifact.sha256), byteLength: artifact.byteLength as number }), minimumNodeVersion: minimum });
}
function workerRelease(input: unknown): WorkerRelease {
  const value = record(input, ['schemaVersion', 'channel', 'platform', 'version', 'sequence', 'artifact']);
  if (value.schemaVersion !== 1 || value.channel !== 'stable' || value.platform !== 'linux-x64' || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 1) invalid();
  const selectedVersion = version(value.version), artifact = record(value.artifact, ['target', 'sha256', 'byteLength']);
  if (artifact.target !== `workers/${selectedVersion}/keepseam-${selectedVersion}-linux-x64.tar.gz`
    || !Number.isSafeInteger(artifact.byteLength) || (artifact.byteLength as number) < 1 || (artifact.byteLength as number) > WORKER_ARTIFACT_LIMIT) invalid();
  return Object.freeze({ schemaVersion: 1, channel: 'stable', platform: 'linux-x64', version: selectedVersion, sequence: value.sequence as number,
    artifact: Object.freeze({ target: artifact.target as string, sha256: sha(artifact.sha256), byteLength: artifact.byteLength as number }) });
}
/**
 * The closed release-manifest.json of the channel's release, as sign-release writes it: exactly version V and sequence S
 * of the signed channel, eligible for publication, an SDK entry equal to the channel's artifact and exactly one canonical
 * Linux x64 worker without a native signature requirement. A release without that worker is not a worker update.
 */
function workerArtifact(input: unknown, channel: ClientRelease): WorkerRelease['artifact'] {
  const manifest = record(input, ['schemaVersion', 'version', 'sequence', 'sourceRevision', 'notes', 'requirements', 'publicationEligible', 'artifacts', 'documentation']);
  const v = channel.version;
  if (manifest.schemaVersion !== 1 || manifest.version !== v || manifest.sequence !== channel.sequence || manifest.publicationEligible !== true
    || typeof manifest.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/u.test(manifest.sourceRevision)) invalid();
  for (const [field, limit] of [['notes', 4000], ['requirements', 2000]] as const) {
    if (Object.values(record(manifest[field], ['es', 'en'])).some(text => typeof text !== 'string' || text.trim().length === 0 || text.length > limit)) invalid();
  }
  const documentation = record(manifest.documentation, ['fileName', 'target', 'sha256', 'sizeBytes']), guide = `keepseam-client-${v}-technical-guide.pdf`;
  if (documentation.fileName !== guide || documentation.target !== `documentation/${v}/${guide}` || !Number.isSafeInteger(documentation.sizeBytes)
    || (documentation.sizeBytes as number) < 5 || (documentation.sizeBytes as number) > 8 * 1024 * 1024) invalid();
  sha(documentation.sha256);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 12) invalid();
  const platforms = new Set<string>(), fileNames = new Set<string>();
  let sdk: Record<string, unknown> | undefined, worker: Record<string, unknown> | undefined;
  for (const entry of manifest.artifacts as unknown[]) {
    const artifact = record(entry, ['os', 'arch', 'fileName', 'target', 'sha256', 'sizeBytes', 'nativeSignature']);
    const signature = record(artifact.nativeSignature, ['kind', 'verified', 'publisher']);
    const { os, arch, fileName } = artifact;
    if (typeof os !== 'string' || !['any', 'linux', 'macos', 'windows'].includes(os) || typeof arch !== 'string' || !['any', 'x64', 'arm64'].includes(arch)
      || (os === 'any') !== (arch === 'any') || typeof fileName !== 'string' || fileName.length > 160 || fileName.includes('..')
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:tgz|zip|tar\.gz)$/u.test(fileName)
      || artifact.target !== (os === 'any' ? `packages/keepseam-client/${v}/${fileName}` : `workers/${v}/${fileName}`)
      || !Number.isSafeInteger(artifact.sizeBytes) || (artifact.sizeBytes as number) < 1 || (artifact.sizeBytes as number) > WORKER_ARTIFACT_LIMIT
      || typeof signature.kind !== 'string' || !['not-required', 'none', 'authenticode', 'developer-id-notarized'].includes(signature.kind)
      || typeof signature.verified !== 'boolean' || (signature.publisher !== null
        && (typeof signature.publisher !== 'string' || signature.publisher.length < 1 || signature.publisher.length > 256))
      || platforms.has(`${os}:${arch}`) || fileNames.has(fileName)) invalid();
    sha(artifact.sha256); platforms.add(`${os}:${arch}`); fileNames.add(fileName);
    if (os === 'any') sdk = artifact;
    if (os === 'linux' && arch === 'x64') worker = artifact;
  }
  if (!sdk || sdk.target !== channel.artifact.target || sdk.sha256 !== channel.artifact.sha256 || sdk.sizeBytes !== channel.artifact.byteLength) invalid();
  if (!worker) throw new ClientUpdateError('feed-unavailable');
  const signature = worker.nativeSignature as Record<string, unknown>;
  if (worker.fileName !== `keepseam-${v}-linux-x64.tar.gz` || signature.kind !== 'not-required' || signature.verified !== false || signature.publisher !== null) invalid();
  return Object.freeze({ target: worker.target as string, sha256: worker.sha256 as string, byteLength: worker.sizeBytes as number });
}
function localBytes(path: string, maximum: number): Buffer {
  checkServicePath(path, 'secret');
  const attributes = lstatSync(path);
  if (attributes.size < 1 || attributes.size > maximum) invalid();
  const bytes = readFileSync(path);
  if (bytes.length > maximum) invalid();
  return bytes;
}
function status(input: unknown): ClientUpdateStatus {
  const value = record(input, ['schemaVersion', 'state', 'reason', 'currentVersion', 'checkedAt', 'release', 'artifactPath', 'installation']);
  if (value.schemaVersion !== 1 || !['up-to-date', 'available', 'downloaded-awaiting-approval', 'blocked'].includes(value.state as string)
    || !CLIENT_UPDATE_REASONS.includes(value.reason as ClientUpdateReason)
    || value.installation !== 'not-authorized' || typeof value.checkedAt !== 'string' || new Date(value.checkedAt).toISOString() !== value.checkedAt
    || (value.artifactPath !== null && typeof value.artifactPath !== 'string')) invalid();
  return { schemaVersion: 1, state: value.state as ClientUpdateStatus['state'], reason: value.reason as ClientUpdateReason,
    currentVersion: version(value.currentVersion), checkedAt: value.checkedAt, release: value.release === null ? null : release(value.release),
    artifactPath: value.artifactPath as string | null, installation: 'not-authorized' };
}
function workerStatus(input: unknown): WorkerUpdateStatus {
  const value = record(input, ['schemaVersion', 'artifact', 'state', 'reason', 'checkedAt', 'release', 'artifactPath', 'installedVersion', 'installation']);
  if (value.schemaVersion !== 1 || value.artifact !== 'worker-linux-x64' || !['available', 'downloaded-awaiting-approval', 'blocked'].includes(value.state as string)
    || !CLIENT_UPDATE_REASONS.includes(value.reason as ClientUpdateReason) || value.installedVersion !== null || value.installation !== 'not-authorized'
    || typeof value.checkedAt !== 'string' || new Date(value.checkedAt).toISOString() !== value.checkedAt
    || (value.artifactPath !== null && typeof value.artifactPath !== 'string')) invalid();
  return { schemaVersion: 1, artifact: 'worker-linux-x64', state: value.state as WorkerUpdateStatus['state'], reason: value.reason as ClientUpdateReason,
    checkedAt: value.checkedAt, release: value.release === null ? null : workerRelease(value.release), artifactPath: value.artifactPath as string | null,
    installedVersion: null, installation: 'not-authorized' };
}
function privateDirectory(path: string): string {
  servicePath(path, process.platform === 'win32' ? 'windows' : 'systemd');
  checkServicePath(path, 'directory'); checkWindowsServiceAcl(path, true);
  return realpathSync(path);
}

async function database(directory: string, kind: Kind, readOnly = false): Promise<DatabaseSync> {
  const own = stores[kind], foreign = stores[other(kind)];
  if (readdirSync(directory).some(name => name === foreign.file || name.startsWith(`${foreign.file}-`) || foreign.archive.test(name))) {
    throw new ClientUpdateError('state-unavailable');
  }
  const path = join(directory, own.file);
  if (!readOnly) {
    try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  checkServicePath(path, 'secret'); checkWindowsServiceAcl(path, true);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { checkServicePath(`${path}${suffix}`, 'secret'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    const identity = db.prepare('PRAGMA application_id').get()!.application_id;
    const revision = db.prepare('PRAGMA user_version').get()!.user_version;
    if (identity !== own.applicationId || revision !== 1) {
      if (readOnly || identity !== 0 || revision !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) invalid();
      db.exec(`BEGIN EXCLUSIVE; CREATE TABLE update_state (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL, sequence INTEGER NOT NULL,
        version TEXT NOT NULL, release_json TEXT, status_json TEXT); CREATE TABLE metadata (name TEXT PRIMARY KEY, bytes BLOB NOT NULL);
        PRAGMA application_id=${own.applicationId}; PRAGMA user_version=1; COMMIT;`);
    }
    if (!readOnly) db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; BEGIN EXCLUSIVE;');
    return db;
  } catch (error) { db.close(); throw error; }
}

async function readStatus(kind: Kind, options: { readonly statePath: string }): Promise<ClientUpdateStatus | WorkerUpdateStatus | null> {
  const input = record(options, ['statePath']);
  let db: DatabaseSync | undefined;
  try {
    const directory = privateDirectory(input.statePath as string);
    try { db = await database(directory, kind, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const stored = db.prepare('SELECT status_json FROM update_state WHERE id=1').get();
    if (!stored?.status_json) return null;
    const value = kind === 'sdk' ? status(JSON.parse(stored.status_json as string)) : workerStatus(JSON.parse(stored.status_json as string));
    if (value.state === 'downloaded-awaiting-approval') {
      if (!value.release || value.artifactPath !== join(directory, `${value.release.artifact.sha256}${stores[kind].extension}`)) invalid();
      const bytes = localBytes(value.artifactPath, stores[kind].limit);
      if (bytes.length !== value.release.artifact.byteLength || digest(bytes) !== value.release.artifact.sha256) invalid();
    }
    return value;
  } catch (error) { throw error instanceof ClientUpdateError ? error : new ClientUpdateError('state-unavailable'); }
  finally { db?.close(); }
}
/** Reads local state only. A downloaded package is never an installation receipt. */
export async function readClientUpdateStatus(options: { readonly statePath: string }): Promise<ClientUpdateStatus | null> {
  return await readStatus('sdk', options) as ClientUpdateStatus | null;
}
/** Reads local worker state only and revalidates a cached archive; it never reports an installed worker. */
export async function readWorkerUpdateStatus(options: { readonly statePath: string }): Promise<WorkerUpdateStatus | null> {
  return await readStatus('worker', options) as WorkerUpdateStatus | null;
}

/** Verifies release metadata without downloading the package or authorizing installation. */
export function checkClientUpdate(options: ClientUpdateOptions, dependencies: ClientUpdateDependencies = {}): Promise<ClientUpdateStatus> {
  return update('sdk', options, dependencies, false) as Promise<ClientUpdateStatus>;
}
/** Downloads a verified package into private state. No extraction, package scripts, installation or service restart. */
export function stageClientUpdate(options: ClientUpdateOptions, dependencies: ClientUpdateDependencies = {}): Promise<ClientUpdateStatus> {
  return update('sdk', options, dependencies, true) as Promise<ClientUpdateStatus>;
}
/** Verifies the signed portable Linux x64 worker of the current release, revalidating a cached archive, without downloading. */
export function checkWorkerUpdate(options: WorkerUpdateOptions, dependencies: ClientUpdateDependencies = {}): Promise<WorkerUpdateStatus> {
  return update('worker', options, dependencies, false) as Promise<WorkerUpdateStatus>;
}
/** Downloads the verified portable worker archive into private state. No extraction, installation or service restart. */
export function stageWorkerUpdate(options: WorkerUpdateOptions, dependencies: ClientUpdateDependencies = {}): Promise<WorkerUpdateStatus> {
  return update('worker', options, dependencies, true) as Promise<WorkerUpdateStatus>;
}

async function update(kind: Kind, options: ClientUpdateOptions | WorkerUpdateOptions, dependencies: ClientUpdateDependencies, download: boolean): Promise<ClientUpdateStatus | WorkerUpdateStatus> {
  const input = kind === 'sdk' ? record(options, ['statePath', 'currentVersion', 'repository'], ['signal']) : record(options, ['statePath', 'repository'], ['signal']);
  const repository = record(input.repository, ['rootPath', 'rootSha256'], ['kind', 'metadataUrl', 'targetsUrl', 'baseUrl', 'credentialsPath']);
  const cloud = repository.kind === 'cloud';
  // Before credentials, state or network: the portable worker is delivered only by the private API.
  if (kind === 'worker' && !cloud) invalid();
  const selected = cloud ? record(repository, ['kind', 'baseUrl', 'credentialsPath', 'rootPath', 'rootSha256'])
    : record(repository, ['metadataUrl', 'targetsUrl', 'rootPath', 'rootSha256'], ['kind']);
  if (!cloud && selected.kind !== undefined && selected.kind !== 'public') invalid();
  const currentVersion = kind === 'sdk' ? version(input.currentVersion) : undefined;
  const signal = input.signal as AbortSignal | undefined;
  if (signal !== undefined && (isProxy(signal) || !(signal instanceof AbortSignal))) invalid();
  const store = stores[kind];
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
  let db: DatabaseSync | undefined, scratch: string | undefined, directory: string | undefined, activeTransaction = false, failed = false;
  let previous: ClientUpdateStatus | WorkerUpdateStatus | null = null;
  // The worker watermark records the last release observed and authenticated, not the last completed download.
  let observed: WorkerRelease | undefined;
  let fetcher: ReleaseFetcher | undefined;
  let cached: (() => void) | undefined;
  try {
    let baseUrl: string | undefined;
    if (cloud) {
      if (typeof selected.baseUrl !== 'string' || new URL(selected.baseUrl).origin !== selected.baseUrl) invalid();
      baseUrl = releaseBaseUrl(`${selected.baseUrl}/`).slice(0, -1);
    }
    const metadataUrl = releaseBaseUrl(cloud ? `${baseUrl}/api/worker/v1/updates/metadata/` : selected.metadataUrl);
    const targetsUrl = releaseBaseUrl(cloud ? `${baseUrl}/api/worker/v1/updates/targets/` : selected.targetsUrl);
    if (metadataUrl === targetsUrl || metadataUrl.startsWith(targetsUrl) || targetsUrl.startsWith(metadataUrl)) invalid();
    const rootSha = sha(selected.rootSha256);
    const rootPath = servicePath(selected.rootPath, process.platform === 'win32' ? 'windows' : 'systemd');
    checkServicePath(rootPath, 'config'); checkWindowsServiceAcl(rootPath, false);
    const rootInfo = lstatSync(rootPath);
    if (rootInfo.size < 1 || rootInfo.size > 512_000) invalid();
    const root = readFileSync(rootPath);
    if (root.length > 512_000 || digest(root) !== rootSha) invalid();
    if (cloud) {
      const bootstrap: unknown = JSON.parse(root.toString('utf8'));
      if (!bootstrap || typeof bootstrap !== 'object' || !('signed' in bootstrap) || !bootstrap.signed
        || typeof bootstrap.signed !== 'object' || !('consistent_snapshot' in bootstrap.signed)
        || bootstrap.signed.consistent_snapshot !== true) invalid();
    }
    const authorization = baseUrl ? await CloudUpdateAuthorization.load(baseUrl, selected.credentialsPath) : undefined;
    directory = privateDirectory(input.statePath as string);
    db = await database(directory, kind); activeTransaction = true;
    // The SDK policy is unchanged; the worker's names its artifact, so neither store can be read as the other's.
    const policy = digest(JSON.stringify({ metadataUrl, targetsUrl, rootSha, channel: 'stable',
      ...(authorization ? { installationId: authorization.installationId, projectId: authorization.projectId } : {}),
      ...(kind === 'worker' ? { artifact: 'workers/linux-x64' } : {}) }));
    const row = db.prepare('SELECT * FROM update_state WHERE id=1').get();
    if (row && row.policy !== policy) invalid();
    // The worker watermark starts below every release: the verifying SDK's version is not the installed worker's.
    if (!row) db.prepare('INSERT INTO update_state VALUES(1,?,0,?,NULL,NULL)').run(policy, currentVersion ?? '0.0.0');
    if (row?.status_json) previous = kind === 'sdk' ? status(JSON.parse(row.status_json as string)) : workerStatus(JSON.parse(row.status_json as string));
    const existingNames = readdirSync(directory);
    // Crashed attempts are retained for operator inspection, but cannot grow
    // forever across restarts. This directory belongs only to the updater.
    if (existingNames.length > 64 || existingNames.filter(name => /^check-[a-f0-9-]{36}$/u.test(name)).length >= 3) {
      throw new ClientUpdateError('cache-full');
    }
    scratch = join(directory, `check-${randomUUID()}`); mkdirSync(scratch, { mode: 0o700 });
    const metadataDirectory = join(scratch, 'metadata'); mkdirSync(metadataDirectory, { mode: 0o700 });
    const records = db.prepare('SELECT name,bytes FROM metadata').all();
    if (records.length > 4) invalid();
    for (const entry of records) {
      if (!metadataNames.includes(entry.name as typeof metadataNames[number]) || !(entry.bytes instanceof Uint8Array)
        || entry.bytes.byteLength > UPDATE_METADATA_LIMIT) invalid();
      JSON.parse(Buffer.from(entry.bytes).toString('utf8'));
      writeFileSync(join(metadataDirectory, entry.name as string), entry.bytes, { mode: 0o600, flag: 'wx' });
    }
    if (records.length === 0) writeFileSync(join(metadataDirectory, 'root.json'), root, { mode: 0o600, flag: 'wx' });
    // Only tuf-js writes these files, after verification. Preserve verified root
    // rotation progress even when a later request fails; never reset to bootstrap.
    cached = (): void => {
      for (const name of readdirSync(metadataDirectory)) {
        if (!metadataNames.includes(name as typeof metadataNames[number])) invalid();
        const file = join(metadataDirectory, name);
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > UPDATE_METADATA_LIMIT) invalid();
        const bytes = readFileSync(file); JSON.parse(bytes.toString('utf8'));
        db!.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes').run(name, bytes);
      }
    };
    fetcher = new ReleaseFetcher(metadataUrl, targetsUrl, scratch, controller.signal, dependencies, authorization, store.limit);
    const updater = new Updater({ metadataDir: metadataDirectory, metadataBaseUrl: metadataUrl, targetBaseUrl: targetsUrl,
      fetcher, forceCache: false,
      config: { maxRootRotations: 16, maxDelegations: 0, rootMaxLength: 512_000, timestampMaxLength: 16_384,
        snapshotMaxLength: UPDATE_METADATA_LIMIT, targetsMaxLength: UPDATE_METADATA_LIMIT, fetchRetry: false } });
    if (controller.signal.aborted) throw new Error('Cancelled.');
    try { await updater.refresh(); }
    catch (error) {
      if (cloud && error instanceof ExpiredMetadataError) {
        // tuf-js 5.0.1 exposes one class for all expired roles. Match only its
        // fixed top-level messages; never forward metadata or provider text.
        if (error.message === 'Final root.json is expired') throw new ClientUpdateError('trust-expired');
        if (error.message === 'targets.json is expired') throw new ClientUpdateError('targets-expired');
        if (error.message === 'Final timestamp.json is expired' || error.message === 'snapshot.json is expired') throw new ClientUpdateError('metadata-expired');
      }
      if (cloud && error instanceof RuntimeError) {
        if (error.message === 'Unable to load targets error Error: targets.json is expired') throw new ClientUpdateError('targets-expired');
        if (error.message === 'Unable to load snapshot metadata error Error: Final timestamp.json is expired'
          || error.message === 'Unable to load snapshot metadata error Error: snapshot.json is expired') throw new ClientUpdateError('metadata-expired');
      }
      throw error;
    }
    const channel = await updater.getTargetInfo('channels/stable.json');
    if (!channel || channel.length > 16_384 || !channel.hashes.sha256) invalid();
    const channelPath = join(scratch, 'channel.json');
    await updater.downloadTarget(channel, channelPath);
    const candidate = release(JSON.parse(readFileSync(channelPath, 'utf8')));
    // The worker is the Linux x64 entry of the same signed release, read through TUF like every target.
    let selection: ClientRelease | WorkerRelease = candidate;
    if (kind === 'worker') {
      const manifest = await updater.getTargetInfo('release-manifest.json');
      if (!manifest || manifest.length < 1 || manifest.length > MANIFEST_LIMIT || !manifest.hashes.sha256) invalid();
      const manifestPath = join(scratch, 'release-manifest.json');
      await updater.downloadTarget(manifest, manifestPath);
      selection = Object.freeze({ schemaVersion: 1, channel: 'stable', platform: 'linux-x64', version: candidate.version, sequence: candidate.sequence,
        artifact: workerArtifact(JSON.parse(readFileSync(manifestPath, 'utf8')), candidate) });
    }
    const latest = Math.max(Number(row?.sequence ?? 0), 0);
    const sameSequence = latest === selection.sequence;
    if (selection.sequence < latest || (currentVersion !== undefined && compareVersion(selection.version, currentVersion) < 0)
      || (row && compareVersion(selection.version, row.version as string) < 0)
      || (sameSequence && row?.release_json !== JSON.stringify(selection))) throw new ClientUpdateError('version-rollback');
    const target = await updater.getTargetInfo(selection.artifact.target);
    if (!target || target.length !== selection.artifact.byteLength || target.hashes.sha256 !== selection.artifact.sha256) invalid();
    // From here the worker selection is authenticated by TUF, closed, not a rollback and bound to its target descriptor.
    // It is committed with the verified TUF metadata before any archive is read or transferred, so a process cut later
    // in this attempt cannot forget it; the status says only that it is available. The SDK keeps advancing only on
    // success.
    if (kind === 'worker') {
      observed = selection as WorkerRelease;
      cached();
      db.prepare('UPDATE update_state SET sequence=?,version=?,release_json=?,status_json=? WHERE id=1').run(observed.sequence, observed.version,
        JSON.stringify(observed), JSON.stringify({ schemaVersion: 1, artifact: 'worker-linux-x64', state: 'available', reason: 'none',
          checkedAt: new Date().toISOString(), release: observed, artifactPath: null, installedVersion: null, installation: 'not-authorized' }));
      db.exec('COMMIT'); activeTransaction = false;
      // busy_timeout is 0: if another updater takes the store between the two transactions, this attempt fails closed.
      db.exec('BEGIN EXCLUSIVE'); activeTransaction = true;
    }
    // The SDK must run on this Node.js; the portable worker carries its own runtime.
    if (kind === 'sdk' && compareVersion(process.versions.node, candidate.minimumNodeVersion) < 0) invalid();
    let artifactPath: string | null = null;
    // Without an installation receipt every verified worker is a candidate; only the SDK compares its running version.
    const newer = currentVersion === undefined || compareVersion(selection.version, currentVersion) > 0;
    if (newer) {
      const destination = join(directory, `${selection.artifact.sha256}${store.extension}`);
      let existing = false;
      try {
        const bytes = localBytes(destination, store.limit);
        if (bytes.length !== selection.artifact.byteLength || digest(bytes) !== selection.artifact.sha256) invalid();
        existing = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (download && !existing) {
        if (existingNames.filter(name => store.archive.test(name)).length >= 3) throw new ClientUpdateError('cache-full');
        const downloaded = join(scratch, `package${store.extension}`);
        await updater.downloadTarget(target, downloaded);
        if (controller.signal.aborted) throw new Error('Cancelled.');
        // Windows FlushFileBuffers requires a writable handle, even after all
        // writes have finished. The private file is flushed before publishing it.
        const descriptor = openSync(downloaded, constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
        renameSync(downloaded, destination);
        // The worker also flushes the directory entry on POSIX before its status is committed. Windows cannot open a
        // directory for flushing, and survival of the rename across power loss is not tested on either.
        if (kind === 'worker' && process.platform !== 'win32') {
          const entry = openSync(directory, constants.O_RDONLY);
          try { fsyncSync(entry); } finally { closeSync(entry); }
        }
        existing = true;
      }
      if (existing) artifactPath = destination;
    }
    if (controller.signal.aborted) throw new Error('Cancelled.');
    const checkedAt = new Date().toISOString();
    const value: ClientUpdateStatus | WorkerUpdateStatus = kind === 'sdk'
      ? { schemaVersion: 1, state: newer ? artifactPath ? 'downloaded-awaiting-approval' : 'available' : 'up-to-date',
        reason: 'none', currentVersion: currentVersion!, checkedAt, release: candidate, artifactPath, installation: 'not-authorized' }
      : { schemaVersion: 1, artifact: 'worker-linux-x64', state: artifactPath ? 'downloaded-awaiting-approval' : 'available', reason: 'none', checkedAt,
        release: selection as WorkerRelease, artifactPath, installedVersion: null, installation: 'not-authorized' };
    cached();
    db.prepare('UPDATE update_state SET sequence=?,version=?,release_json=?,status_json=? WHERE id=1')
      .run(selection.sequence, selection.version, JSON.stringify(selection), JSON.stringify(value));
    db.exec('COMMIT'); activeTransaction = false;
    return value;
  } catch (error) {
    failed = true;
    const failure = fetcher?.failure ?? error;
    const reason: Exclude<ClientUpdateReason, 'none'> = timedOut ? 'deadline-exceeded' : controller.signal.aborted ? 'cancelled'
      : failure instanceof ClientUpdateError ? failure.reason : 'verification-failed';
    if (db && activeTransaction) {
      try {
        cached?.();
        const checkedAt = new Date().toISOString();
        const blocked = kind === 'sdk'
          ? { schemaVersion: 1, state: 'blocked', reason, currentVersion, checkedAt, release: previous?.release ?? null, artifactPath: null, installation: 'not-authorized' }
          : { schemaVersion: 1, artifact: 'worker-linux-x64', state: 'blocked', reason, checkedAt, release: observed ?? previous?.release ?? null, artifactPath: null,
            installedVersion: null, installation: 'not-authorized' };
        if (observed) {
          db.prepare('UPDATE update_state SET sequence=?,version=?,release_json=?,status_json=? WHERE id=1')
            .run(observed.sequence, observed.version, JSON.stringify(observed), JSON.stringify(blocked));
        } else db.prepare('UPDATE update_state SET status_json=? WHERE id=1').run(JSON.stringify(blocked));
        db.exec('COMMIT'); activeTransaction = false;
      } catch { /* A damaged update store is never reset to bypass trusted history. */ }
    }
    throw new ClientUpdateError(reason);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();
    if (activeTransaction) { try { db?.exec('ROLLBACK'); } catch { /* Preserve original failure. */ } }
    try {
      db?.close();
      if (scratch && directory && dirname(scratch) === directory && /^check-[a-f0-9-]{36}$/u.test(basename(scratch))) {
        const info = lstatSync(scratch);
        if (!info.isSymbolicLink() && info.isDirectory() && realpathSync(scratch) === scratch) rmSync(scratch, { recursive: true, force: false });
      }
    } catch { if (!failed) throw new ClientUpdateError('state-unavailable'); }
  }
}
