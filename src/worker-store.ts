import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isProxy } from 'node:util/types';
import type { SnapshotMetadata } from './contracts.js';
import type { ImpactReport } from './impact.js';
import { PlumberError } from './errors.js';
import { validateValidationOutcome, type ValidationOutcome } from './validation-outcome.js';
import { prepareHttpSource, validateHttpSourceSnapshot } from './http-source.js';
import type { HttpSourcePolicy, HttpSourceSnapshot } from './http-source.js';

export interface WorkerSnapshot { readonly bytes: Uint8Array; readonly metadata: SnapshotMetadata }
export interface WorkerSubscription {
  readonly id: string;
  readonly label: string;
  readonly sourcePath: string;
  /** Null for local files; HTTPS subscriptions use sourcePath as a URL, never as a mirror path. */
  readonly httpSource: HttpSourcePolicy | null;
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
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'blocked' | 'interrupted';
export type ExecutionBlockReason = 'stale-evidence' | 'approval-invalid' | 'execution-failed' | 'request-mismatch';
export type ExecutionRecoveryReason = 'execution-interrupted' | 'cleanup-unresolved' | 'invalid-outcome';
export interface ExecutionIntent {
  readonly id: string;
  readonly jobId: string;
  readonly receiptId: string;
  readonly requestId: string;
  readonly planId: string;
  readonly executionDigest: string;
  readonly policyDigest: string;
  readonly recipeJson: string;
  readonly testPaths: readonly string[];
  readonly status: ExecutionStatus;
  readonly owner: string | null;
  readonly generation: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly outcome: ValidationOutcome | null;
  readonly reason: string | null;
}
export interface ExecutionClaim {
  readonly intent: ExecutionIntent;
  readonly owner: string;
  readonly generation: number;
}
export interface EnqueueExecutionInput {
  readonly jobId: string;
  readonly receiptId: string;
  readonly requestId: string;
  readonly planId: string;
  readonly executionDigest: string;
  readonly policyDigest: string;
  readonly recipeJson: string;
  readonly testPaths: readonly string[];
}
export interface WorkerStore {
  readonly statePath: string;
  register(input: {
    id: string; label: string; sourcePath: string; consumerRoot: string; providerBaseUrl: string; baseline: WorkerSnapshot;
    httpSource?: HttpSourcePolicy;
  }): WorkerSubscription;
  listSubscriptions(): WorkerSubscription[];
  getBaseline(subscriptionId: string): WorkerSnapshot;
  getHttpSnapshot(subscriptionId: string, lease?: WorkerLease): HttpSourceSnapshot | undefined;
  claim(subscriptionId: string): WorkerLease | null;
  completeObservation(input: { lease: WorkerLease; snapshot: WorkerSnapshot; report: ImpactReport; httpSnapshot?: HttpSourceSnapshot }): { job: WorkerJob | null; created: boolean; transition: boolean };
  failObservation(input: { lease: WorkerLease; reason: string }): void;
  listJobs(): WorkerJob[];
  getJobEvidence(jobId: string): { job: WorkerJob; subscription: WorkerSubscription; baseline: WorkerSnapshot; revision: WorkerSnapshot };
  enqueueExecution(input: EnqueueExecutionInput): { intent: ExecutionIntent; created: boolean };
  listExecutionIntents(): ExecutionIntent[];
  claimExecution(intentId?: string): ExecutionClaim | null;
  assertExecutionOwnership(claim: ExecutionClaim): void;
  completeExecution(input: { claim: ExecutionClaim; outcome: ValidationOutcome }): void;
  blockExecution(input: { claim: ExecutionClaim; reason: ExecutionBlockReason }): void;
  interruptExecution(input: { claim: ExecutionClaim; reason: 'cleanup-unresolved' }): void;
  listExpiredExecutions(): ExecutionIntent[];
  claimRecovery(intentId: string): ExecutionClaim | null;
  assertRecoveryOwnership(claim: ExecutionClaim): void;
  reconcileExecution(input: { claim: ExecutionClaim; outcome?: ValidationOutcome; reason?: ExecutionRecoveryReason }): void;
  close(): void;
}

const HASH = /^[a-f0-9]{64}$/u;
const APPLICATION_ID = 0x504c554d;
const LEASE_MS = 5 * 60 * 1000;
const EXECUTION_LEASE_MS = 10 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RECIPE_LIMIT = 1024 * 1024;
const TOTAL_RECIPE_LIMIT = 64 * 1024 * 1024;
const BLOCK_REASONS = new Set<ExecutionBlockReason>(['stale-evidence', 'approval-invalid', 'execution-failed', 'request-mismatch']);
const RECOVERY_REASONS = new Set<ExecutionRecoveryReason>(['execution-interrupted', 'cleanup-unresolved', 'invalid-outcome']);
const SNAPSHOT_LIMIT = 4 * 1024 * 1024;
const TOTAL_SNAPSHOT_LIMIT = 64 * 1024 * 1024;
const REPORT_LIMIT = 4 * 1024 * 1024;
const TOTAL_REPORT_LIMIT = 64 * 1024 * 1024;
const REASONS = new Set(['source-unavailable', 'consumer-unavailable', 'invalid-contract', 'unsupported-contract', 'analysis-failed', 'consumer-changed', 'state-limit',
  'http-not-enabled', 'http-invalid-policy', 'http-authorization-required', 'http-cache-mismatch', 'http-address-denied', 'http-dns-failed',
  'http-request-failed', 'http-deadline-exceeded', 'http-aborted', 'http-redirect-denied', 'http-http-status', 'http-compressed-response',
  'http-response-too-large', 'http-invalid-response', 'http-invalid-content']);
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
    httpSource: row.http_source_json === null ? null : prepareHttpSource(JSON.parse(row.http_source_json as string)),
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

function canonicalRecipe(json: string): string {
  if (typeof json !== 'string') invalid('An execution recipe must contain JSON text.');
  if (Buffer.byteLength(json) > RECIPE_LIMIT) limit('An execution recipe exceeds the 1 MiB limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { invalid('An execution recipe must contain JSON data.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('An execution recipe must be a JSON object.');
  let nodes = 0;
  const canonical = (value: unknown, depth: number): unknown => {
    if (depth > 64 || ++nodes > 100_000) invalid('An execution recipe exceeds the supported JSON structure limits.');
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('Execution recipe numbers must be finite JSON values.');
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(child => canonical(child, depth + 1));
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Row)[key], depth + 1)]));
  };
  return JSON.stringify(canonical(parsed, 0));
}

