import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { isProxy } from 'node:util/types';
import type { DockerValidationResult } from './docker-runner.js';
import { PlumberError } from './errors.js';
import type { MigrationValidationResult } from './migration-validation.js';

export interface ValidationPhaseOutcome {
  readonly status: DockerValidationResult['status'];
  readonly exitCode: number | null;
  readonly cleanup: DockerValidationResult['cleanup'];
  readonly containerName?: string;
}

export interface ValidationOutcome {
  readonly schemaVersion: 1;
  readonly intentId: string | null;
  readonly requestId: string;
  readonly receiptId: string;
  readonly status: MigrationValidationResult['status'];
  readonly baseline: ValidationPhaseOutcome;
  readonly candidate?: ValidationPhaseOutcome;
  readonly consumerModified: false;
  readonly publication: 'not-authorized';
}

const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_OUTCOME_BYTES = 16 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CONTAINER = /^plumber-validation-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const OUTCOME_FIELDS = ['schemaVersion', 'intentId', 'requestId', 'receiptId', 'status', 'baseline', 'consumerModified', 'publication'];
const RESULT_FIELDS = OUTCOME_FIELDS.filter(field => field !== 'intentId');
const PHASE_FIELDS = ['status', 'exitCode', 'cleanup'];

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid('Validation artifacts must contain plain data objects.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (required.some(key => !Object.hasOwn(descriptors, key))
    || keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)
      || !Object.hasOwn(descriptors[key]!, 'value'))) {
    invalid('Validation artifacts contain missing, unknown, or non-data fields.');
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function phase(value: unknown): ValidationPhaseOutcome {
  const data = record(value, PHASE_FIELDS, ['containerName']);
  if (!['passed', 'failed', 'blocked', 'timed-out', 'output-limit', 'cleanup-failed'].includes(data.status as string)
    || !['removed', 'not-created', 'failed'].includes(data.cleanup as string)
    || (data.exitCode !== null && (!Number.isSafeInteger(data.exitCode) || (data.exitCode as number) < 0 || (data.exitCode as number) > 255))
    || (Object.hasOwn(data, 'containerName') && (typeof data.containerName !== 'string' || !CONTAINER.test(data.containerName)))) {
    invalid('A validation phase contains invalid status, exit, cleanup, or container metadata.');
  }
  if ((data.status === 'passed' && (data.exitCode !== 0 || data.cleanup !== 'removed'))
    || (data.status === 'failed' && (data.exitCode === null || data.exitCode === 0 || data.cleanup !== 'removed'))
    || ((data.status === 'cleanup-failed') !== (data.cleanup === 'failed'))
    || (data.cleanup === 'not-created' && Object.hasOwn(data, 'containerName'))) {
    invalid('Validation phase status contradicts its execution or cleanup evidence.');
  }
  return Object.freeze({
    status: data.status as ValidationPhaseOutcome['status'],
    exitCode: data.exitCode as number | null,
    cleanup: data.cleanup as ValidationPhaseOutcome['cleanup'],
    ...(typeof data.containerName === 'string' ? { containerName: data.containerName } : {}),
  });
}

function completed(value: ValidationPhaseOutcome): boolean {
  return value.status === 'passed' || value.status === 'failed';
}

function identifiers(intentId: unknown, requestId: unknown, receiptId: unknown): void {
  if ((intentId !== null && (typeof intentId !== 'string' || !HASH.test(intentId)))
    || typeof requestId !== 'string' || !HASH.test(requestId)
    || typeof receiptId !== 'string' || !UUID.test(receiptId)) {
    invalid('Validation outcome bindings must be canonical identifiers.');
  }
}

/** Validates a private, bounded summary; log text and source paths are never accepted here. */
export function validateValidationOutcome(value: unknown): ValidationOutcome {
  const data = record(value, OUTCOME_FIELDS, ['candidate']);
  identifiers(data.intentId, data.requestId, data.receiptId);
  if (data.schemaVersion !== 1 || data.consumerModified !== false || data.publication !== 'not-authorized') {
    invalid('Validation outcome version or authorization fields are invalid.');
  }
  const baseline = phase(data.baseline);
  const candidate = Object.hasOwn(data, 'candidate') ? phase(data.candidate) : undefined;
  if (candidate && !completed(baseline)) invalid('A candidate cannot execute after an incomplete baseline.');
  const expectedStatus = completed(baseline) && candidate && completed(candidate)
    ? (candidate.status === 'passed' ? (baseline.status === 'passed' ? 'passed' : 'improved')
      : (baseline.status === 'passed' ? 'regression' : 'failed'))
    : 'blocked';
  if (data.status !== expectedStatus) invalid('Validation outcome status contradicts its phase evidence.');
  const outcome: ValidationOutcome = Object.freeze({
    schemaVersion: 1, intentId: data.intentId as string | null,
    requestId: data.requestId as string, receiptId: data.receiptId as string,
    status: expectedStatus, baseline, ...(candidate ? { candidate } : {}),
    consumerModified: false, publication: 'not-authorized',
  });
  serialized(outcome, MAX_OUTCOME_BYTES);
  return outcome;
}

function fullPhase(value: unknown): DockerValidationResult {
  const data = record(value, [...PHASE_FIELDS, 'stdout', 'stderr'], ['containerName', 'reason']);
  if (typeof data.stdout !== 'string' || typeof data.stderr !== 'string'
    || (Object.hasOwn(data, 'reason') && typeof data.reason !== 'string')
    || [data.stdout, data.stderr, data.reason].some(text => typeof text === 'string' && Buffer.byteLength(text) > MAX_RESULT_BYTES)) {
    invalid('Validation result output is invalid or exceeds its byte limit.');
  }
  const summary = phase({ status: data.status, exitCode: data.exitCode, cleanup: data.cleanup,
    ...(Object.hasOwn(data, 'containerName') ? { containerName: data.containerName } : {}) });
  return { ...summary, stdout: data.stdout, stderr: data.stderr,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}) };
}

