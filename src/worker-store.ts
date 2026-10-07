import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SnapshotMetadata } from './contracts.js';
import type { ImpactReport } from './impact.js';
import { PlumberError } from './errors.js';

export interface WorkerSnapshot { readonly bytes: Uint8Array; readonly metadata: SnapshotMetadata }
export interface WorkerSubscription {
  readonly id: string;
  readonly label: string;
  readonly sourcePath: string;
  readonly consumerRoot: string;
  readonly providerBaseUrl: string;
  readonly configuredBaselineSha: string;
  readonly lastObservedSha: string | null;
  readonly createdAt: string;
  readonly lastCheckedAt: string | null;
  readonly lastSucceededAt: string | null;
  readonly lastError: string | null;
  readonly adopted: 'unknown';
  readonly deployed: 'unknown';
}
export interface WorkerLease {
  readonly subscriptionId: string;
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: string;
}
export interface WorkerJob {
  readonly id: string;
  readonly subscriptionId: string;
  readonly baselineSha: string;
  readonly revisionSha: string;
  readonly consumerDigest: string;
  readonly engineVersion: string;
  readonly status: 'review-required';
  readonly report: ImpactReport;
  readonly createdAt: string;
}
export interface WorkerStore {
  readonly statePath: string;
  register(input: {
    id: string; label: string; sourcePath: string; consumerRoot: string; providerBaseUrl: string; baseline: WorkerSnapshot;
  }): WorkerSubscription;
  listSubscriptions(): WorkerSubscription[];
  getBaseline(subscriptionId: string): WorkerSnapshot;
  claim(subscriptionId: string): WorkerLease | null;
  completeObservation(input: { lease: WorkerLease; snapshot: WorkerSnapshot; report: ImpactReport }): { job: WorkerJob | null; created: boolean; transition: boolean };
  failObservation(input: { lease: WorkerLease; reason: string }): void;
  listJobs(): WorkerJob[];
  close(): void;
}

const HASH = /^[a-f0-9]{64}$/u;
const APPLICATION_ID = 0x504c554d;
const LEASE_MS = 5 * 60 * 1000;
const SNAPSHOT_LIMIT = 4 * 1024 * 1024;
const TOTAL_SNAPSHOT_LIMIT = 64 * 1024 * 1024;
const REPORT_LIMIT = 4 * 1024 * 1024;
const TOTAL_REPORT_LIMIT = 64 * 1024 * 1024;
const REASONS = new Set(['source-unavailable', 'consumer-unavailable', 'invalid-contract', 'unsupported-contract', 'analysis-failed', 'consumer-changed', 'state-limit']);
type Row = Record<string, unknown>;

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function limit(message: string): never { throw new PlumberError('STATE_LIMIT', message); }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : undefined; }

function localPath(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value === '-' || /[\u0000-\u001f\u007f]/u.test(value) || /^[\\/]{2}/u.test(value)) {
    invalid('Worker paths must identify local files or directories.');
  }
  const tail = process.platform === 'win32' && /^[a-z]:[\\/]/iu.test(value) ? value.slice(2) : value;
  if (tail.includes(':') || /(?:^|[\\/])(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/iu.test(value)) {
    invalid('URLs, device paths, drive-relative paths, and alternate streams are not supported.');
  }
  if (process.platform === 'win32' && tail.split(/[\\/]/u).some(part => part !== '.' && part !== '..' && /[. ]$/u.test(part))) {
    invalid('Paths with trailing dots or spaces are not supported.');
  }
  return resolve(value);
}

function directoryPath(path: string, create = false): string {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = join(current, parts[index]!);
    let attributes;
    try { attributes = lstatSync(current); }
    catch (error) {
      if (!create || index < 0 || errorCode(error) !== 'ENOENT') throw error;
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (creationError) { if (errorCode(creationError) !== 'EEXIST') throw creationError; }
      attributes = lstatSync(current);
    }
    if (attributes.isSymbolicLink() || !attributes.isDirectory()) invalid('Worker directories and ancestors must not be links or non-directories.');
  }
  return realpathSync(path);
}

