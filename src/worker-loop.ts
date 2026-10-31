import { resolve } from 'node:path';
import { isProxy } from 'node:util/types';
import { PlumberError } from './errors.js';
import { observeOnce, type HttpObservationOptions } from './worker.js';
import { runApprovedJobsOnce } from './job-validation.js';

export interface WorkerLoopOptions extends HttpObservationOptions {
  readonly statePath: string;
  readonly enginePath: string;
  readonly subscriptionId?: string;
  readonly signal?: AbortSignal;
  /** Delay after a completed cycle, not a fixed-rate timer. Default: 60 seconds. */
  readonly intervalMs?: number;
  /** Every invocation is finite. Default: one cycle; maximum: 1,000. */
  readonly maxCycles?: number;
  /** Observation failures alone may be retried, at most this many consecutive failures. Default: three. */
  readonly maxObservationFailures?: number;
  readonly maxObservationBackoffMs?: number;
  /** Off by default. This processes only existing queued approvals and never issues authorization. */
  readonly processApprovedJobs?: boolean;
  readonly executionLimit?: number;
}

export interface WorkerLoopDependencies {
  /** Trusted local adapters; downloaded source data cannot supply executable policy. */
  readonly observe?: typeof observeOnce;
  readonly runApproved?: typeof runApprovedJobsOnce;
  readonly delay?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
}

export interface WorkerLoopCycle {
  readonly number: number;
  readonly observation: {
    readonly status: 'completed' | 'partial-failure' | 'failed';
    readonly counts: { readonly observed: number; readonly unchanged: number; readonly busy: number; readonly failed: number };
    readonly reason?: 'operation-error' | 'invalid-result';
  };
  readonly execution: {
    readonly status: 'not-enabled' | 'skipped-observation-failed' | 'skipped-aborted' | 'completed' | 'attention-required' | 'failed';
    readonly counts: { readonly completed: number; readonly blocked: number; readonly interrupted: number; readonly leaseLost: number;
      readonly unacceptedOutcomes: number };
    readonly reason?: 'operation-error' | 'invalid-result';
  };
  readonly consecutiveObservationFailures: number;
  /** Planned delay. Null means no additional cycle was scheduled. */
  readonly nextDelayMs: number | null;
}

export interface WorkerLoopResult {
  readonly schemaVersion: 1;
  readonly stopReason: 'max-cycles' | 'aborted' | 'observation-failure-limit' | 'execution-attention' | 'execution-error' | 'scheduler-error';
  readonly abortRequested: boolean;
  readonly cycles: readonly WorkerLoopCycle[];
}

const activeStates = new Set<string>();
const MAXIMUM_INTERVAL_MS = 60 * 60 * 1000;

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }

function integer(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    invalid(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

function path(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4096) {
    invalid('Worker paths must be nonempty strings of at most 4 KiB without null characters.');
  }
  return value;
}

/** Resolve cancellation while waiting, but never abandon an already running operation. */
function cancellableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolveDelay => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid local adapter result.');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid local adapter result.');
  return descriptor.value;
}

