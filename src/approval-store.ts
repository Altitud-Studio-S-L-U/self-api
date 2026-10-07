import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';

export type ApprovalOrigin = 'local-cli' | 'explicit-sdk-caller';

export interface ApprovalReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly stateRootId: string;
  readonly consumerRootId: string;
  readonly planId: string;
  readonly executionDigest: string;
  readonly policyDigest: string;
  readonly origin: ApprovalOrigin;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface ApprovalBinding {
  readonly statePath: string;
  readonly consumerRoot: string;
  readonly planId: string;
  readonly executionDigest: string;
  readonly policyDigest: string;
}

export interface IssueApprovalOptions extends ApprovalBinding {
  readonly origin: ApprovalOrigin;
}

export interface ConsumeApprovalOptions extends ApprovalBinding {
  readonly receiptId: string;
}

const TTL_MS = 15 * 60 * 1000;
const MAX_RECEIPT_BYTES = 4096;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RECEIPT_FIELDS = ['schemaVersion', 'id', 'stateRootId', 'consumerRootId', 'planId', 'executionDigest', 'policyDigest', 'origin', 'issuedAt', 'expiresAt'];

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function localPath(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value === '-' || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid('Approval storage requires regular local directory paths.');
  }
  if (/^[\\/]{2}/u.test(value)) invalid('UNC, device, and pipe paths are not supported.');
  const withoutDrive = process.platform === 'win32' && /^[a-z]:[\\/]/iu.test(value) ? value.slice(2) : value;
  if (withoutDrive.includes(':')) invalid('URLs, drive-relative paths, and alternate data streams are not supported.');
  if (/(?:^|[\\/])(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/iu.test(value)) {
    invalid('Windows device names are not supported.');
  }
  if (process.platform === 'win32' && withoutDrive.split(/[\\/]/u).some(segment => segment !== '.' && segment !== '..' && /[. ]$/u.test(segment))) {
    invalid('Windows paths with trailing dots or spaces are not supported.');
  }
  return resolve(value);
}

function code(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

async function directoryPath(path: string, mode: 'existing' | 'destination' | 'create' = 'existing'): Promise<string> {
  const root = parse(path).root;
  const segments = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = join(current, segments[index]!);
    let attributes;
    try {
      attributes = await lstat(current);
    } catch (error) {
      if (code(error) !== 'ENOENT' || index < 0) throw error;
      if (mode === 'destination') return join(await realpath(dirname(current)), ...segments.slice(index));
      if (mode !== 'create') throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (creationError) { if (code(creationError) !== 'EEXIST') throw creationError; }
      attributes = await lstat(current);
    }
    if (attributes.isSymbolicLink() || !attributes.isDirectory()) {
      invalid('Approval directories and their ancestors must be directories without symbolic links or junctions.');
    }
  }
  return realpath(path);
}

function nested(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function separate(state: string, consumer: string): void {
  if (nested(state, consumer) || nested(consumer, state)) {
    invalid('Approval state must be outside the consumer directory and cannot contain it.');
  }
}

function rootId(path: string): string {
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
}

function bindings(options: ApprovalBinding): ApprovalBinding {
  if (!options || ![options.planId, options.executionDigest, options.policyDigest].every(value => typeof value === 'string' && HASH.test(value))) {
    invalid('Approval bindings must be lowercase SHA-256 values.');
  }
  return {
    statePath: localPath(options.statePath),
    consumerRoot: localPath(options.consumerRoot),
    planId: options.planId,
    executionDigest: options.executionDigest,
    policyDigest: options.policyDigest,
  };
}

async function storage(options: ApprovalBinding, create: boolean): Promise<{ state: string; consumer: string; receipts: string; attempts: string }> {
  const consumer = await directoryPath(options.consumerRoot);
  const destination = await directoryPath(options.statePath, 'destination');
  separate(destination, consumer);
  if (destination === parse(destination).root) invalid('Approval state requires a dedicated directory.');
  const state = await directoryPath(options.statePath, create ? 'create' : 'existing');
  separate(state, consumer);
  const receipts = await directoryPath(join(state, 'receipts'), create ? 'create' : 'existing');
  const attempts = await directoryPath(join(state, 'attempts'), create ? 'create' : 'existing');
  return { state, consumer, receipts, attempts };
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await directoryPath(dirname(path));
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function receipt(value: unknown): ApprovalReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('The approval receipt is malformed.');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== RECEIPT_FIELDS.length || RECEIPT_FIELDS.some(key => !Object.hasOwn(fields, key))
    || fields.schemaVersion !== 1 || typeof fields.id !== 'string' || !UUID.test(fields.id)
    || !['stateRootId', 'consumerRootId', 'planId', 'executionDigest', 'policyDigest'].every(key => typeof fields[key] === 'string' && HASH.test(fields[key]))
    || typeof fields.origin !== 'string' || !['local-cli', 'explicit-sdk-caller'].includes(fields.origin)
    || typeof fields.issuedAt !== 'string' || typeof fields.expiresAt !== 'string') {
    invalid('The approval receipt is malformed or contains unknown fields.');
  }
  const issued = Date.parse(fields.issuedAt);
  const expires = Date.parse(fields.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || new Date(issued).toISOString() !== fields.issuedAt
    || new Date(expires).toISOString() !== fields.expiresAt || expires - issued !== TTL_MS) {
    invalid('The approval receipt has an invalid validity interval.');
  }
  return Object.freeze(fields) as unknown as ApprovalReceipt;
}