function executionTests(value: readonly string[]): string[] {
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length === 0 || value.length > 20) {
    invalid('Execution requires between 1 and 20 unique relative test paths.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid('Test paths must form a plain dense JSON array.');
  const paths: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Test paths cannot contain accessors or missing elements.');
    const path: unknown = descriptor.value;
    if (typeof path !== 'string' || !path || path.length > 500 || /[\\:\u0000-\u001f\u007f]/u.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..') || paths.includes(path)) {
      invalid('Execution test paths must be unique bounded relative paths without traversal.');
    }
    paths.push(path);
  }
  return paths;
}

function execution(row: Row): ExecutionIntent {
  return {
    id: row.id as string, jobId: row.job_id as string, receiptId: row.receipt_id as string, requestId: row.request_id as string,
    planId: row.plan_id as string, executionDigest: row.execution_digest as string, policyDigest: row.policy_digest as string,
    recipeJson: row.recipe_json as string, testPaths: JSON.parse(row.test_paths_json as string) as string[],
    status: row.status as ExecutionStatus, owner: row.owner as string | null, generation: row.generation as number,
    expiresAt: iso(row.expires_at), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
    outcome: row.outcome_json === null ? null : validateValidationOutcome(JSON.parse(row.outcome_json as string)),
    reason: row.reason as string | null,
  };
}

const EXECUTION_SCHEMA = `
CREATE TABLE execution_intents (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), receipt_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL, plan_id TEXT NOT NULL, execution_digest TEXT NOT NULL, policy_digest TEXT NOT NULL,
  recipe_json TEXT NOT NULL, test_paths_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','blocked','interrupted')),
  owner TEXT, generation INTEGER NOT NULL DEFAULT 0, expires_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, outcome_json TEXT, reason TEXT
) STRICT;
CREATE INDEX execution_intents_status ON execution_intents(status,created_at,id);`;