function nested(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function metadata(value: SnapshotMetadata): SnapshotMetadata {
  if (!value || typeof value !== 'object' || !HASH.test(value.sha256) || !Number.isSafeInteger(value.byteLength)
    || value.byteLength <= 0 || value.byteLength > SNAPSHOT_LIMIT || typeof value.specificationVersion !== 'string'
    || !/^3\.[01]\.\d+$/u.test(value.specificationVersion) || typeof value.apiVersion !== 'string' || !value.apiVersion.trim()) {
    invalid('A worker snapshot requires valid bounded OpenAPI metadata.');
  }
  return { sha256: value.sha256, byteLength: value.byteLength, specificationVersion: value.specificationVersion, apiVersion: value.apiVersion };
}

function snapshot(value: WorkerSnapshot): { bytes: Buffer; metadata: SnapshotMetadata; json: string } {
  if (!value || !(value.bytes instanceof Uint8Array)) invalid('Snapshot bytes must be a byte array.');
  const info = metadata(value.metadata);
  if (value.bytes.byteLength !== info.byteLength || hash(value.bytes) !== info.sha256) invalid('Snapshot bytes do not match their declared digest and length.');
  const json = JSON.stringify(info);
  if (Buffer.byteLength(json) > SNAPSHOT_LIMIT) invalid('Snapshot metadata exceeds its limit.');
  return { bytes: Buffer.from(value.bytes), metadata: info, json };
}

function iso(value: unknown): string | null { return value === null ? null : new Date(value as number).toISOString(); }
function subscription(row: Row): WorkerSubscription {
  return {
    id: row.id as string, label: row.label as string, sourcePath: row.source_path as string,
    consumerRoot: row.consumer_root as string, providerBaseUrl: row.provider_base_url as string,
    configuredBaselineSha: row.baseline_sha as string, lastObservedSha: row.observed_sha as string | null,
    createdAt: iso(row.created_at)!, lastCheckedAt: iso(row.last_checked_at), lastSucceededAt: iso(row.last_succeeded_at),
    lastError: row.last_error as string | null, adopted: 'unknown', deployed: 'unknown',
  };
}
function job(row: Row): WorkerJob {
  return {
    id: row.id as string, subscriptionId: row.subscription_id as string, baselineSha: row.baseline_sha as string,
    revisionSha: row.revision_sha as string, consumerDigest: row.consumer_digest as string, engineVersion: row.engine_version as string,
    status: 'review-required', report: JSON.parse(row.report_json as string) as ImpactReport, createdAt: iso(row.created_at)!,
  };
}

const SCHEMA = `
CREATE TABLE snapshots (sha TEXT PRIMARY KEY, bytes BLOB NOT NULL, metadata_json TEXT NOT NULL, captured_at INTEGER NOT NULL) STRICT;
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, source_path TEXT NOT NULL, consumer_root TEXT NOT NULL,
  provider_base_url TEXT NOT NULL, baseline_sha TEXT NOT NULL REFERENCES snapshots(sha), observed_sha TEXT REFERENCES snapshots(sha),
  created_at INTEGER NOT NULL, last_checked_at INTEGER, last_succeeded_at INTEGER, last_error TEXT,
  lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER
) STRICT;
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  from_sha TEXT REFERENCES snapshots(sha), to_sha TEXT NOT NULL REFERENCES snapshots(sha), observed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  baseline_sha TEXT NOT NULL REFERENCES snapshots(sha), revision_sha TEXT NOT NULL REFERENCES snapshots(sha),
  consumer_digest TEXT NOT NULL, engine_version TEXT NOT NULL, report_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(subscription_id, baseline_sha, revision_sha, consumer_digest, engine_version)
) STRICT;
PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`;

/** Opens customer-owned local state explicitly. Importing this module starts no worker and opens no database. */
export async function openWorkerStore(statePath: string): Promise<WorkerStore> {
  let database: DatabaseSync | undefined;
  try {
    const absolute = localPath(statePath);
    if (absolute === parse(absolute).root || /\.sqlite(?:3)?$/iu.test(absolute)) invalid('Provide a dedicated worker state directory, not a database file.');
    const state = directoryPath(absolute, true);
    if (process.platform !== 'win32' && (lstatSync(state).mode & 0o077) !== 0) {
      invalid('Existing worker state must already have private owner-only POSIX permissions.');
    }
    const databasePath = join(state, 'worker.sqlite3');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        const attributes = lstatSync(`${databasePath}${suffix}`);
        if (attributes.isSymbolicLink() || !attributes.isFile()) invalid('Worker database files and journals must be regular local files.');
        if (process.platform !== 'win32' && (attributes.mode & 0o077) !== 0) {
          invalid('Existing worker database files must already have private owner-only POSIX permissions.');
        }
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    try { closeSync(openSync(databasePath, 'wx', 0o600)); }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath, { timeout: 1000, allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    database = db;
    const application = (): number => db.prepare('PRAGMA application_id').get()!.application_id as number;
    const version = (): number => db.prepare('PRAGMA user_version').get()!.user_version as number;
    if (version() !== 0 && (version() !== 1 || application() !== APPLICATION_ID)) invalid('The worker database version or identity is unsupported.');
    if (version() === 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (version() === 0) {
          if (application() !== 0 || (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n as number) !== 0) {
            invalid('An existing foreign database cannot be imported as worker state.');
          }
          db.exec(SCHEMA);
        } else if (version() !== 1 || application() !== APPLICATION_ID) invalid('The worker database version or identity is unsupported.');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    let closed = false;
    const operate = <T>(action: () => T): T => {
      if (closed) invalid('The worker store is closed.');
      try { return action(); }
      catch (error) {
        if (error instanceof PlumberError) throw error;
        invalid('Could not access durable worker state.');
      }
    };
    const transaction = <T>(action: () => T): T => operate(() => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = action(); db.exec('COMMIT'); return result; }
      catch (error) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK'); }
          catch { closed = true; db.close(); }
        }
        throw error;
      }
    });
    const required = (id: string): Row => {
      if (typeof id !== 'string' || !HASH.test(id)) invalid('A subscription identifier must be a lowercase SHA-256 value.');
      const row = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
      if (!row) invalid('The worker subscription does not exist.');
      return row;
    };
    const saveSnapshot = (value: ReturnType<typeof snapshot>): void => {
      const existing = db.prepare('SELECT bytes, metadata_json FROM snapshots WHERE sha=?').get(value.metadata.sha256);
      if (existing) {
        if (!Buffer.from(existing.bytes as Uint8Array).equals(value.bytes) || existing.metadata_json !== value.json) invalid('Stored immutable snapshot evidence does not match its digest.');
        return;
      }
      const used = db.prepare('SELECT coalesce(sum(length(bytes)),0) AS n FROM snapshots').get()!.n as number;
      if (used + value.bytes.length > TOTAL_SNAPSHOT_LIMIT) limit('Worker snapshots exceed the total 64 MiB limit.');
      db.prepare('INSERT INTO snapshots VALUES (?,?,?,?)').run(value.metadata.sha256, value.bytes, value.json, Date.now());
    };
    const owned = (lease: WorkerLease): Row => {
      if (!lease || typeof lease.owner !== 'string' || !Number.isSafeInteger(lease.generation)) invalid('A worker lease is required.');
      const row = required(lease.subscriptionId);
      if (row.lease_owner !== lease.owner || row.lease_generation !== lease.generation || (row.lease_expires_at as number | null) === null
        || (row.lease_expires_at as number) <= Date.now()) throw new PlumberError('LEASE_LOST', 'The worker no longer owns an unexpired observation lease.');
      return row;
    };
    return {
      statePath: state,
      register(input) { return transaction(() => {
        if (!input || typeof input.id !== 'string' || !HASH.test(input.id) || typeof input.label !== 'string' || !input.label.trim()
          || Buffer.byteLength(input.label) > 200) invalid('Subscriptions require an identifier and a bounded nonempty label.');
        const baseline = snapshot(input.baseline);
        const sourcePath = localPath(input.sourcePath);
        const consumerRoot = directoryPath(localPath(input.consumerRoot));
        if (nested(state, consumerRoot) || nested(consumerRoot, state)) invalid('Worker state must be outside the consumer directory and cannot contain it.');
        let provider: URL;
        try { provider = new URL(input.providerBaseUrl); } catch { invalid('An absolute HTTP(S) provider URL is required.'); }
        if (!['http:', 'https:'].includes(provider.protocol) || provider.username || provider.password || provider.search || provider.hash) invalid('Provider bindings must not contain credentials, queries, or fragments.');
        const providerBaseUrl = `${provider.origin}${provider.pathname.replace(/\/$/u, '')}`;
        const existing = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(input.id);
        if (existing) {
          if (existing.label !== input.label || existing.source_path !== sourcePath || existing.consumer_root !== consumerRoot
            || existing.provider_base_url !== providerBaseUrl || existing.baseline_sha !== baseline.metadata.sha256) invalid('An existing subscription configuration is immutable.');
          saveSnapshot(baseline);
          return subscription(existing);
        }
        if ((db.prepare('SELECT count(*) AS n FROM subscriptions').get()!.n as number) >= 100) limit('Worker subscriptions exceed the limit of 100.');
        saveSnapshot(baseline);
        db.prepare('INSERT INTO subscriptions (id,label,source_path,consumer_root,provider_base_url,baseline_sha,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(input.id, input.label, sourcePath, consumerRoot, providerBaseUrl, baseline.metadata.sha256, Date.now());
        return subscription(required(input.id));
      }); },
      listSubscriptions() { return operate(() => db.prepare('SELECT * FROM subscriptions ORDER BY id').all().map(subscription)); },
      getBaseline(subscriptionId) { return operate(() => {
        const current = required(subscriptionId);
        const value = db.prepare('SELECT bytes, metadata_json FROM snapshots WHERE sha=?').get(current.baseline_sha as string)!;
        const checked = snapshot({ bytes: value.bytes as Uint8Array, metadata: JSON.parse(value.metadata_json as string) as SnapshotMetadata });
        return { bytes: Uint8Array.from(checked.bytes), metadata: checked.metadata };
      }); },
      claim(subscriptionId) { return transaction(() => {
        const current = required(subscriptionId);
        const now = Date.now();
        if (current.lease_owner !== null && (current.lease_expires_at as number) > now) return null;
        const owner = randomUUID();
        const generation = (current.lease_generation as number) + 1;
        const expires = now + LEASE_MS;
        db.prepare('UPDATE subscriptions SET lease_owner=?,lease_generation=?,lease_expires_at=? WHERE id=?').run(owner, generation, expires, subscriptionId);
        return { subscriptionId, owner, generation, expiresAt: new Date(expires).toISOString() };
      }); },
      completeObservation({ lease, snapshot: observed, report }) { return transaction(() => {
        const current = owned(lease);
        const value = snapshot(observed);
        const baseline = db.prepare('SELECT metadata_json FROM snapshots WHERE sha=?').get(current.baseline_sha as string)!;
        if (!report || report.schemaVersion !== 1 || report.conclusion !== 'review-required' || !HASH.test(report.inventory?.digest)
          || report.comparison?.engine?.name !== 'oasdiff' || typeof report.comparison.engine.version !== 'string'
          || !report.comparison.engine.version.trim() || report.comparison.engine.version.length > 100
          || JSON.stringify(metadata(report.comparison.base)) !== baseline.metadata_json
          || JSON.stringify(metadata(report.comparison.revision)) !== value.json) invalid('The impact report does not match the configured baseline and observed evidence.');
        const provider = new URL(current.provider_base_url as string);
        if (report.provider?.origin !== provider.origin || report.provider.basePath !== provider.pathname.replace(/\/$/u, '')) invalid('The report provider does not match the subscription binding.');
        const reportJson = JSON.stringify(report);
        if (Buffer.byteLength(reportJson) > REPORT_LIMIT) limit('A worker impact report exceeds the 4 MiB limit.');
        const transition = current.observed_sha !== value.metadata.sha256;
        if (transition && (db.prepare('SELECT count(*) AS n FROM observations').get()!.n as number) >= 1000) limit('Worker observation transitions exceed the limit of 1000.');
        let output: WorkerJob | null = null;
        let created = false;
        const now = Date.now();
        if (current.baseline_sha !== value.metadata.sha256) {
          const id = hash(JSON.stringify([lease.subscriptionId, current.baseline_sha, value.metadata.sha256, report.inventory.digest, report.comparison.engine.version]));
          const existing = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
          if (existing) output = job(existing);
          else {
            if ((db.prepare('SELECT count(*) AS n FROM jobs').get()!.n as number) >= 1000) limit('Worker jobs exceed the limit of 1000.');
            const used = db.prepare('SELECT coalesce(sum(length(CAST(report_json AS BLOB))),0) AS n FROM jobs').get()!.n as number;
            if (used + Buffer.byteLength(reportJson) > TOTAL_REPORT_LIMIT) limit('Worker reports exceed the total 64 MiB limit.');
            saveSnapshot(value);
            db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)').run(id, lease.subscriptionId, current.baseline_sha as string, value.metadata.sha256,
              report.inventory.digest, report.comparison.engine.version, reportJson, now);
            output = job(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)!);
            created = true;
          }
        }
        saveSnapshot(value);
        if (transition) db.prepare('INSERT INTO observations (subscription_id,from_sha,to_sha,observed_at) VALUES (?,?,?,?)')
          .run(lease.subscriptionId, current.observed_sha as string | null, value.metadata.sha256, now);
        owned(lease);
        db.prepare('UPDATE subscriptions SET observed_sha=?,last_checked_at=?,last_succeeded_at=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=?')
          .run(value.metadata.sha256, now, now, lease.subscriptionId);
        return { job: output, created, transition };
      }); },
      failObservation({ lease, reason }) { transaction(() => {
        owned(lease);
        if (!REASONS.has(reason)) invalid('Observation failures require a supported fixed reason.');
        db.prepare('UPDATE subscriptions SET last_checked_at=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?').run(Date.now(), reason, lease.subscriptionId);
      }); },
      listJobs() { return operate(() => db.prepare('SELECT * FROM jobs ORDER BY created_at,id').all().map(job)); },
      close() { if (!closed) { operate(() => db.close()); closed = true; } },
    };
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original state-opening failure. */ }
    if (error instanceof PlumberError) throw error;
    invalid('Could not open worker state as a local SQLite database.');
  }
}
