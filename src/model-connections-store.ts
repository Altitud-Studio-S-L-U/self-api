import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PlumberError } from './errors.js';
import type { ModelConnectionPersistence, ModelConnectionState } from './model-connections.js';
import { checkServicePath, checkWindowsServiceAcl, readServiceRecord, writeServiceSnapshot } from './worker-service-state.js';

const FILE = 'model-connections.json';
const LOCK = 'model-connections.lock.sqlite3';
function invalid(): never { throw new PlumberError('INVALID_INPUT', 'The private model connection state is invalid or another process owns its operation.'); }
function decode(value: unknown): ModelConnectionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const fields = ['id', 'revision', 'configurationDigest', 'status', 'verifiedAt', 'latencyMs', 'failure'];
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) invalid();
  const state = value as Record<string, unknown>;
  if (typeof state['id'] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(state['id'])
    || typeof state['revision'] !== 'number' || !Number.isSafeInteger(state['revision']) || state['revision'] < 1 || state['revision'] > 2147483647
    || typeof state['configurationDigest'] !== 'string' || !/^[a-f0-9]{64}$/u.test(state['configurationDigest'])
    || !['unverified', 'healthy', 'degraded', 'requires-reconfiguration'].includes(String(state['status']))
    || state['verifiedAt'] !== null && (typeof state['verifiedAt'] !== 'number' || !Number.isSafeInteger(state['verifiedAt']) || state['verifiedAt'] < 0)
    || state['latencyMs'] !== null && (typeof state['latencyMs'] !== 'number' || !Number.isSafeInteger(state['latencyMs']) || state['latencyMs'] < 0 || state['latencyMs'] > 120_000)
    || state['failure'] !== null && !['credentials', 'permission', 'model', 'quota', 'transient', 'invalid-response', 'cancelled'].includes(String(state['failure']))) invalid();
  if (state['status'] === 'healthy' && (state['verifiedAt'] === null || state['latencyMs'] === null || state['failure'] !== null)) invalid();
  return Object.freeze(value as ModelConnectionState);
}

interface StoredConnections { readonly schemaVersion: 1; readonly states: readonly ModelConnectionState[]; readonly probeGrant: string | null }
function read(directory: string): StoredConnections {
  const value = readServiceRecord(directory, FILE);
  if (value === undefined) return { schemaVersion: 1, states: [], probeGrant: null };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('states' in value) || !Array.isArray(value.states) || value.states.length > 32
    || !('probeGrant' in value) || value.probeGrant !== null && (typeof value.probeGrant !== 'string' || !/^[a-f0-9]{64}$/u.test(value.probeGrant))) invalid();
  const states = value.states.map(decode);
  if (new Set(states.map(state => state.id)).size !== states.length) invalid();
  return { schemaVersion: 1, states, probeGrant: value.probeGrant };
}

/** One OS-released SQLite lock protects bounded atomic JSON snapshots across CLI and service processes. */
export class ModelConnectionStore implements ModelConnectionPersistence {
  private closed = false;
  private value: StoredConnections;
  private constructor(private readonly directory: string, private readonly lock: DatabaseSync) { this.value = read(directory); }
  static async open(directory: string): Promise<ModelConnectionStore> {
    checkServicePath(directory, 'directory'); checkWindowsServiceAcl(directory, true);
    const path = join(directory, LOCK);
    for (const filename of [LOCK, `${LOCK}-journal`, `${LOCK}-wal`, `${LOCK}-shm`, FILE, `${FILE}.next`]) {
      try { const info = lstatSync(join(directory, filename));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) invalid();
        checkServicePath(join(directory, filename), 'secret'); checkWindowsServiceAcl(join(directory, filename), true);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const { DatabaseSync } = await import('node:sqlite');
    const lock = new DatabaseSync(path, { timeout: 0, allowExtension: false, enableDoubleQuotedStringLiterals: false });
    try {
      const id = lock.prepare('PRAGMA application_id').get()?.['application_id'];
      const tables = lock.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.['n'];
      if (id !== 0x4b534d43 && (id !== 0 || tables !== 0)) invalid();
      lock.exec(`PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; PRAGMA application_id=${0x4b534d43};
        CREATE TABLE IF NOT EXISTS model_lock(id INTEGER PRIMARY KEY CHECK(id=1)); INSERT OR IGNORE INTO model_lock VALUES(1);`);
      return new ModelConnectionStore(directory, lock);
    } catch { lock.close(); invalid(); }
  }
  read(id: string): ModelConnectionState | undefined { if (this.closed) invalid(); return this.value.states.find(state => state.id === id); }
  write(input: ModelConnectionState): void {
    if (this.closed) invalid();
    const state = decode(input), previous = this.read(state.id);
    if (previous && (previous.revision > state.revision || previous.revision === state.revision && previous.configurationDigest !== state.configurationDigest)) invalid();
    const states = [...this.value.states.filter(value => value.id !== state.id), state].sort((left, right) => left.id.localeCompare(right.id));
    if (states.length > 32) throw new PlumberError('STATE_LIMIT', 'The model connection history reached its bounded local capacity.');
    this.save({ ...this.value, states });
  }
  permitsStartupProbe(configurationDigest: string): boolean { return !this.closed && this.value.probeGrant === configurationDigest; }
  authorizeStartupProbe(configurationDigest: string): void {
    if (this.closed || !/^[a-f0-9]{64}$/u.test(configurationDigest)) invalid();
    this.save({ ...this.value, probeGrant: configurationDigest });
  }
  private save(value: StoredConnections): void { writeServiceSnapshot(this.directory, FILE, value); this.value = value; }
  close(): void { if (!this.closed) { this.closed = true; try { this.lock.exec('ROLLBACK'); } finally { this.lock.close(); } } }
}

/** Status is read-only and never runs inference or waits for a long-running model operation. */
export function readModelConnectionStatus(directory: string): readonly ModelConnectionState[] {
  checkServicePath(directory, 'directory'); checkWindowsServiceAcl(directory, true);
  return read(directory).states;
}
