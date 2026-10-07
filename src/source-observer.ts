import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isProxy } from 'node:util/types';
import { PlumberError } from './errors.js';
import { readLocalBytes } from './local-file.js';
import { compareMcpCatalogs, type McpComparisonReport } from './mcp-catalog.js';
import { compareJsonExamples, compareJsonSchemas, type JsonExampleComparison, type JsonSchemaComparison } from './json-schema.js';
import { openWorkerStore } from './worker-store.js';
import { withContractCopies } from './worker.js';
import { captureHttpSource, prepareHttpSource, validateHttpSourceSnapshot, type HttpSourcePolicy, type HttpSourceSnapshot, type HttpSourceCredentials, type HttpSourceDependencies } from './http-source.js';

export type ObservableSourceKind = 'mcp' | 'json-schema' | 'json-example' | 'documentation';
export type SourceObservationFailure = 'source-unavailable' | 'invalid-source' | 'unsupported-source' | 'comparison-failed' |
  'state-limit' | 'lease-lost' | 'state-unavailable' | 'http-not-enabled';
export interface SourceSubscriptionOptions {
  readonly statePath: string;
  readonly kind: ObservableSourceKind;
  readonly sourcePath: string;
  readonly baselinePath: string;
  readonly consumerRoot?: string;
  readonly direction?: 'input' | 'output';
  readonly normalizeLineEndings?: boolean;
  readonly label?: string;
}
export interface SourceSubscription {
  readonly id: string;
  readonly kind: ObservableSourceKind;
  readonly label: string;
  readonly sourcePath: string;
  readonly httpSource: HttpSourcePolicy | null;
  readonly consumerRoot: string | null;
  readonly direction: 'input' | 'output' | null;
  readonly normalizeLineEndings: boolean;
  readonly configuredBaselineSha: string;
  readonly lastObservedSha: string | null;
  readonly lastObservationId: string | null;
  readonly createdAt: string;
  readonly lastCheckedAt: string | null;
  readonly lastSucceededAt: string | null;
  readonly lastError: SourceObservationFailure | null;
  readonly consumerImpact: 'not-analyzed';
  readonly adopted: 'unknown';
  readonly deployed: 'unknown';
}
export interface HttpSourceSubscriptionOptions extends Omit<SourceSubscriptionOptions, 'sourcePath'> {
  readonly source: HttpSourcePolicy;
}
export interface ObserveSourcesOptions {
  readonly statePath: string;
  readonly subscriptionId?: string;
  readonly allowHttp?: boolean;
  readonly httpCredentials?: (source: HttpSourcePolicy) => HttpSourceCredentials | undefined;
  readonly httpDependencies?: HttpSourceDependencies;
  readonly signal?: AbortSignal;
}
export interface DocumentationComparison {
  readonly schemaVersion: 1;
  readonly kind: 'documentation-comparison';
  readonly base: { readonly sha256: string; readonly textDigest: string };
  readonly revision: { readonly sha256: string; readonly textDigest: string };
  readonly contentChanged: boolean;
  readonly textChanged: boolean;
  readonly normalization: 'none' | 'line-endings';
  readonly status: 'changed' | 'unchanged';
  readonly compatibility: 'not-established';
  readonly consumerImpact: 'not-analyzed';
  readonly limitations: readonly string[];
}
export type SourceComparison = McpComparisonReport | JsonSchemaComparison | JsonExampleComparison | DocumentationComparison;
export interface SourceObservation {
  readonly id: string;
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly kind: ObservableSourceKind;
  readonly baselineSha: string;
  readonly fromSha: string | null;
  readonly toSha: string;
  readonly observedAt: string;
  readonly report: SourceComparison;
  readonly consumerImpact: 'not-analyzed';
  readonly authorization: 'not-granted';
}
export interface SourceObservationCycle {
  readonly schemaVersion: 1;
  readonly aborted?: true;
  readonly results: readonly {
    readonly subscriptionId: string;
    readonly status: 'observed' | 'unchanged' | 'busy' | 'failed';
    readonly observationId?: string;
    readonly created?: boolean;
    readonly reason?: SourceObservationFailure;
  }[];
}

