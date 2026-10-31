import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { request as httpsRequest } from 'node:https';
import { isProxy } from 'node:util/types';
import { Updater } from 'tuf-js';
import { ReleaseFetcher, releaseBaseUrl, UPDATE_ARTIFACT_LIMIT, UPDATE_METADATA_LIMIT } from './client-update-fetcher.js';
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
export type ClientUpdateRepository = PublicClientUpdateRepository;
export interface ClientUpdateOptions {
  readonly statePath: string;
  readonly currentVersion: string;
  readonly repository: ClientUpdateRepository;
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

const APPLICATION_ID = 0x4b535550;
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
  if (artifact.target !== `packages/self-managed-api/${selectedVersion}/self-managed-api-${selectedVersion}.tgz`
    || !Number.isSafeInteger(artifact.byteLength) || (artifact.byteLength as number) < 1 || (artifact.byteLength as number) > UPDATE_ARTIFACT_LIMIT) invalid();
  return Object.freeze({ schemaVersion: 1, channel: 'stable', version: selectedVersion, sequence: value.sequence as number,
    artifact: Object.freeze({ target: artifact.target as string, sha256: sha(artifact.sha256), byteLength: artifact.byteLength as number }), minimumNodeVersion: minimum });
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
function privateDirectory(path: string): string {
  servicePath(path, process.platform === 'win32' ? 'windows' : 'systemd');
  checkServicePath(path, 'directory'); checkWindowsServiceAcl(path, true);
  return realpathSync(path);
}

async function database(directory: string, readOnly = false): Promise<DatabaseSync> {
  const path = join(directory, 'client-updates.sqlite3');
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
    if (identity !== APPLICATION_ID || revision !== 1) {
      if (readOnly || identity !== 0 || revision !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) invalid();
      db.exec(`BEGIN EXCLUSIVE; CREATE TABLE update_state (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL, sequence INTEGER NOT NULL,
        version TEXT NOT NULL, release_json TEXT, status_json TEXT); CREATE TABLE metadata (name TEXT PRIMARY KEY, bytes BLOB NOT NULL);
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
    }
    if (!readOnly) db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; BEGIN EXCLUSIVE;');
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Reads local state only. A downloaded package is never an installation receipt. */
export async function readClientUpdateStatus(options: { readonly statePath: string }): Promise<ClientUpdateStatus | null> {
  const input = record(options, ['statePath']);
  let db: DatabaseSync | undefined;
  try {
    const directory = privateDirectory(input.statePath as string);
    try { db = await database(directory, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const stored = db.prepare('SELECT status_json FROM update_state WHERE id=1').get();
    if (!stored?.status_json) return null;
    const value = status(JSON.parse(stored.status_json as string));
    if (value.state === 'downloaded-awaiting-approval') {
      if (!value.release || value.artifactPath !== join(directory, `${value.release.artifact.sha256}.tgz`)) invalid();
      const bytes = localBytes(value.artifactPath, UPDATE_ARTIFACT_LIMIT);
      if (bytes.length !== value.release.artifact.byteLength || digest(bytes) !== value.release.artifact.sha256) invalid();
    }
    return value;
  } catch (error) { throw error instanceof ClientUpdateError ? error : new ClientUpdateError('state-unavailable'); }
  finally { db?.close(); }
}

/** Verifies release metadata without downloading the package or authorizing installation. */
export function checkClientUpdate(options: ClientUpdateOptions, dependencies: ClientUpdateDependencies = {}): Promise<ClientUpdateStatus> {
  return update(options, dependencies, false);
}
/** Downloads a verified package into private state. No extraction, package scripts, installation or service restart. */
export function stageClientUpdate(options: ClientUpdateOptions, dependencies: ClientUpdateDependencies = {}): Promise<ClientUpdateStatus> {
  return update(options, dependencies, true);
}

async function update(options: ClientUpdateOptions, dependencies: ClientUpdateDependencies, download: boolean): Promise<ClientUpdateStatus> {
  const input = record(options, ['statePath', 'currentVersion', 'repository'], ['signal']);
  const repository = record(input.repository, ['metadataUrl', 'targetsUrl', 'rootPath', 'rootSha256'], ['kind']);
  if (repository.kind !== undefined && repository.kind !== 'public') invalid();
  const currentVersion = version(input.currentVersion);
  const signal = input.signal as AbortSignal | undefined;
  if (signal !== undefined && (isProxy(signal) || !(signal instanceof AbortSignal))) invalid();
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
  let db: DatabaseSync | undefined, scratch: string | undefined, directory: string | undefined, activeTransaction = false, failed = false;
  let previous: ClientUpdateStatus | null = null;
  let cached: (() => void) | undefined;
  try {
    const metadataUrl = releaseBaseUrl(repository.metadataUrl);
    const targetsUrl = releaseBaseUrl(repository.targetsUrl);
    if (metadataUrl === targetsUrl || metadataUrl.startsWith(targetsUrl) || targetsUrl.startsWith(metadataUrl)) invalid();
    const rootSha = sha(repository.rootSha256);
    const rootPath = servicePath(repository.rootPath, process.platform === 'win32' ? 'windows' : 'systemd');
    checkServicePath(rootPath, 'config'); checkWindowsServiceAcl(rootPath, false);
    const rootInfo = lstatSync(rootPath);
    if (rootInfo.size < 1 || rootInfo.size > 512_000) invalid();
    const root = readFileSync(rootPath);
    if (root.length > 512_000 || digest(root) !== rootSha) invalid();
    directory = privateDirectory(input.statePath as string);
    db = await database(directory); activeTransaction = true;
    const policy = digest(JSON.stringify({ metadataUrl, targetsUrl, rootSha, channel: 'stable' }));
    const row = db.prepare('SELECT * FROM update_state WHERE id=1').get();
    if (row && row.policy !== policy) invalid();
    if (!row) db.prepare('INSERT INTO update_state VALUES(1,?,0,?,NULL,NULL)').run(policy, currentVersion);
    if (row?.status_json) previous = status(JSON.parse(row.status_json as string));
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
    const fetcher = new ReleaseFetcher(metadataUrl, targetsUrl, scratch, controller.signal, dependencies);
    const updater = new Updater({ metadataDir: metadataDirectory, metadataBaseUrl: metadataUrl, targetBaseUrl: targetsUrl,
      fetcher, forceCache: false,
      config: { maxRootRotations: 16, maxDelegations: 0, rootMaxLength: 512_000, timestampMaxLength: 16_384,
        snapshotMaxLength: UPDATE_METADATA_LIMIT, targetsMaxLength: UPDATE_METADATA_LIMIT, fetchRetry: false } });
    if (controller.signal.aborted) throw new Error('Cancelled.');
    await updater.refresh();
    const channel = await updater.getTargetInfo('channels/stable.json');
    if (!channel || channel.length > 16_384 || !channel.hashes.sha256) invalid();
    const channelPath = join(scratch, 'channel.json');
    await updater.downloadTarget(channel, channelPath);
    const candidate = release(JSON.parse(readFileSync(channelPath, 'utf8')));
    const latest = Math.max(Number(row?.sequence ?? 0), 0);
    const sameSequence = latest === candidate.sequence;
    if (candidate.sequence < latest || compareVersion(candidate.version, currentVersion) < 0
      || (row && compareVersion(candidate.version, row.version as string) < 0)
      || (sameSequence && row?.release_json !== JSON.stringify(candidate))) throw new ClientUpdateError('version-rollback');
    const target = await updater.getTargetInfo(candidate.artifact.target);
    if (!target || target.length !== candidate.artifact.byteLength || target.hashes.sha256 !== candidate.artifact.sha256) invalid();
    if (compareVersion(process.versions.node, candidate.minimumNodeVersion) < 0) invalid();
    let artifactPath: string | null = null;
    const newer = compareVersion(candidate.version, currentVersion) > 0;
    if (newer) {
      const destination = join(directory, `${candidate.artifact.sha256}.tgz`);
      let existing = false;
      try {
        const bytes = localBytes(destination, UPDATE_ARTIFACT_LIMIT);
        if (bytes.length !== candidate.artifact.byteLength || digest(bytes) !== candidate.artifact.sha256) invalid();
        existing = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (download && !existing) {
        if (existingNames.filter(name => /^[a-f0-9]{64}\.tgz$/u.test(name)).length >= 3) throw new ClientUpdateError('cache-full');
        const downloaded = join(scratch, 'package.tgz');
        await updater.downloadTarget(target, downloaded);
        if (controller.signal.aborted) throw new Error('Cancelled.');
        // Windows FlushFileBuffers requires a writable handle, even after all
        // writes have finished. The private file is flushed before publishing it.
        const descriptor = openSync(downloaded, constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
        renameSync(downloaded, destination);
        existing = true;
      }
      if (existing) artifactPath = destination;
    }
    if (controller.signal.aborted) throw new Error('Cancelled.');
    const value: ClientUpdateStatus = { schemaVersion: 1, state: newer ? artifactPath ? 'downloaded-awaiting-approval' : 'available' : 'up-to-date',
      reason: 'none', currentVersion, checkedAt: new Date().toISOString(), release: candidate, artifactPath, installation: 'not-authorized' };
    cached();
    db.prepare('UPDATE update_state SET sequence=?,version=?,release_json=?,status_json=? WHERE id=1')
      .run(candidate.sequence, candidate.version, JSON.stringify(candidate), JSON.stringify(value));
    db.exec('COMMIT'); activeTransaction = false;
    return value;
  } catch (error) {
    failed = true;
    const reason: Exclude<ClientUpdateReason, 'none'> = timedOut ? 'deadline-exceeded' : controller.signal.aborted ? 'cancelled'
      : error instanceof ClientUpdateError ? error.reason : 'verification-failed';
    if (db && activeTransaction) {
      try {
        cached?.();
        db.prepare('UPDATE update_state SET status_json=? WHERE id=1').run(JSON.stringify({ schemaVersion: 1, state: 'blocked', reason,
          currentVersion, checkedAt: new Date().toISOString(), release: previous?.release ?? null, artifactPath: null, installation: 'not-authorized' }));
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
