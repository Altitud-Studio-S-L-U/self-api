import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { PlumberError } from './errors.js';

export const CLOUD_PROTOCOL_VERSION = 1;
export const RUNNER_STATES = ['idle', 'observing', 'review-required', 'validating', 'blocked', 'offline'] as const;
export const MAINTENANCE_STATES = ['observed', 'no-impact', 'proposal-ready', 'decision-required', 'validated', 'validation-failed', 'blocked', 'published', 'merged'] as const;
export const CLOUD_REASONS = ['none', 'unsupported-analysis', 'stale-evidence', 'approval-required', 'approval-expired', 'validation-failed', 'runtime-unavailable', 'credentials-unavailable', 'limit-reached', 'publication-uncertain', 'protocol-upgrade-required'] as const;

export interface CloudStatusEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly installationId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly body: {
    readonly type: 'runner-status';
    readonly state: typeof RUNNER_STATES[number];
    readonly reason: typeof CLOUD_REASONS[number];
    readonly pendingJobs: number;
  } | {
    readonly type: 'maintenance-status';
    readonly integrationId: string;
    readonly jobId: string;
    readonly state: typeof MAINTENANCE_STATES[number];
    readonly reason: typeof CLOUD_REASONS[number];
    readonly affectedOperations: number;
    readonly selectedTests: number;
    readonly passingTests: number;
  };
}

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Cloud messages must contain plain data records.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || actual.some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptors[key]!, 'value'))) {
    invalid('Cloud messages reject unknown, missing, or executable fields.');
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid('Cloud identifiers must be opaque lowercase SHA-256 values.');
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) invalid('Cloud counts must be bounded nonnegative integers.');
  return value as number;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid('Cloud status contains an unsupported enum value.');
  return value as T;
}

/** An allowlist encoder, not a redactor. Local artifacts and arbitrary labels are not accepted. */
export function validateCloudStatusEvent(input: unknown): CloudStatusEvent {
  const value = record(input, ['schemaVersion', 'eventId', 'installationId', 'projectId', 'sequence', 'recordedAt', 'body']);
  if (value.schemaVersion !== CLOUD_PROTOCOL_VERSION) invalid('Unsupported Cloud protocol version; upgrade explicitly before exchanging events.');
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || new Date(value.recordedAt).toISOString() !== value.recordedAt) invalid('Cloud timestamps must be canonical ISO instants.');
  const rawBody = value.body;
  if (!rawBody || typeof rawBody !== 'object' || isProxy(rawBody)) invalid('Cloud status body must contain plain data.');
  const type = Object.getOwnPropertyDescriptor(rawBody, 'type');
  if (!type || !Object.hasOwn(type, 'value')) invalid('Cloud status type must be a data field.');
  let body: CloudStatusEvent['body'];
  if (type.value === 'runner-status') {
    const status = record(rawBody, ['type', 'state', 'reason', 'pendingJobs']);
    body = Object.freeze({ type: 'runner-status', state: choice(status.state, RUNNER_STATES), reason: choice(status.reason, CLOUD_REASONS), pendingJobs: count(status.pendingJobs) });
  } else if (type.value === 'maintenance-status') {
    const status = record(rawBody, ['type', 'integrationId', 'jobId', 'state', 'reason', 'affectedOperations', 'selectedTests', 'passingTests']);
    const selectedTests = count(status.selectedTests);
    const passingTests = count(status.passingTests);
    if (passingTests > selectedTests) invalid('Passing tests cannot exceed selected tests.');
    body = Object.freeze({ type: 'maintenance-status', integrationId: identifier(status.integrationId), jobId: identifier(status.jobId),
      state: choice(status.state, MAINTENANCE_STATES), reason: choice(status.reason, CLOUD_REASONS),
      affectedOperations: count(status.affectedOperations), selectedTests, passingTests });
  } else invalid('Cloud status type is not supported.');
  return Object.freeze({ schemaVersion: 1, eventId: identifier(value.eventId), installationId: identifier(value.installationId),
    projectId: identifier(value.projectId), sequence: count(value.sequence), recordedAt: value.recordedAt, body });
}

export function encodeCloudStatusEvent(input: unknown): string {
  const encoded = JSON.stringify(validateCloudStatusEvent(input));
  if (Buffer.byteLength(encoded) > 4096) invalid('Cloud status exceeds its byte budget.');
  return encoded;
}

export function decodeCloudStatusEvent(json: string): CloudStatusEvent {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 4096) invalid('Cloud status exceeds its byte budget.');
  let value: unknown;
  try { value = JSON.parse(json); } catch { invalid('Cloud status must contain valid JSON.'); }
  return validateCloudStatusEvent(value);
}

/** Hash only an already opaque local ID; hashes do not conceal low-entropy names or routes. */
export function deriveCloudIdentifier(localId: string, installationId: string): string {
  return createHash('sha256').update(`plumber-cloud-id-v1\0${identifier(installationId)}\0${identifier(localId)}`).digest('hex');
}

export function negotiateCloudProtocol(supported: readonly number[]): { readonly status: 'compatible'; readonly version: 1 }
  | { readonly status: 'upgrade-required'; readonly version: null } {
  if (!Array.isArray(supported) || isProxy(supported) || Object.getPrototypeOf(supported) !== Array.prototype || supported.length > 20) {
    invalid('Protocol capabilities must be a bounded list of positive versions.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(supported);
  if (Reflect.ownKeys(descriptors).length !== supported.length + 1) invalid('Protocol capabilities must be a dense plain array.');
  const versions: number[] = [];
  for (let index = 0; index < supported.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(descriptor.value) || descriptor.value < 1) {
      invalid('Protocol versions must be positive integer data fields.');
    }
    versions.push(descriptor.value);
  }
  return Object.freeze(versions.includes(CLOUD_PROTOCOL_VERSION) ? { status: 'compatible', version: 1 } : { status: 'upgrade-required', version: null });
}