function unexpired(value: ApprovalReceipt): void {
  const now = Date.now();
  if (Date.parse(value.issuedAt) > now || Date.parse(value.expiresAt) <= now) {
    invalid('The approval receipt has expired or is not yet valid.');
  }
}

/** Records explicit caller intent. It is neither proof of a human nor protection from the same OS user. */
export async function issueApproval(options: IssueApprovalOptions): Promise<ApprovalReceipt> {
  try {
    const bound = bindings(options);
    const origin = options.origin;
    if (origin !== 'local-cli' && origin !== 'explicit-sdk-caller') invalid('An explicit supported approval origin is required.');
    const paths = await storage(bound, true);
    const now = Date.now();
    const issued: ApprovalReceipt = Object.freeze({
      schemaVersion: 1,
      id: randomUUID(),
      stateRootId: rootId(paths.state),
      consumerRootId: rootId(paths.consumer),
      planId: bound.planId,
      executionDigest: bound.executionDigest,
      policyDigest: bound.policyDigest,
      origin,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL_MS).toISOString(),
    });
    await writeExclusive(join(paths.receipts, `${issued.id}.json`), issued);
    return issued;
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('Could not issue an approval in regular local storage.');
  }
}

export async function consumeApproval(options: ConsumeApprovalOptions): Promise<{ receipt: ApprovalReceipt; attemptPath: string }> {
  try {
    const bound = bindings(options);
    const id = options.receiptId;
    if (typeof id !== 'string' || !UUID.test(id)) invalid('A canonical approval receipt identifier is required.');
    const paths = await storage(bound, false);
    const granted = receipt(await loadLocalJson(join(paths.receipts, `${id}.json`), MAX_RECEIPT_BYTES));
    if (granted.id !== id || granted.stateRootId !== rootId(paths.state) || granted.consumerRootId !== rootId(paths.consumer)
      || granted.planId !== bound.planId || granted.executionDigest !== bound.executionDigest || granted.policyDigest !== bound.policyDigest) {
      invalid('The approval receipt does not match the state, consumer, plan, execution, or policy.');
    }
    unexpired(granted);
    await directoryPath(paths.attempts);
    const attemptPath = join(paths.attempts, id);
    // Claim before any executor can start. Never remove this directory after failure or a process crash.
    try { await mkdir(attemptPath, { mode: 0o700 }); }
    catch (error) {
      if (code(error) === 'EEXIST') invalid('This approval already has an execution attempt.');
      throw error;
    }
    await directoryPath(attemptPath);
    unexpired(granted);
    await writeExclusive(join(attemptPath, 'marker.json'), {
      schemaVersion: 1,
      receiptId: id,
      planId: granted.planId,
      executionDigest: granted.executionDigest,
      consumedAt: new Date().toISOString(),
    });
    return { receipt: granted, attemptPath };
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('Could not consume an approval from regular local storage.');
  }
}