function resultEntries(value: unknown, maximum: number): unknown[] {
  if (ownData(value, 'schemaVersion') !== 1) throw new Error('Invalid local adapter result.');
  const entries = ownData(value, 'results');
  if (!Array.isArray(entries) || isProxy(entries) || Object.getPrototypeOf(entries) !== Array.prototype || entries.length > maximum) {
    throw new Error('Invalid local adapter result.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(entries);
  if (Reflect.ownKeys(descriptors).length !== entries.length + 1) throw new Error('Invalid local adapter result.');
  return Array.from({ length: entries.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid local adapter result.');
    return descriptor.value;
  });
}

function observationSummary(result: unknown): WorkerLoopCycle['observation'] {
  const counts = { observed: 0, unchanged: 0, busy: 0, failed: 0 };
  for (const entry of resultEntries(result, 100)) {
    const status = ownData(entry, 'status');
    if (status !== 'observed' && status !== 'unchanged' && status !== 'busy' && status !== 'failed') {
      throw new Error('Invalid local observation status.');
    }
    counts[status] += 1;
  }
  return { status: counts.failed > 0 ? 'partial-failure' : 'completed', counts };
}

function noExecution(status: WorkerLoopCycle['execution']['status']): WorkerLoopCycle['execution'] {
  return { status, counts: { completed: 0, blocked: 0, interrupted: 0, leaseLost: 0, unacceptedOutcomes: 0 } };
}

function executionSummary(result: unknown, maximum: number): WorkerLoopCycle['execution'] {
  const counts = { completed: 0, blocked: 0, interrupted: 0, leaseLost: 0, unacceptedOutcomes: 0 };
  for (const entry of resultEntries(result, maximum)) {
    const status = ownData(entry, 'status');
    if (status === 'completed') {
      const outcomeStatus = ownData(ownData(entry, 'outcome'), 'status');
      if (!['passed', 'improved', 'regression', 'failed', 'blocked'].includes(outcomeStatus as string)) {
        throw new Error('Invalid local validation outcome.');
      }
      counts.completed += 1;
      if (outcomeStatus !== 'passed' && outcomeStatus !== 'improved') counts.unacceptedOutcomes += 1;
    } else if (status === 'blocked' || status === 'interrupted') counts[status] += 1;
    else if (status === 'lease-lost') counts.leaseLost += 1;
    else throw new Error('Invalid local execution status.');
  }
  return { status: counts.blocked + counts.interrupted + counts.leaseLost + counts.unacceptedOutcomes > 0
    ? 'attention-required' : 'completed', counts };
}

/**
 * Start finite local polling explicitly. Phases never overlap; an abort drains the active phase
 * before returning. Store leases remain responsible for coordination across processes and path aliases.
 */
export async function runWorkerLoop(options: WorkerLoopOptions, dependencies: WorkerLoopDependencies = {}): Promise<WorkerLoopResult> {
  const statePath = resolve(path(options.statePath));
  const enginePath = path(options.enginePath);
  const subscriptionId = options.subscriptionId;
  if (subscriptionId !== undefined && (typeof subscriptionId !== 'string' || !/^[a-f0-9]{64}$/u.test(subscriptionId))) {
    invalid('A selected subscription must have a lowercase SHA-256 identifier.');
  }
  const signal = options.signal;
  if (signal !== undefined && (isProxy(signal) || !(signal instanceof AbortSignal))) invalid('The worker loop requires an AbortSignal.');
  const intervalMs = integer(options.intervalMs, 60_000, 1_000, MAXIMUM_INTERVAL_MS, 'Worker interval');
  const maxCycles = integer(options.maxCycles, 1, 1, 1_000, 'Worker cycle count');
  const maxObservationFailures = integer(options.maxObservationFailures, 3, 1, 10, 'Observation failure limit');
  const maxBackoff = integer(options.maxObservationBackoffMs, Math.max(300_000, intervalMs), intervalMs,
    MAXIMUM_INTERVAL_MS, 'Observation backoff');
  if (options.processApprovedJobs !== undefined && typeof options.processApprovedJobs !== 'boolean') {
    invalid('Approved-job processing requires an explicit boolean option.');
  }
  const processApprovedJobs = options.processApprovedJobs === true;
  if (options.allowHttp !== undefined && typeof options.allowHttp !== 'boolean') invalid('HTTP observation requires an explicit boolean option.');
  const httpOptions: HttpObservationOptions = {
    ...(options.allowHttp === undefined ? {} : { allowHttp: options.allowHttp }),
    ...(options.httpCredentials === undefined ? {} : { httpCredentials: options.httpCredentials }),
    ...(options.httpDependencies === undefined ? {} : { httpDependencies: options.httpDependencies }),
    ...(signal === undefined ? {} : { signal }),
  };
  const executionLimit = integer(options.executionLimit, 1, 1, 10, 'Execution pass limit');
  const observe = dependencies.observe ?? observeOnce;
  const runApproved = dependencies.runApproved ?? runApprovedJobsOnce;
  const delay = dependencies.delay ?? cancellableDelay;
  if (typeof observe !== 'function' || typeof runApproved !== 'function' || typeof delay !== 'function') {
    invalid('Worker adapters must be trusted functions.');
  }
  const cycles: WorkerLoopCycle[] = [];
  const finish = (stopReason: WorkerLoopResult['stopReason']): WorkerLoopResult => ({
    schemaVersion: 1, stopReason, abortRequested: signal?.aborted ?? false, cycles,
  });
  if (signal?.aborted) return finish('aborted');
  const stateKey = process.platform === 'win32' ? statePath.toLowerCase() : statePath;
  if (activeStates.has(stateKey)) invalid('A worker loop is already active for this local state path in this process.');
  activeStates.add(stateKey);
  let failures = 0;
  try {
    for (let number = 1; number <= maxCycles; number += 1) {
      if (signal?.aborted) return finish('aborted');
      let observation: WorkerLoopCycle['observation'];
      try {
        const result = await observe({ statePath, enginePath, ...(subscriptionId === undefined ? {} : { subscriptionId }), ...httpOptions });
        try { observation = observationSummary(result); }
        catch { observation = { status: 'failed', counts: { observed: 0, unchanged: 0, busy: 0, failed: 0 }, reason: 'invalid-result' }; }
      } catch {
        observation = { status: 'failed', counts: { observed: 0, unchanged: 0, busy: 0, failed: 0 }, reason: 'operation-error' };
      }
      failures = observation.status === 'completed' ? 0 : failures + 1;
      let execution = noExecution('not-enabled');
      if (processApprovedJobs) {
        if (signal?.aborted) execution = noExecution('skipped-aborted');
        else if (observation.status !== 'completed') execution = noExecution('skipped-observation-failed');
        else {
          try {
            const result = await runApproved({ statePath, enginePath, limit: executionLimit });
            try { execution = executionSummary(result, executionLimit); }
            catch { execution = { ...noExecution('failed'), reason: 'invalid-result' }; }
          } catch { execution = { ...noExecution('failed'), reason: 'operation-error' }; }
        }
      }
      const stopReason: WorkerLoopResult['stopReason'] | undefined = execution.status === 'failed' ? 'execution-error'
        : execution.status === 'attention-required' ? 'execution-attention'
          : signal?.aborted ? 'aborted'
            : failures >= maxObservationFailures ? 'observation-failure-limit'
              : number === maxCycles ? 'max-cycles' : undefined;
      const nextDelayMs = stopReason === undefined ? Math.min(intervalMs * 2 ** failures, maxBackoff) : null;
      cycles.push({ number, observation, execution, consecutiveObservationFailures: failures, nextDelayMs });
      if (stopReason !== undefined) return finish(stopReason);
      try { await delay(nextDelayMs!, signal); }
      catch { return finish(signal?.aborted ? 'aborted' : 'scheduler-error'); }
    }
    return finish('max-cycles');
  } finally { activeStates.delete(stateKey); }
}
