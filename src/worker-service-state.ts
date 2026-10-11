import { randomUUID } from 'node:crypto';
import { accessSync, constants, closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, parse, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { PlumberError } from './errors.js';
import { checkWindowsPermissions } from './windows-permissions.js';

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
export const serviceFiles = Object.freeze({ lock: 'worker-service.sqlite3', status: 'worker-service.status.json', stop: 'worker-service.stop.json', log: 'worker-service.log', archive: 'worker-service.previous.log' });
const MAX_LOG_BYTES = 1024 * 1024;
const flags = constants.O_WRONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);

/** Native failures are useful to operators; arbitrary error text and paths are not safe log fields. */
export function serviceFailureDetails(error: unknown): { systemCode?: string; operation?: string } {
  try {
    if (!(error instanceof Error)) return {};
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown;
    const operation = Object.getOwnPropertyDescriptor(error, 'syscall')?.value as unknown;
    return {
      ...(typeof code === 'string' && ['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ENOSPC', 'EIO', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE', 'EROFS'].includes(code) ? { systemCode: code } : {}),
      ...(typeof operation === 'string' && ['rename', 'open', 'read', 'write', 'stat', 'lstat', 'unlink', 'close', 'fsync'].includes(operation) ? { operation } : {}),
    };
  } catch { return {}; }
}

/** These checks supplement, rather than replace, the dedicated OS account and operator-provisioned directory ACL. */
export function checkServicePath(path: string, kind: 'directory' | 'config' | 'secret'): void {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep)) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (current !== path && !info.isDirectory())) invalid('Service files and ancestors cannot be links.');
  }
  const info = lstatSync(path);
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) invalid('Service paths require local directories or singly linked regular files.');
  if (process.platform !== 'win32') {
    if (![0, process.getuid!()].includes(info.uid) || (info.mode & (kind === 'config' ? 0o022 : 0o077)) !== 0) {
      invalid('Service configuration must not be group/world writable; state and credentials must be private to the service account.');
    }
  }
}

/** Windows has no meaningful POSIX mode bits. Inspect native DACLs without modifying the user's permissions. */
export function checkWindowsServiceAcl(path: string, privateAccess: boolean): void {
  checkWindowsPermissions([path], privateAccess);
}

function assertRegularIfPresent(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) invalid('Service runtime files cannot be links or special files.');
    if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid!())) invalid('Service runtime files must be private to their owner.');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function ownedWrite(path: string, bytes: string, append = false): void {
  const exists = assertRegularIfPresent(path);
  const fd = openSync(path, flags | (append ? constants.O_APPEND : constants.O_TRUNC) | (exists ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}

export function writeServiceSnapshot(directory: string, filename: string, value: unknown): void {
  const path = join(directory, filename);
  assertRegularIfPresent(path);
  const previous = process.platform === 'win32' && existsSync(path) ? lstatSync(path, { bigint: true }) : undefined;
  const temporary = `${path}.next`;
  // A previous crash may leave this one bounded, private intermediate; no arbitrary temporary files are removed.
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > 16_384) invalid('Service runtime record exceeds its fixed limit.');
  ownedWrite(temporary, bytes);
  const parent = previous ? lstatSync(directory, { bigint: true }) : undefined;
  const staged = previous ? lstatSync(temporary, { bigint: true }) : undefined;
  try { renameSync(temporary, path); }
  catch (error) {
    if (!previous || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // MoveFileEx can report access denied while a Windows reader still holds the
    // destination open. Wait only for that atomic replacement, without deleting
    // the old snapshot, rewriting staging, or repairing any native permissions.
    checkWindowsPermissions([directory, path, temporary], true);
    try { accessSync(path, constants.W_OK); accessSync(temporary, constants.W_OK); }
    catch { throw error; }
    // The fixed wait budget starts after the separately bounded native ACL check.
    const until = performance.now() + 1000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (performance.now() < until) {
      assertRegularIfPresent(path); assertRegularIfPresent(temporary);
      const current = lstatSync(path, { bigint: true }), next = lstatSync(temporary, { bigint: true }), container = lstatSync(directory, { bigint: true });
      if (current.dev !== previous.dev || current.ino !== previous.ino || next.dev !== staged!.dev || next.ino !== staged!.ino
        || container.dev !== parent!.dev || container.ino !== parent!.ino || !container.isDirectory() || container.isSymbolicLink()
        || readFileSync(temporary, 'utf8') !== bytes) invalid('Service snapshot changed during atomic replacement.');
      try { renameSync(temporary, path); return; }
      catch (attempt) {
        if (!['EPERM', 'EACCES'].includes((attempt as NodeJS.ErrnoException).code ?? '')) throw attempt;
      }
      Atomics.wait(pause, 0, 0, Math.min(10, Math.max(0, until - performance.now())));
    }
    throw error;
  }
}

export function appendServiceLog(directory: string, value: unknown): void {
  const path = join(directory, serviceFiles.log);
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > 16_384) invalid('Service log entry exceeds its fixed limit.');
  if (assertRegularIfPresent(path) && statSync(path).size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
    const archive = join(directory, serviceFiles.archive);
    if (assertRegularIfPresent(archive)) unlinkSync(archive);
    renameSync(path, archive);
  }
  ownedWrite(path, line, true);
}

export function readServiceRecord(directory: string, filename: string): unknown {
  const path = join(directory, filename);
  if (!assertRegularIfPresent(path)) return undefined;
  if (statSync(path).size > 16_384) invalid('Service runtime record exceeds its fixed limit.');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** A separate SQLite exclusive transaction is released by the OS on crash; it does not block subscription databases. */
export async function lockWorkerService(statePath: string): Promise<{ readonly directory: string; readonly runId: string; close(): void }> {
  checkServicePath(statePath, 'directory');
  checkWindowsServiceAcl(statePath, true);
  const directory = realpathSync(statePath);
  const path = join(directory, serviceFiles.lock);
  if (!assertRegularIfPresent(path)) {
    try { closeSync(openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  for (const name of [...Object.values(serviceFiles), `${serviceFiles.status}.next`, `${serviceFiles.stop}.next`, `${serviceFiles.lock}-journal`]) {
    const existing = join(directory, name);
    if (assertRegularIfPresent(existing)) checkWindowsServiceAcl(existing, true);
  }
  const { DatabaseSync } = await import('node:sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { enableDoubleQuotedStringLiterals: false, allowExtension: false });
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
    // Touch a page so the operating system retains the exclusive lock until rollback/exit.
    db.exec('CREATE TABLE IF NOT EXISTS service_lock (id INTEGER PRIMARY KEY CHECK(id = 1)); INSERT OR IGNORE INTO service_lock(id) VALUES(1);');
  } catch {
    db?.close();
    invalid('A worker service already owns this state, or its local lock database is unavailable.');
  }
  let closed = false;
  return { directory, runId: randomUUID(), close(): void {
    if (closed) return;
    closed = true;
    try { db!.exec('ROLLBACK'); } finally { db!.close(); }
  } };
}

export function hasServiceDatabase(directory: string, filename: 'worker.sqlite3' | 'source-observations.sqlite3'): boolean {
  const path = join(directory, filename);
  if (!existsSync(path)) return false;
  checkServicePath(path, 'secret');
  checkWindowsServiceAcl(path, true);
  return true;
}