function normalizedResult(value: unknown, intentId: string | null): { result: MigrationValidationResult; outcome: ValidationOutcome } {
  const data = record(value, RESULT_FIELDS, ['candidate']);
  const baseline = fullPhase(data.baseline);
  const candidate = Object.hasOwn(data, 'candidate') ? fullPhase(data.candidate) : undefined;
  const summarize = ({ status, exitCode, cleanup, containerName }: DockerValidationResult): ValidationPhaseOutcome => ({
    status, exitCode, cleanup, ...(containerName ? { containerName } : {}),
  });
  const outcome = validateValidationOutcome({
    ...data, intentId, baseline: summarize(baseline), ...(candidate ? { candidate: summarize(candidate) } : {}),
  });
  const { intentId: _intentId, candidate: _candidate, ...fields } = outcome;
  const result: MigrationValidationResult = { ...fields, baseline, ...(candidate ? { candidate } : {}) };
  return { result, outcome };
}

function serialized(value: unknown, maxBytes: number): string {
  const json = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(json) > maxBytes) invalid('Validation artifact exceeds its configured byte limit.');
  return json;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

async function directory(value: string): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value === '-' || /[\u0000-\u001f\u007f]/u.test(value)
    || /^[\\/]{2}/u.test(value)) invalid('Validation storage requires a regular local directory.');
  const withoutDrive = process.platform === 'win32' && /^[a-z]:[\\/]/iu.test(value) ? value.slice(2) : value;
  if (withoutDrive.includes(':')
    || /(?:^|[\\/])(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/iu.test(value)
    || (process.platform === 'win32' && withoutDrive.split(/[\\/]/u).some(part => part !== '.' && part !== '..' && /[. ]$/u.test(part)))) {
    invalid('Validation storage does not support network, device, or ambiguous paths.');
  }
  const path = resolve(value);
  const root = parse(path).root;
  let current = root;
  for (const segment of ['', ...path.slice(root.length).split(sep).filter(Boolean)]) {
    current = join(current, segment);
    const attributes = await lstat(current);
    if (attributes.isSymbolicLink() || !attributes.isDirectory()) invalid('Validation directories must not contain symbolic links or junctions.');
  }
  return realpath(path);
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const attributes = await lstat(path);
  if (attributes.isSymbolicLink() || !attributes.isFile()) invalid('Validation artifacts must be regular files without symbolic links.');
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) invalid('Validation artifact is not a bounded regular file.');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
      if (length > maxBytes) invalid('Validation artifact exceeds its configured byte limit.');
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown; }
    catch { invalid('Validation artifact must contain valid UTF-8 JSON.'); }
  } finally { await handle.close(); }
}

async function checkedAttempt(attemptPath: string, receiptId: string): Promise<string> {
  const path = await directory(attemptPath);
  const marker = record(await readJson(join(path, 'marker.json'), 4096), ['schemaVersion', 'receiptId', 'planId', 'executionDigest', 'consumedAt']);
  if (marker.schemaVersion !== 1 || marker.receiptId !== receiptId
    || typeof marker.planId !== 'string' || !HASH.test(marker.planId)
    || typeof marker.executionDigest !== 'string' || !HASH.test(marker.executionDigest)
    || typeof marker.consumedAt !== 'string' || !Number.isFinite(Date.parse(marker.consumedAt))
    || new Date(marker.consumedAt).toISOString() !== marker.consumedAt) {
    invalid('Validation artifacts do not match a valid consumed approval marker.');
  }
  return path;
}

async function writeArtifact(directoryPath: string, filename: string, json: string): Promise<void> {
  await directory(directoryPath);
  const handle = await open(join(directoryPath, filename), 'wx', 0o600);
  try { await handle.writeFile(json, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

/** Publishes the summary last, so a partial full result never denotes completion. */
export async function persistValidationOutcome(input: {
  attemptPath: string;
  result: MigrationValidationResult;
  intentId?: string;
}): Promise<ValidationOutcome> {
  try {
    const { result, outcome } = normalizedResult(input.result, input.intentId ?? null);
    const resultJson = serialized(result, MAX_RESULT_BYTES);
    const outcomeJson = serialized(outcome, MAX_OUTCOME_BYTES);
    const path = await checkedAttempt(input.attemptPath, outcome.receiptId);
    await writeArtifact(path, 'result.json', resultJson);
    await writeArtifact(path, 'outcome.json', outcomeJson);
    return outcome;
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('Could not persist validation artifacts in regular local storage.');
  }
}

export async function readValidationOutcome(input: {
  attemptPath: string;
  intentId: string | null;
  requestId: string;
  receiptId: string;
}): Promise<ValidationOutcome | null> {
  try {
    identifiers(input.intentId, input.requestId, input.receiptId);
    const path = await checkedAttempt(input.attemptPath, input.receiptId);
    const outcomePath = join(path, 'outcome.json');
    try { await lstat(outcomePath); }
    catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
    const outcome = validateValidationOutcome(await readJson(outcomePath, MAX_OUTCOME_BYTES));
    if (outcome.intentId !== input.intentId || outcome.requestId !== input.requestId || outcome.receiptId !== input.receiptId) {
      invalid('Validation outcome does not match its intent, request, and receipt.');
    }
    const full = normalizedResult(await readJson(join(path, 'result.json'), MAX_RESULT_BYTES), input.intentId);
    if (JSON.stringify(outcome) !== JSON.stringify(full.outcome)) invalid('Validation outcome conflicts with its full result artifact.');
    return outcome;
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('Could not read validation artifacts from regular local storage.');
  }
}