type Row = Record<string, unknown>;
interface SourceLease { readonly id: string; readonly owner: string; readonly generation: number }
const FILE_NAME = 'source-observations.sqlite3';
const APPLICATION_ID = 0x504c5352;
const MAXIMUM_BYTES = 4 * 1024 * 1024;
const TOTAL_BYTES = 64 * 1024 * 1024;
const LEASE_MS = 5 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/u;
const SCHEMA = `
CREATE TABLE source_snapshots (sha TEXT PRIMARY KEY, bytes BLOB NOT NULL) STRICT;
CREATE TABLE source_subscriptions (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, source_path TEXT NOT NULL, consumer_root TEXT,
 http_policy_json TEXT, http_cache_json TEXT,
 direction TEXT, normalize_lines INTEGER NOT NULL, baseline_sha TEXT NOT NULL REFERENCES source_snapshots(sha),
 observed_sha TEXT REFERENCES source_snapshots(sha), last_observation_id TEXT, sequence INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, last_checked_at INTEGER, last_succeeded_at INTEGER, last_error TEXT,
 lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER
) STRICT;
CREATE TABLE source_observations (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES source_subscriptions(id), sequence INTEGER NOT NULL,
 kind TEXT NOT NULL, baseline_sha TEXT NOT NULL REFERENCES source_snapshots(sha), from_sha TEXT REFERENCES source_snapshots(sha),
 to_sha TEXT NOT NULL REFERENCES source_snapshots(sha), observed_at INTEGER NOT NULL, report_json TEXT NOT NULL,
 UNIQUE(subscription_id, sequence)
) STRICT;
PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=2;`;

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function limit(message: string): never { throw new PlumberError('STATE_LIMIT', message); }
function hash(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : undefined; }
function iso(value: unknown): string | null { return value === null ? null : new Date(value as number).toISOString(); }
function localDirectoryInput(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value === '-' || /[\u0000-\u001f\u007f]/u.test(value) || /^[\\/]{2}/u.test(value)) {
    invalid('Source state and consumer roots must identify local directories.');
  }
  const tail = process.platform === 'win32' && /^[a-z]:[\\/]/iu.test(value) ? value.slice(2) : value;
  if (tail.includes(':') || /(?:^|[\\/])(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/iu.test(value)) {
    invalid('Remote, device, and alternate-stream directory paths are unsupported.');
  }
  return resolve(value);
}
function contains(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}
function outsideConsumer(statePath: string, consumerRoot: string | undefined | null): void {
  if (consumerRoot !== undefined && consumerRoot !== null &&
    (contains(resolve(statePath), resolve(consumerRoot)) || contains(resolve(consumerRoot), resolve(statePath)))) {
    invalid('Source observer state must be outside the consumer directory and cannot contain it.');
  }
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid('A source subscription identifier must be a lowercase SHA-256 digest.');
}
function subscription(row: Row): SourceSubscription {
  return { id: row.id as string, kind: row.kind as ObservableSourceKind, label: row.label as string, sourcePath: row.source_path as string,
    httpSource: row.http_policy_json === null ? null : prepareHttpSource(JSON.parse(row.http_policy_json as string)),
    consumerRoot: row.consumer_root as string | null, direction: row.direction as SourceSubscription['direction'],
    normalizeLineEndings: row.normalize_lines === 1, configuredBaselineSha: row.baseline_sha as string,
    lastObservedSha: row.observed_sha as string | null, lastObservationId: row.last_observation_id as string | null,
    createdAt: iso(row.created_at)!, lastCheckedAt: iso(row.last_checked_at), lastSucceededAt: iso(row.last_succeeded_at),
    lastError: row.last_error as SourceObservationFailure | null, consumerImpact: 'not-analyzed', adopted: 'unknown', deployed: 'unknown' };
}
function observation(row: Row): SourceObservation {
  return { id: row.id as string, subscriptionId: row.subscription_id as string, sequence: row.sequence as number,
    kind: row.kind as ObservableSourceKind, baselineSha: row.baseline_sha as string, fromSha: row.from_sha as string | null,
    toSha: row.to_sha as string, observedAt: iso(row.observed_at)!, report: JSON.parse(row.report_json as string) as SourceComparison,
    consumerImpact: 'not-analyzed', authorization: 'not-granted' };
}