const SCHEMA = `
CREATE TABLE snapshots (sha TEXT PRIMARY KEY, bytes BLOB NOT NULL, metadata_json TEXT NOT NULL, captured_at INTEGER NOT NULL) STRICT;
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, source_path TEXT NOT NULL, consumer_root TEXT NOT NULL,
  provider_base_url TEXT NOT NULL, baseline_sha TEXT NOT NULL REFERENCES snapshots(sha), observed_sha TEXT REFERENCES snapshots(sha),
  created_at INTEGER NOT NULL, last_checked_at INTEGER, last_succeeded_at INTEGER, last_error TEXT,
  lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
  http_source_json TEXT, http_cache_json TEXT
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
${EXECUTION_SCHEMA}
PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=3;`;

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
    if (version() !== 0 && (![1, 2, 3].includes(version()) || application() !== APPLICATION_ID)) invalid('The worker database version or identity is unsupported.');
    if (version() < 3) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (version() === 0) {
          if (application() !== 0 || (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n as number) !== 0) {
            invalid('An existing foreign database cannot be imported as worker state.');
          }
          db.exec(SCHEMA);
        } else if (![1, 2, 3].includes(version()) || application() !== APPLICATION_ID) invalid('The worker database version or identity is unsupported.');
        if (version() === 1) {
          db.exec(EXECUTION_SCHEMA);
          db.exec('PRAGMA user_version=2');
        }
        if (version() === 2) {
          db.exec('ALTER TABLE subscriptions ADD COLUMN http_source_json TEXT; ALTER TABLE subscriptions ADD COLUMN http_cache_json TEXT; PRAGMA user_version=3;');
        }
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
    const requiredJob = (id: string): Row => {
      if (typeof id !== 'string' || !HASH.test(id)) invalid('A job identifier must be a lowercase SHA-256 value.');
      const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (!row) invalid('The worker job does not exist.');
      return row;
    };
    const capturedSnapshot = (sha: string): WorkerSnapshot => {
      const value = db.prepare('SELECT bytes,metadata_json FROM snapshots WHERE sha=?').get(sha);
      if (!value) invalid('The job snapshot does not exist.');
      const checked = snapshot({ bytes: value.bytes as Uint8Array, metadata: JSON.parse(value.metadata_json as string) as SnapshotMetadata });
      if (checked.metadata.sha256 !== sha) invalid('The job snapshot does not match its immutable reference.');
      return { bytes: Uint8Array.from(checked.bytes), metadata: checked.metadata };
    };
    const requiredExecution = (id: string): Row => {
      if (typeof id !== 'string' || !HASH.test(id)) invalid('An execution identifier must be a lowercase SHA-256 value.');
      const row = db.prepare('SELECT * FROM execution_intents WHERE id=?').get(id);
      if (!row) invalid('The execution intent does not exist.');
      return row;
    };
    const ownedExecution = (claim: ExecutionClaim, recovery = false): Row => {
      if (!claim || !claim.intent || typeof claim.owner !== 'string' || !UUID.test(claim.owner)
        || !Number.isSafeInteger(claim.generation) || claim.generation < 1) invalid('A valid execution claim is required.');
      const row = requiredExecution(claim.intent.id);
      if (row.status !== (recovery ? 'interrupted' : 'running') || (recovery && row.reason !== 'recovery-in-progress')
        || row.owner !== claim.owner || row.generation !== claim.generation || row.expires_at === null
        || (row.expires_at as number) <= Date.now()) {
        throw new PlumberError('LEASE_LOST', 'The worker no longer owns this unexpired execution phase.');
      }
      return row;
    };
    const boundOutcome = (row: Row, outcome: ValidationOutcome): string => {
      const checked = validateValidationOutcome(outcome);
      if (checked.intentId !== row.id || checked.requestId !== row.request_id || checked.receiptId !== row.receipt_id) {
        invalid('The validation outcome does not match the execution intent.');
      }
      return JSON.stringify(checked);
    };
    const recoverable = (row: Row, now: number): boolean => (
      row.status === 'running' && row.expires_at !== null && (row.expires_at as number) <= now
    ) || (
      row.status === 'interrupted' && ((row.reason === 'cleanup-unresolved' && row.owner === null)
        || (row.reason === 'recovery-in-progress' && row.expires_at !== null && (row.expires_at as number) <= now))
    );
    const makeClaim = (row: Row, recovery: boolean): ExecutionClaim => {
      const now = Date.now();
      const owner = randomUUID();
      const generation = (row.generation as number) + 1;
      db.prepare('UPDATE execution_intents SET status=?,owner=?,generation=?,expires_at=?,updated_at=?,reason=? WHERE id=?')
        .run(recovery ? 'interrupted' : 'running', owner, generation, now + (recovery ? LEASE_MS : EXECUTION_LEASE_MS), now,
          recovery ? 'recovery-in-progress' : null, row.id as string);
      return { intent: execution(requiredExecution(row.id as string)), owner, generation };
    };
    return {
      statePath: state,
      register(input) { return transaction(() => {
        if (!input || typeof input.id !== 'string' || !HASH.test(input.id) || typeof input.label !== 'string' || !input.label.trim()
          || Buffer.byteLength(input.label) > 200) invalid('Subscriptions require an identifier and a bounded nonempty label.');
        const baseline = snapshot(input.baseline);
        const httpSource = input.httpSource === undefined ? null : prepareHttpSource(input.httpSource);
        if (httpSource && (httpSource.contentKind !== 'json' || httpSource.url !== input.sourcePath)) invalid('HTTP worker sources must be JSON policies bound to their exact URL.');
        const httpSourceJson = httpSource === null ? null : JSON.stringify(httpSource);
        if (httpSourceJson !== null && Buffer.byteLength(httpSourceJson) > 16 * 1024) invalid('HTTP source policy exceeds the durable 16 KiB metadata budget.');
        const sourcePath = httpSource === null ? localPath(input.sourcePath) : httpSource.url;
        const consumerRoot = directoryPath(localPath(input.consumerRoot));
        if (nested(state, consumerRoot) || nested(consumerRoot, state)) invalid('Worker state must be outside the consumer directory and cannot contain it.');
        let provider: URL;
        try { provider = new URL(input.providerBaseUrl); } catch { invalid('An absolute HTTP(S) provider URL is required.'); }
        if (!['http:', 'https:'].includes(provider.protocol) || provider.username || provider.password || provider.search || provider.hash) invalid('Provider bindings must not contain credentials, queries, or fragments.');
        const providerBaseUrl = `${provider.origin}${provider.pathname.replace(/\/$/u, '')}`;
        const existing = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(input.id);
        if (existing) {
          if (existing.label !== input.label || existing.source_path !== sourcePath || existing.consumer_root !== consumerRoot
            || existing.provider_base_url !== providerBaseUrl || existing.baseline_sha !== baseline.metadata.sha256
            || existing.http_source_json !== httpSourceJson) invalid('An existing subscription configuration is immutable.');
          saveSnapshot(baseline);
          return subscription(existing);
        }
        if ((db.prepare('SELECT count(*) AS n FROM subscriptions').get()!.n as number) >= 100) limit('Worker subscriptions exceed the limit of 100.');
        saveSnapshot(baseline);
        db.prepare('INSERT INTO subscriptions (id,label,source_path,consumer_root,provider_base_url,baseline_sha,created_at,http_source_json) VALUES (?,?,?,?,?,?,?,?)')
          .run(input.id, input.label, sourcePath, consumerRoot, providerBaseUrl, baseline.metadata.sha256, Date.now(), httpSourceJson);
        return subscription(required(input.id));
      }); },
      listSubscriptions() { return operate(() => db.prepare('SELECT * FROM subscriptions ORDER BY id').all().map(subscription)); },
      getBaseline(subscriptionId) { return operate(() => {
        const current = required(subscriptionId);
        const value = db.prepare('SELECT bytes, metadata_json FROM snapshots WHERE sha=?').get(current.baseline_sha as string)!;
        const checked = snapshot({ bytes: value.bytes as Uint8Array, metadata: JSON.parse(value.metadata_json as string) as SnapshotMetadata });
        return { bytes: Uint8Array.from(checked.bytes), metadata: checked.metadata };
      }); },
      getHttpSnapshot(subscriptionId, lease) { return operate(() => {
        if (lease && lease.subscriptionId !== subscriptionId) invalid('HTTP cache lookup requires the matching subscription lease.');
        const current = lease ? owned(lease) : required(subscriptionId);
        if (current.http_source_json === null) invalid('This subscription has no HTTP capture policy.');
        const source = prepareHttpSource(JSON.parse(current.http_source_json as string));
        if (source.url !== current.source_path) invalid('HTTP cache policy no longer matches the registered source URL.');
        if (current.http_cache_json === null) {
          if (current.observed_sha !== null) invalid('HTTP source history is missing its conditional capture evidence.');
          return undefined;
        }
        const cache: unknown = JSON.parse(current.http_cache_json as string);
        if (!cache || typeof cache !== 'object' || Array.isArray(cache) || !('sha256' in cache) || cache.sha256 !== current.observed_sha) {
          invalid('HTTP cache evidence does not match the last successfully observed source.');
        }
        const captured = capturedSnapshot(current.observed_sha as string);
        return validateHttpSourceSnapshot(source, { ...cache, bytes: captured.bytes });
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
      completeObservation({ lease, snapshot: observed, report, httpSnapshot }) { return transaction(() => {
        const current = owned(lease);
        const value = snapshot(observed);
        let httpCacheJson: string | null = null;
        if (current.http_source_json !== null) {
          const source = prepareHttpSource(JSON.parse(current.http_source_json as string));
          const capture = validateHttpSourceSnapshot(source, httpSnapshot);
          if (source.url !== current.source_path || capture.sha256 !== value.metadata.sha256 || !Buffer.from(capture.bytes).equals(value.bytes)) {
            invalid('HTTP capture metadata does not match the exact compared snapshot.');
          }
          const { bytes: _bytes, ...cache } = capture;
          httpCacheJson = JSON.stringify(cache);
          if (Buffer.byteLength(httpCacheJson) > 16 * 1024) invalid('HTTP capture metadata exceeds the durable cache budget.');
        } else if (httpSnapshot !== undefined) invalid('Local subscriptions cannot import HTTP capture metadata.');
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
        db.prepare('UPDATE subscriptions SET observed_sha=?,last_checked_at=?,last_succeeded_at=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL,http_cache_json=? WHERE id=?')
          .run(value.metadata.sha256, now, now, httpCacheJson, lease.subscriptionId);
        return { job: output, created, transition };
      }); },
      failObservation({ lease, reason }) { transaction(() => {
        owned(lease);
        if (!REASONS.has(reason)) invalid('Observation failures require a supported fixed reason.');
        db.prepare('UPDATE subscriptions SET last_checked_at=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?').run(Date.now(), reason, lease.subscriptionId);
      }); },
      listJobs() { return operate(() => db.prepare('SELECT * FROM jobs ORDER BY created_at,id').all().map(job)); },
      getJobEvidence(jobId) { return operate(() => {
        const current = requiredJob(jobId);
        return { job: job(current), subscription: subscription(required(current.subscription_id as string)),
          baseline: capturedSnapshot(current.baseline_sha as string), revision: capturedSnapshot(current.revision_sha as string) };
      }); },
      enqueueExecution(input) { return transaction(() => {
        if (!input || [input.jobId, input.requestId, input.planId, input.executionDigest, input.policyDigest]
          .some(value => typeof value !== 'string' || !HASH.test(value)) || typeof input.receiptId !== 'string' || !UUID.test(input.receiptId)) {
          invalid('Execution intents require valid immutable evidence and approval identifiers.');
        }
        requiredJob(input.jobId);
        const recipeJson = canonicalRecipe(input.recipeJson);
        const testPaths = JSON.stringify(executionTests(input.testPaths));
        const id = hash(input.receiptId);
        const existing = db.prepare('SELECT * FROM execution_intents WHERE receipt_id=?').get(input.receiptId);
        if (existing) {
          if (existing.id !== id || existing.job_id !== input.jobId || existing.request_id !== input.requestId || existing.plan_id !== input.planId
            || existing.execution_digest !== input.executionDigest || existing.policy_digest !== input.policyDigest
            || existing.recipe_json !== recipeJson || existing.test_paths_json !== testPaths) {
            invalid('An approval receipt cannot be queued with different evidence or execution inputs.');
          }
          return { intent: execution(existing), created: false };
        }
        if ((db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n as number) >= 1000) limit('Execution intents exceed the limit of 1000.');
        const used = db.prepare('SELECT coalesce(sum(length(CAST(recipe_json AS BLOB))),0) AS n FROM execution_intents').get()!.n as number;
        if (used + Buffer.byteLength(recipeJson) > TOTAL_RECIPE_LIMIT) limit('Execution recipes exceed the total 64 MiB limit.');
        const now = Date.now();
        db.prepare(`INSERT INTO execution_intents
          (id,job_id,receipt_id,request_id,plan_id,execution_digest,policy_digest,recipe_json,test_paths_json,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, input.jobId, input.receiptId, input.requestId, input.planId,
          input.executionDigest, input.policyDigest, recipeJson, testPaths, now, now);
        return { intent: execution(requiredExecution(id)), created: true };
      }); },
      listExecutionIntents() { return operate(() => db.prepare('SELECT * FROM execution_intents ORDER BY created_at,id').all().map(execution)); },
      claimExecution(intentId) { return transaction(() => {
        const row = intentId === undefined
          ? db.prepare("SELECT * FROM execution_intents WHERE status='queued' ORDER BY created_at,id LIMIT 1").get()
          : requiredExecution(intentId);
        return row && row.status === 'queued' ? makeClaim(row, false) : null;
      }); },
      assertExecutionOwnership(claim) { operate(() => { ownedExecution(claim); }); },
      completeExecution({ claim, outcome }) { transaction(() => {
        const row = ownedExecution(claim);
        const json = boundOutcome(row, outcome);
        const checked = JSON.parse(json) as ValidationOutcome;
        if (checked.baseline.cleanup === 'failed' || checked.candidate?.cleanup === 'failed') {
          invalid('Unresolved cleanup requires recovery before the execution can be completed.');
        }
        ownedExecution(claim);
        db.prepare("UPDATE execution_intents SET status='completed',outcome_json=?,owner=NULL,expires_at=NULL,reason=NULL,updated_at=? WHERE id=?")
          .run(json, Date.now(), row.id as string);
      }); },
      blockExecution({ claim, reason }) { transaction(() => {
        const row = ownedExecution(claim);
        if (!BLOCK_REASONS.has(reason)) invalid('Execution failures require a supported fixed reason.');
        db.prepare("UPDATE execution_intents SET status='blocked',owner=NULL,expires_at=NULL,reason=?,updated_at=? WHERE id=?")
          .run(reason, Date.now(), row.id as string);
      }); },
      interruptExecution({ claim, reason }) { transaction(() => {
        const row = ownedExecution(claim);
        if (reason !== 'cleanup-unresolved') invalid('An interrupted execution must preserve its unresolved cleanup state.');
        db.prepare("UPDATE execution_intents SET status='interrupted',owner=NULL,expires_at=NULL,reason=?,updated_at=? WHERE id=?")
          .run(reason, Date.now(), row.id as string);
      }); },
      listExpiredExecutions() { return operate(() => {
        const now = Date.now();
        return db.prepare("SELECT * FROM execution_intents WHERE status IN ('running','interrupted') ORDER BY created_at,id")
          .all().filter(row => recoverable(row, now)).map(execution);
      }); },
      claimRecovery(intentId) { return transaction(() => {
        const row = requiredExecution(intentId);
        // A terminal interruption may receive a late artifact from its original consumed attempt; it can only be reconciled.
        const lateArtifactEligible = row.status === 'interrupted' && row.owner === null
          && (row.reason === 'execution-interrupted' || row.reason === 'invalid-outcome');
        return recoverable(row, Date.now()) || lateArtifactEligible ? makeClaim(row, true) : null;
      }); },
      assertRecoveryOwnership(claim) { operate(() => { ownedExecution(claim, true); }); },
      reconcileExecution({ claim, outcome, reason }) { transaction(() => {
        const row = ownedExecution(claim, true);
        if ((outcome === undefined) === (reason === undefined)) invalid('Recovery requires exactly one matching outcome or fixed interruption reason.');
        if (outcome !== undefined) {
          const json = boundOutcome(row, outcome);
          ownedExecution(claim, true);
          db.prepare("UPDATE execution_intents SET status='completed',outcome_json=?,owner=NULL,expires_at=NULL,reason=NULL,updated_at=? WHERE id=?")
            .run(json, Date.now(), row.id as string);
        } else {
          if (!RECOVERY_REASONS.has(reason!)) invalid('Recovery requires a supported fixed interruption reason.');
          db.prepare("UPDATE execution_intents SET status='interrupted',owner=NULL,expires_at=NULL,reason=?,updated_at=? WHERE id=?")
            .run(reason!, Date.now(), row.id as string);
        }
      }); },
      close() { if (!closed) { operate(() => db.close()); closed = true; } },
    };
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original state-opening failure. */ }
    if (error instanceof PlumberError) throw error;
    invalid('Could not open worker state as a local SQLite database.');
  }
}
