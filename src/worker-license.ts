import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { isProxy } from 'node:util/types';
import { calculateJwkThumbprint, importJWK, jwtVerify, type JWK } from 'jose';
import type { DatabaseSync } from 'node:sqlite';
import type { CloudCredentials } from './cloud-connection.js';
import { PlumberError } from './errors.js';
import { checkServicePath, checkWindowsServiceAcl } from './worker-service-state.js';

export const WORKER_CONTROL_INTERVAL_MS = 60_000;
export const WORKER_OFFLINE_LIMIT_SECONDS = 86_400;
export interface WorkerLicenseTrust { readonly schemaVersion: 1; readonly issuer: string; readonly keys: readonly JWK[]; }
export interface WorkerLicenseClaims {
  readonly schemaVersion: 1; readonly iss: string; readonly aud: 'keepseam-worker-automation';
  readonly workerId: string; readonly organizationId: string; readonly installationId: string; readonly projectId: string;
  readonly jkt: string; readonly revision: number; readonly decision: 'allowed' | 'suspended';
  readonly iat: number; readonly exp: number; readonly entitlementExpiresAt: number | null;
}
export interface WorkerControlRequest {
  readonly schemaVersion: 1; readonly requestId: string; readonly installationId: string; readonly projectId: string;
  readonly runId: string; readonly observedRevision: number | null; readonly automation: 'active' | 'draining' | 'paused';
}
export interface WorkerControlResponse { readonly schemaVersion: 1; readonly license: string; readonly pollAfterMs: 60000; }
export interface WorkerControlTransport { poll(input: WorkerControlRequest): Promise<WorkerControlResponse>; }
function invalid(): never { throw new PlumberError('INVALID_INPUT', 'Worker license or trust does not match its signed automation contract.'); }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const opaque = /^[a-f0-9]{64}$/u;
function plain(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) invalid();
  return input as Record<string, unknown>;
}
export function normalizeWorkerLicenseTrust(input: unknown): WorkerLicenseTrust {
  const value = plain(input);
  if (Object.keys(value).sort().join(',') !== 'issuer,keys,schemaVersion' || value.schemaVersion !== 1 || typeof value.issuer !== 'string') invalid();
  let issuer: URL; try { issuer = new URL(value.issuer); } catch { invalid(); }
  if (issuer.origin !== value.issuer || (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(issuer.hostname)))) invalid();
  if (!Array.isArray(value.keys) || isProxy(value.keys) || value.keys.length < 1 || value.keys.length > 5
    || Reflect.ownKeys(value.keys).length !== value.keys.length + 1
    || Array.from({ length: value.keys.length }, (_, index) => Object.getOwnPropertyDescriptor(value.keys, String(index)))
      .some(descriptor => !descriptor || !Object.hasOwn(descriptor, 'value'))) invalid();
  const kids = new Set<string>();
  const keys = value.keys.map(input => {
    const key = plain(input);
    if (Object.keys(key).sort().join(',') !== 'crv,kid,kty,x,y' || key.kty !== 'EC' || key.crv !== 'P-256'
      || typeof key.kid !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(key.kid) || kids.has(key.kid)
      || typeof key.x !== 'string' || typeof key.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(key.x) || !/^[A-Za-z0-9_-]{43}$/u.test(key.y)) invalid();
    kids.add(key.kid); return Object.freeze({ kty: 'EC', crv: 'P-256', kid: key.kid, x: key.x, y: key.y });
  });
  return Object.freeze({ schemaVersion: 1, issuer: value.issuer, keys: Object.freeze(keys) });
}

/** Verification is also repeated for cached bytes; database fields cannot manufacture an authorization. */
export async function verifyWorkerLicense(token: string, input: WorkerLicenseTrust, credentials: CloudCredentials,
  now = Date.now(), allowExpired = false): Promise<WorkerLicenseClaims> {
  const trust = normalizeWorkerLicenseTrust(input);
  if (typeof token !== 'string' || token.length > 8192 || !Number.isSafeInteger(now) || now < 0 || trust.issuer !== credentials.baseUrl) invalid();
  try {
    const verified = await jwtVerify(token, async header => {
      if (header.alg !== 'ES256' || header.typ !== 'keepseam-worker-license+jwt' || Object.keys(header).sort().join(',') !== 'alg,kid,typ') invalid();
      const key = trust.keys.find(key => key.kid === header.kid); if (!key) invalid();
      return importJWK(key, 'ES256');
    }, { algorithms: ['ES256'], issuer: trust.issuer, audience: 'keepseam-worker-automation',
      currentDate: new Date(allowExpired ? 0 : now), clockTolerance: 0 });
    const p = verified.payload;
    if (Object.keys(p).sort().join(',') !== 'aud,decision,entitlementExpiresAt,exp,iat,installationId,iss,jkt,organizationId,projectId,revision,schemaVersion,workerId'
      || p.schemaVersion !== 1 || typeof p.workerId !== 'string' || !uuid.test(p.workerId) || typeof p.organizationId !== 'string' || !uuid.test(p.organizationId)
      || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1 || Number(p.revision) > 2147483646
      || p.installationId !== credentials.installationId || p.projectId !== credentials.projectId
      || !opaque.test(credentials.installationId) || !opaque.test(credentials.projectId)
      || !['allowed','suspended'].includes(String(p.decision)) || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)
      || p.iat! < 0 || p.exp! <= p.iat! || p.exp! - p.iat! > WORKER_OFFLINE_LIMIT_SECONDS
      || p.iat! * 1000 > now + 5000
      || (p.entitlementExpiresAt !== null && (!Number.isSafeInteger(p.entitlementExpiresAt) || Number(p.entitlementExpiresAt) < 0))
      || (p.decision === 'allowed' && (p.entitlementExpiresAt === null || p.exp! > Number(p.entitlementExpiresAt)))) invalid();
    const jkt = await calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x: credentials.privateJwk.x!, y: credentials.privateJwk.y! });
    if (p.jkt !== jkt) invalid();
    return Object.freeze(p as unknown as WorkerLicenseClaims);
  } catch { invalid(); }
}