async function openSourceStore(statePath: string, existing = true) {
  let database: DatabaseSync | undefined;
  try {
    statePath = localDirectoryInput(statePath);
    if (existing) {
      const attributes = await lstat(join(statePath, FILE_NAME));
      if (!attributes.isFile() || attributes.isSymbolicLink()) invalid('Register a source in regular local state before observing it.');
    }
    const worker = await openWorkerStore(statePath);
    const state = worker.statePath;
    worker.close();
    const databasePath = join(state, FILE_NAME);
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        const attributes = lstatSync(`${databasePath}${suffix}`);
        if (attributes.isSymbolicLink() || !attributes.isFile() ||
          (process.platform !== 'win32' && (attributes.mode & 0o077) !== 0)) invalid('Source database files must be regular private local files.');
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    if (existing && !lstatSync(databasePath).isFile()) invalid('Register a source before observing it.');
    try { closeSync(openSync(databasePath, 'wx', 0o600)); }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath, { timeout: 1000, allowExtension: false,
      enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    database = db;
    const app = (): number => db.prepare('PRAGMA application_id').get()!.application_id as number;
    const version = (): number => db.prepare('PRAGMA user_version').get()!.user_version as number;
    if (version() !== 0 && (![1, 2].includes(version()) || app() !== APPLICATION_ID)) invalid('The source observer database has an unsupported identity or version.');
    if (version() === 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (version() === 0) {
          if (app() !== 0 || db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n !== 0) {
            invalid('An existing foreign database cannot be used as source observer state.');
          }
          db.exec(SCHEMA);
        } else if (![1, 2].includes(version()) || app() !== APPLICATION_ID) invalid('The source observer database has an unsupported identity or version.');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (version() === 1) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (version() === 1 && app() === APPLICATION_ID) {
          db.exec('ALTER TABLE source_subscriptions ADD COLUMN http_policy_json TEXT; ALTER TABLE source_subscriptions ADD COLUMN http_cache_json TEXT; PRAGMA user_version=2;');
        } else if (version() !== 2 || app() !== APPLICATION_ID) invalid('The source observer database has an unsupported identity or version.');
        db.exec('COMMIT');
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    }
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    const transaction = <T>(action: () => T): T => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = action(); db.exec('COMMIT'); return result; }
      catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    };
    const required = (id: string): Row => {
      identifier(id);
      const row = db.prepare('SELECT * FROM source_subscriptions WHERE id=?').get(id);
      if (!row) invalid('The selected source subscription does not exist.');
      return row;
    };
    const checkBudget = (additional: number): void => {
      const snapshotBytes = db.prepare('SELECT coalesce(sum(length(bytes)),0) AS n FROM source_snapshots').get()!.n as number;
      const reportBytes = db.prepare('SELECT coalesce(sum(length(CAST(report_json AS BLOB))),0) AS n FROM source_observations').get()!.n as number;
      if (snapshotBytes + reportBytes + additional > TOTAL_BYTES) limit('Source snapshots and reports exceed the total 64 MiB limit.');
    };
    const saveSnapshot = (bytes: Uint8Array): string => {
      if (bytes.byteLength > MAXIMUM_BYTES) limit('A source snapshot exceeds 4 MiB.');
      const digest = hash(bytes);
      const current = db.prepare('SELECT bytes FROM source_snapshots WHERE sha=?').get(digest);
      if (current) {
        if (!Buffer.from(current.bytes as Uint8Array).equals(bytes)) invalid('Stored source evidence no longer matches its digest.');
      } else {
        checkBudget(bytes.byteLength);
        db.prepare('INSERT INTO source_snapshots VALUES (?,?)').run(digest, bytes);
      }
      return digest;
    };
    const owned = (lease: SourceLease): Row => {
      const row = required(lease.id);
      if (row.lease_owner !== lease.owner || row.lease_generation !== lease.generation || (row.lease_expires_at as number) <= Date.now()) {
        throw new PlumberError('LEASE_LOST', 'Source observation ownership expired or was replaced.');
      }
      return row;
    };
    return {
      statePath: state,
      list() { return db.prepare('SELECT * FROM source_subscriptions ORDER BY id').all().map(subscription); },
      listObservations(id?: string) {
        if (id !== undefined) required(id);
        return (id === undefined ? db.prepare('SELECT * FROM source_observations ORDER BY observed_at,subscription_id,sequence').all()
          : db.prepare('SELECT * FROM source_observations WHERE subscription_id=? ORDER BY sequence').all(id)).map(observation);
      },
      register(input: { id: string; kind: ObservableSourceKind; label: string; sourcePath: string; consumerRoot: string | null;
        direction: SourceSubscription['direction']; normalizeLineEndings: boolean; baseline: Uint8Array; httpSource: HttpSourcePolicy | null }) {
        return transaction(() => {
          const existingRow = db.prepare('SELECT * FROM source_subscriptions WHERE id=?').get(input.id);
          if (existingRow) {
            if (existingRow.baseline_sha !== hash(input.baseline) || existingRow.label !== input.label) {
              invalid('An existing source subscription cannot silently replace its baseline or label.');
            }
            saveSnapshot(input.baseline);
            return subscription(existingRow);
          }
          if ((db.prepare('SELECT count(*) AS n FROM source_subscriptions').get()!.n as number) >= 100) limit('Source subscriptions exceed the limit of 100.');
          const baseline = saveSnapshot(input.baseline);
          db.prepare(`INSERT INTO source_subscriptions
            (id,kind,label,source_path,consumer_root,direction,normalize_lines,baseline_sha,created_at,http_policy_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(input.id, input.kind, input.label, input.sourcePath, input.consumerRoot, input.direction,
              input.normalizeLineEndings ? 1 : 0, baseline, Date.now(), input.httpSource === null ? null : JSON.stringify(input.httpSource));
          return subscription(required(input.id));
        });
      },
      claim(id: string): SourceLease | null {
        return transaction(() => {
          const row = required(id);
          if (row.lease_owner !== null && (row.lease_expires_at as number) > Date.now()) return null;
          const generation = (row.lease_generation as number) + 1;
          if (!Number.isSafeInteger(generation)) invalid('The source observation lease generation is invalid.');
          const owner = randomUUID();
          db.prepare('UPDATE source_subscriptions SET lease_owner=?,lease_generation=?,lease_expires_at=? WHERE id=?')
            .run(owner, generation, Date.now() + LEASE_MS, id);
          return { id, owner, generation };
        });
      },
      baseline(id: string): Buffer {
        const row = required(id);
        const snapshot = db.prepare('SELECT bytes FROM source_snapshots WHERE sha=?').get(row.baseline_sha as string);
        if (!snapshot) invalid('The configured source baseline is unavailable.');
        const bytes = Buffer.from(snapshot.bytes as Uint8Array);
        if (bytes.length > MAXIMUM_BYTES || hash(bytes) !== row.baseline_sha) invalid('The immutable source baseline no longer matches its digest.');
        return bytes;
      },
      httpCache(lease: SourceLease): HttpSourceSnapshot | undefined {
        const row = owned(lease);
        if (row.http_cache_json === null) {
          if (row.observed_sha !== null) invalid('HTTP source history is missing its conditional capture evidence.');
          return undefined;
        }
        if (row.http_policy_json === null || row.observed_sha === null) invalid('HTTP cache is missing its source or observation.');
        const snapshot = db.prepare('SELECT bytes FROM source_snapshots WHERE sha=?').get(row.observed_sha as string);
        if (!snapshot) invalid('HTTP cache bytes are unavailable.');
        const bytes = Buffer.from(snapshot.bytes as Uint8Array);
        if (bytes.length > MAXIMUM_BYTES || hash(bytes) !== row.observed_sha) invalid('HTTP cache evidence no longer matches its digest.');
        const source = subscription(row).httpSource!;
        if (source.url !== row.source_path) invalid('HTTP cache policy does not match the registered source URL.');
        return validateHttpSourceSnapshot(source, { ...JSON.parse(row.http_cache_json as string), bytes });
      },
      complete(lease: SourceLease, bytes: Uint8Array, report: SourceComparison, httpSnapshot?: HttpSourceSnapshot) {
        const reportJson = JSON.stringify(report);
        if (Buffer.byteLength(reportJson) > MAXIMUM_BYTES) limit('A source comparison report exceeds 4 MiB.');
        return transaction(() => {
          const row = owned(lease);
          const digest = hash(bytes);
          if ((row.http_policy_json !== null) !== (httpSnapshot !== undefined)) invalid('Observation transport does not match the registered source.');
          if (httpSnapshot !== undefined) {
            httpSnapshot = validateHttpSourceSnapshot(subscription(row).httpSource!, httpSnapshot);
            if (httpSnapshot.sha256 !== digest || !Buffer.from(httpSnapshot.bytes).equals(bytes)) invalid('HTTP cache metadata does not match the compared evidence.');
          }
          if (report.base.sha256 !== row.baseline_sha || report.revision.sha256 !== digest) invalid('Source comparison evidence does not match its snapshots.');
          const changed = row.observed_sha !== digest;
          let id = row.last_observation_id as string | null;
          if (changed) {
            if ((db.prepare('SELECT count(*) AS n FROM source_observations').get()!.n as number) >= 1000) limit('Source observations exceed the limit of 1000.');
            saveSnapshot(bytes);
            checkBudget(Buffer.byteLength(reportJson));
            const sequence = (row.sequence as number) + 1;
            id = hash(JSON.stringify([row.id, sequence, row.baseline_sha, row.observed_sha, digest]));
            db.prepare('INSERT INTO source_observations VALUES (?,?,?,?,?,?,?,?,?)')
              .run(id, lease.id, sequence, row.kind as string, row.baseline_sha as string, row.observed_sha as string | null,
                digest, Date.now(), reportJson);
            db.prepare('UPDATE source_subscriptions SET observed_sha=?,last_observation_id=?,sequence=? WHERE id=?')
              .run(digest, id, sequence, lease.id);
          }
          const now = Date.now();
          const cache = httpSnapshot === undefined ? null : JSON.stringify({ ...httpSnapshot, bytes: undefined });
          if (cache !== null && Buffer.byteLength(cache) > 16 * 1024) limit('HTTP cache metadata exceeds its limit.');
          owned(lease);
          db.prepare(`UPDATE source_subscriptions SET last_checked_at=?,last_succeeded_at=?,last_error=NULL,
            lease_owner=NULL,lease_expires_at=NULL,http_cache_json=? WHERE id=?`).run(now, now, cache, lease.id);
          return { id: id!, changed };
        });
      },
      fail(lease: SourceLease, reason: SourceObservationFailure) {
        transaction(() => {
          owned(lease);
          db.prepare('UPDATE source_subscriptions SET last_checked_at=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?')
            .run(Date.now(), reason, lease.id);
        });
      },
      close() { db.close(); },
    };
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original opening failure. */ }
    if (error instanceof PlumberError) throw error;
    invalid('Could not open source observation state as a local SQLite database.');
  }
}

function documentationReport(base: Uint8Array, revision: Uint8Array, normalize: boolean): DocumentationComparison {
  const digest = (bytes: Uint8Array): string => {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { invalid('Documentation must be valid UTF-8 text.'); }
    if (text.includes('\0')) invalid('Documentation must not contain null bytes.');
    return hash(normalize ? text.replace(/\r\n?/gu, '\n') : text);
  };
  const baseDigest = digest(base);
  const revisionDigest = digest(revision);
  return { schemaVersion: 1, kind: 'documentation-comparison', base: { sha256: hash(base), textDigest: baseDigest },
    revision: { sha256: hash(revision), textDigest: revisionDigest }, contentChanged: hash(base) !== hash(revision),
    textChanged: baseDigest !== revisionDigest, normalization: normalize ? 'line-endings' : 'none',
    status: baseDigest === revisionDigest ? 'unchanged' : 'changed', compatibility: 'not-established', consumerImpact: 'not-analyzed',
    limitations: ['Documentation changes are evidence only; they do not establish deployed behavior, breaking compatibility, or migration instructions.',
      'Text is compared without rendering Markdown, following links, or executing examples.'] };
}
async function compareSource(statePath: string, configured: Pick<SourceSubscription, 'kind' | 'direction' | 'normalizeLineEndings'>,
  baseline: Uint8Array, revision: Uint8Array): Promise<SourceComparison> {
  if (configured.kind === 'documentation') return documentationReport(baseline, revision, configured.normalizeLineEndings);
  return withContractCopies(statePath, baseline, revision, async paths => {
    if (configured.kind === 'mcp') return compareMcpCatalogs(paths);
    if (configured.kind === 'json-example') return compareJsonExamples(paths);
    if (configured.kind === 'json-schema' && (configured.direction === 'input' || configured.direction === 'output')) {
      return compareJsonSchemas({ ...paths, direction: configured.direction });
    }
    invalid('The source kind or comparison direction is unsupported.');
  });
}

/** Register local evidence. Source paths are read-only; registration neither imports applications nor contacts providers. */
export async function registerSourceSubscription(options: SourceSubscriptionOptions): Promise<SourceSubscription> {
  return registerSource(options, null);
}

/** Register a policy and a local baseline without DNS, credentials or provider requests. */
export async function registerHttpSourceSubscription(options: HttpSourceSubscriptionOptions): Promise<SourceSubscription> {
  const source = prepareHttpSource(options.source);
  if ((options.kind === 'documentation' ? 'text' : 'json') !== source.contentKind || Buffer.byteLength(JSON.stringify(source)) > 16 * 1024) {
    invalid('HTTP content kind must match the source profile, within the 16 KiB policy budget.');
  }
  return registerSource({ ...options, sourcePath: source.url }, source);
}

async function registerSource(options: SourceSubscriptionOptions, httpSource: HttpSourcePolicy | null): Promise<SourceSubscription> {
  options = { ...options };
  const statePath = localDirectoryInput(options.statePath);
  const consumerInput = options.consumerRoot === undefined ? undefined : localDirectoryInput(options.consumerRoot);
  if (!['mcp', 'json-schema', 'json-example', 'documentation'].includes(options.kind)) invalid('Select a supported local source kind.');
  if ((options.kind === 'json-schema') !== (options.direction === 'input' || options.direction === 'output') ||
    (options.kind !== 'json-schema' && options.direction !== undefined)) invalid('Only JSON schemas require an explicit input or output comparison direction.');
  if ((options.normalizeLineEndings !== undefined && typeof options.normalizeLineEndings !== 'boolean') ||
    (options.kind !== 'documentation' && options.normalizeLineEndings !== undefined)) invalid('Line-ending normalization is an explicit documentation-only option.');
  if (options.kind === 'documentation' && (httpSource === null ? [options.sourcePath, options.baselinePath] : [options.baselinePath]).some(path => !['.md', '.txt'].includes(extname(path).toLowerCase()))) {
    invalid('Local documentation sources must be .md or .txt files.');
  }
  outsideConsumer(statePath, consumerInput);
  const label = options.label ?? `${options.kind} source`;
  if (typeof label !== 'string' || !label.trim() || /[\u0000-\u001f\u007f]/u.test(label) || Buffer.byteLength(label) > 200) invalid('Source labels must be nonempty bounded text.');
  const baseline = await readLocalBytes(options.baselinePath, MAXIMUM_BYTES);
  if (httpSource === null) await readLocalBytes(options.sourcePath, MAXIMUM_BYTES);
  const sourcePath = httpSource === null ? await realpath(options.sourcePath) : httpSource.url;
  let consumerRoot: string | null = null;
  if (consumerInput !== undefined) {
    const attributes = await lstat(consumerInput);
    if (!attributes.isDirectory() || attributes.isSymbolicLink()) invalid('The optional consumer root must be a regular local directory.');
    consumerRoot = await realpath(consumerInput);
    outsideConsumer(statePath, consumerRoot);
  }
  const store = await openSourceStore(statePath, false);
  try {
    outsideConsumer(store.statePath, consumerRoot);
    const configured = { kind: options.kind, direction: options.direction ?? null, normalizeLineEndings: options.normalizeLineEndings ?? false };
    await compareSource(store.statePath, configured, baseline, baseline);
    const identity = [httpSource === null ? (process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath) : httpSource.id,
      process.platform === 'win32' ? consumerRoot?.toLowerCase() ?? null : consumerRoot];
    const id = hash(JSON.stringify([configured, ...identity]));
    return store.register({ ...configured, id, label, sourcePath, consumerRoot, baseline, httpSource });
  } finally { store.close(); }
}

/** One explicit observation cycle. No approvals, consumer execution, or automatic compatibility inference from prose/examples. */
export async function observeSourcesOnce(options: ObserveSourcesOptions): Promise<SourceObservationCycle> {
  options = { ...options };
  if (options.allowHttp !== undefined && typeof options.allowHttp !== 'boolean') invalid('HTTP observation must be explicitly enabled with a boolean option.');
  if (options.httpCredentials !== undefined && typeof options.httpCredentials !== 'function') invalid('HTTP credentials require an explicit trusted callback.');
  if (options.signal !== undefined && (isProxy(options.signal) || !(options.signal instanceof AbortSignal))) invalid('Source cancellation requires an AbortSignal.');
  if (options.subscriptionId !== undefined) identifier(options.subscriptionId);
  const store = await openSourceStore(options.statePath);
  const results: SourceObservationCycle['results'][number][] = [];
  try {
    const subscriptions = store.list().filter(value => options.subscriptionId === undefined || value.id === options.subscriptionId);
    if (options.subscriptionId !== undefined && subscriptions.length === 0) invalid('The selected source subscription does not exist.');
    for (const configured of subscriptions) {
      if (options.signal?.aborted) break;
      const lease = store.claim(configured.id);
      if (!lease) { results.push({ subscriptionId: configured.id, status: 'busy' }); continue; }
      let phase: 'source' | 'comparison' | 'state' = 'source';
      try {
        if (configured.httpSource !== null && options.allowHttp !== true) {
          store.fail(lease, 'http-not-enabled');
          results.push({ subscriptionId: configured.id, status: 'failed', reason: 'http-not-enabled' });
          continue;
        }
        outsideConsumer(store.statePath, configured.consumerRoot);
        let httpSnapshot: HttpSourceSnapshot | undefined;
        let revision: Uint8Array;
        if (configured.httpSource !== null) {
          phase = 'state';
          const previous = store.httpCache(lease);
          phase = 'source';
          if (options.signal?.aborted) {
            store.fail(lease, 'source-unavailable');
            break;
          }
          const credentials = options.httpCredentials?.(configured.httpSource);
          const captured = await captureHttpSource({ source: configured.httpSource, ...(previous === undefined ? {} : { previous }),
            ...(credentials === undefined ? {} : { credentials }), ...(options.signal === undefined ? {} : { signal: options.signal }) }, options.httpDependencies);
          httpSnapshot = captured.snapshot;
          revision = Buffer.from(httpSnapshot.bytes);
        } else revision = await readLocalBytes(configured.sourcePath, MAXIMUM_BYTES);
        phase = 'state';
        const baseline = store.baseline(configured.id);
        phase = 'comparison';
        const report = await compareSource(store.statePath, configured, baseline, revision);
        phase = 'state';
        const completed = store.complete(lease, revision, report, httpSnapshot);
        results.push({ subscriptionId: configured.id, status: completed.changed ? 'observed' : 'unchanged',
          observationId: completed.id, created: completed.changed });
      } catch (error) {
        let reason: SourceObservationFailure = error instanceof PlumberError && error.code === 'LEASE_LOST' ? 'lease-lost'
          : error instanceof PlumberError && error.code === 'STATE_LIMIT' ? 'state-limit'
            : phase === 'source' ? 'source-unavailable' : phase === 'state' ? 'state-unavailable'
              : error instanceof PlumberError && error.code === 'UNSUPPORTED_CONTRACT' ? 'unsupported-source'
                : error instanceof PlumberError && error.code === 'INVALID_INPUT' ? 'invalid-source' : 'comparison-failed';
        if (reason !== 'lease-lost') {
          try { store.fail(lease, reason); }
          catch (failure) { reason = failure instanceof PlumberError && failure.code === 'LEASE_LOST' ? 'lease-lost' : 'state-unavailable'; }
        }
        results.push({ subscriptionId: configured.id, status: 'failed', reason });
      }
    }
    return { schemaVersion: 1, results, ...(options.signal?.aborted ? { aborted: true as const } : {}) };
  } finally { store.close(); }
}

export async function listSourceSubscriptions(options: { readonly statePath: string }): Promise<SourceSubscription[]> {
  const store = await openSourceStore(options.statePath);
  try { return store.list(); } finally { store.close(); }
}
export async function listSourceObservations(options: { readonly statePath: string; readonly subscriptionId?: string }): Promise<SourceObservation[]> {
  const store = await openSourceStore(options.statePath);
  try { return store.listObservations(options.subscriptionId); } finally { store.close(); }
}