/** The daemon owns this private, FULL-synchronous database. Restart cannot reset its denial or clock/revision watermark. */
export class WorkerLicenseStore {
  private closed = false;
  private verified: { token: string; claims: WorkerLicenseClaims } | undefined;
  private constructor(private readonly db: DatabaseSync, private readonly credentials: CloudCredentials, private readonly trust: WorkerLicenseTrust) {}
  static async open(directory: string, credentials: CloudCredentials, trust: WorkerLicenseTrust): Promise<WorkerLicenseStore> {
    checkServicePath(directory, 'directory'); checkWindowsServiceAcl(directory, true);
    const path = join(directory, 'worker-license.sqlite3');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { const info = lstatSync(path + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) invalid();
        checkServicePath(path + suffix, 'secret'); checkWindowsServiceAcl(path + suffix, true);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { timeout: 1000, allowExtension: false, enableDoubleQuotedStringLiterals: false });
    try {
      const id = Number(db.prepare('PRAGMA application_id').get()!['application_id']);
      if (id !== 0x4b534c49 && (id !== 0 || Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!['n']) !== 0)) invalid();
      db.exec(`PRAGMA application_id=${0x4b534c49}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS license(id INTEGER PRIMARY KEY CHECK(id=1),installation TEXT NOT NULL,project TEXT NOT NULL,
          token TEXT,revision INTEGER NOT NULL DEFAULT 0,issued INTEGER NOT NULL DEFAULT 0,clock INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);`);
      db.prepare('INSERT OR IGNORE INTO license(id,installation,project) VALUES(1,?,?)').run(credentials.installationId, credentials.projectId);
      const row = db.prepare('SELECT * FROM license WHERE id=1').get()!;
      if (row['installation'] !== credentials.installationId || row['project'] !== credentials.projectId) invalid();
      return new WorkerLicenseStore(db, credentials, normalizeWorkerLicenseTrust(trust));
    } catch (error) { db.close(); throw error; }
  }
  async apply(token: string, now = Date.now(), source: 'offline-import' | 'authenticated-control' = 'offline-import'): Promise<WorkerLicenseClaims> {
    const claims = await verifyWorkerLicense(token, this.trust, this.credentials, now, source === 'offline-import');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM license WHERE id=1').get()!;
      if (Number(row['revoked']) && source !== 'authenticated-control') invalid();
      if (now < Number(row['clock']) || claims.revision < Number(row['revision']) || claims.iat < Number(row['issued'])) invalid();
      if (claims.revision === Number(row['revision']) && row['token']) {
        const previous = this.verified?.token === row['token'] ? this.verified.claims : await verifyWorkerLicense(String(row['token']), this.trust, this.credentials, now, true);
        if (claims.decision !== previous.decision || claims.entitlementExpiresAt !== previous.entitlementExpiresAt || claims.workerId !== previous.workerId || claims.organizationId !== previous.organizationId) invalid();
      }
      this.db.prepare('UPDATE license SET token=?,revision=?,issued=?,clock=?,revoked=0 WHERE id=1').run(token, claims.revision, claims.iat, now);
      this.db.exec('COMMIT'); this.verified = { token, claims }; return claims;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async status(now = Date.now()): Promise<{ readonly allowed: boolean; readonly revision: number | null; readonly reason: 'allowed' | 'missing' | 'expired' | 'suspended' | 'revoked' | 'invalid' | 'clock-rollback' }> {
    const row = this.db.prepare('SELECT * FROM license WHERE id=1').get()!;
    const revision = Number(row['revision']) || null;
    if (now < Number(row['clock'])) return { allowed: false, revision, reason: 'clock-rollback' };
    this.db.prepare('UPDATE license SET clock=? WHERE id=1').run(now);
    if (Number(row['revoked'])) return { allowed: false, revision, reason: Number(row['revoked']) === 1 ? 'revoked' : 'invalid' };
    if (!row['token']) return { allowed: false, revision, reason: 'missing' };
    const claims = this.verified?.token === row['token'] ? this.verified.claims : await verifyWorkerLicense(String(row['token']), this.trust, this.credentials, now, true);
    this.verified = { token: String(row['token']), claims };
    if (claims.revision !== revision || claims.iat !== Number(row['issued'])) invalid();
    const reason = claims.decision === 'suspended' ? 'suspended' : claims.exp * 1000 <= now ? 'expired' : 'allowed';
    return { allowed: reason === 'allowed', revision, reason };
  }
  revoke(now = Date.now(), reason: 'revoked' | 'invalid' = 'revoked'): void { this.db.prepare('UPDATE license SET revoked=?,clock=max(clock,?) WHERE id=1').run(reason === 'revoked' ? 1 : 2, now); }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
