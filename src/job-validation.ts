import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectApproval } from './approval-store.js';
import type { ApprovalReceipt } from './approval-store.js';
import { captureConsumer } from './consumer-files.js';
import { recoverDockerValidation } from './docker-runner.js';
import { PlumberError } from './errors.js';
import { readLocalBytes } from './local-file.js';
import { serializeMigrationRecipe } from './migration-recipe.js';
import { approveMigrationValidation, executeMigrationValidation, prepareMigrationValidation } from './migration-validation.js';
import type { MigrationValidationOptions, MigrationValidationRequest } from './migration-validation.js';
import { readValidationOutcome } from './validation-outcome.js';
import type { ValidationOutcome } from './validation-outcome.js';
import { openExistingWorkerStore, withContractCopies } from './worker.js';
import type { ExecutionBlockReason, ExecutionIntent, WorkerStore } from './worker-store.js';

export interface JobValidationOptions {
  readonly statePath: string;
  readonly jobId: string;
  readonly enginePath: string;
  readonly recipe: unknown;
  readonly testPaths: readonly string[];
}

export interface JobExecutionCycle {
  readonly schemaVersion: 1;
  readonly results: readonly {
    intentId: string;
    status: 'completed' | 'blocked' | 'interrupted' | 'lease-lost';
    outcome?: ValidationOutcome;
    reason?: string;
  }[];
}

class JobEvidenceError extends PlumberError {
  constructor(readonly reason: ExecutionBlockReason, message: string) { super('INVALID_INPUT', message); }
}

function stale(): never {
  throw new JobEvidenceError('stale-evidence', 'Job evidence no longer matches the current source or consumer; observe and review again.');
}

function copiedInputs(input: JobValidationOptions): { recipeJson: string; testPaths: string[] } {
  const recipeJson = serializeMigrationRecipe(input.recipe);
  if (!Array.isArray(input.testPaths) || input.testPaths.length < 1 || input.testPaths.length > 20
    || input.testPaths.some(path => typeof path !== 'string')) {
    throw new PlumberError('INVALID_INPUT', 'Select 1–20 explicit test paths for the job.');
  }
  return { recipeJson, testPaths: [...input.testPaths] };
}

async function withFreshJob<T>(store: WorkerStore, input: JobValidationOptions,
  action: (options: MigrationValidationOptions, request: MigrationValidationRequest) => Promise<T>): Promise<T> {
  const { job, subscription, baseline, revision } = store.getJobEvidence(input.jobId);
  const { recipeJson, testPaths } = copiedInputs(input);
  const currentSource = async (): Promise<Uint8Array> => {
    if (!subscription.httpSource) return readLocalBytes(subscription.sourcePath, 4 * 1024 * 1024).catch(() => stale());
    // This verifies the last successful explicit capture, not present-time remote behavior. No implicit network access.
    try {
      const current = store.getHttpSnapshot(subscription.id);
      if (!current || current.sourceId !== subscription.httpSource.id || current.origin !== subscription.httpSource.origin
        || current.authContextId !== subscription.httpSource.authContextId || current.sha256 !== job.revisionSha) stale();
      return current.bytes;
    } catch { stale(); }
  };
  const current = await currentSource();
  const consumer = await captureConsumer(subscription.consumerRoot).catch(() => stale());
  if (createHash('sha256').update(current).digest('hex') !== job.revisionSha || consumer.digest !== job.consumerDigest) stale();
  return withContractCopies(store.statePath, baseline.bytes, revision.bytes, async paths => {
    const options: MigrationValidationOptions = { ...paths, enginePath: input.enginePath,
      consumerRoot: subscription.consumerRoot, providerBaseUrl: subscription.providerBaseUrl,
      recipe: JSON.parse(recipeJson) as unknown, testPaths };
    const request = await prepareMigrationValidation(options);
    if (request.plan.evidence.consumerDigest !== job.consumerDigest
      || request.plan.evidence.baseSha256 !== job.baselineSha || request.plan.evidence.revisionSha256 !== job.revisionSha
      || request.plan.impact.comparison.engine.version !== job.engineVersion) stale();
    if (subscription.httpSource) await currentSource();
    return action(options, request);
  });
}

export async function prepareJobValidation(input: JobValidationOptions): Promise<MigrationValidationRequest> {
  const frozen = copiedInputs(input);
  const store = await openExistingWorkerStore(input.statePath);
  try { return await withFreshJob(store, { ...input, recipe: JSON.parse(frozen.recipeJson), testPaths: frozen.testPaths }, async (_options, request) => request); }
  finally { store.close(); }
}

/** This explicit action issues authorization; neither observation nor queue processing calls it. */
export async function approveJobValidation(input: JobValidationOptions & {
  readonly expectedRequestId: string;
  readonly origin: 'local-cli' | 'explicit-sdk-caller';
}): Promise<ApprovalReceipt> {
  const frozen = copiedInputs(input);
  const store = await openExistingWorkerStore(input.statePath);
  try {
    return await withFreshJob(store, { ...input, recipe: JSON.parse(frozen.recipeJson), testPaths: frozen.testPaths }, async options =>
      approveMigrationValidation({ options, expectedRequestId: input.expectedRequestId, statePath: store.statePath, origin: input.origin }));
  } finally { store.close(); }
}

/** Persist an existing, still-valid approval without consuming it or starting execution. */
export async function queueJobValidation(input: JobValidationOptions & { readonly receiptId: string }): Promise<{ intent: ExecutionIntent; created: boolean }> {
  const frozen = copiedInputs(input);
  const store = await openExistingWorkerStore(input.statePath);
  try {
    return await withFreshJob(store, { ...input, recipe: JSON.parse(frozen.recipeJson), testPaths: frozen.testPaths }, async (options, request) => {
      await inspectApproval({ statePath: store.statePath, consumerRoot: options.consumerRoot, receiptId: input.receiptId,
        planId: request.plan.id, executionDigest: request.executionDigest, policyDigest: request.policyDigest });
      return store.enqueueExecution({ jobId: input.jobId, receiptId: input.receiptId, requestId: request.id,
        planId: request.plan.id, executionDigest: request.executionDigest, policyDigest: request.policyDigest,
        recipeJson: frozen.recipeJson, testPaths: frozen.testPaths });
    });
  } finally { store.close(); }
}

function cleanupUnresolved(outcome: ValidationOutcome): boolean {
  return outcome.baseline.cleanup === 'failed' || outcome.candidate?.cleanup === 'failed';
}

function boundedLimit(limit = 1): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new PlumberError('INVALID_INPUT', 'A job pass must process between 1 and 10 intents.');
  return limit;
}

async function attemptExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function outcomeBindings(statePath: string, intent: ExecutionIntent) {
  return { attemptPath: join(statePath, 'attempts', intent.receiptId), intentId: intent.id,
    requestId: intent.requestId, receiptId: intent.receiptId };
}

/** Executes only queued authorizations; an interrupted attempt is never eligible for execution again. */
export async function runApprovedJobsOnce(input: {
  readonly statePath: string; readonly enginePath: string; readonly intentId?: string; readonly limit?: number;
}): Promise<JobExecutionCycle> {
  const limit = boundedLimit(input.limit);
  const store = await openExistingWorkerStore(input.statePath);
  const results: JobExecutionCycle['results'][number][] = [];
  try {
    for (let index = 0; index < limit; index += 1) {
      const claim = store.claimExecution(input.intentId);
      if (!claim) break;
      const { intent } = claim;
      const progress: { phase: 'evidence' | 'approval' | 'execution' } = { phase: 'evidence' };
      try {
        await withFreshJob(store, { statePath: store.statePath, jobId: intent.jobId, enginePath: input.enginePath,
          recipe: JSON.parse(intent.recipeJson), testPaths: intent.testPaths }, async (options, request) => {
          store.assertExecutionOwnership(claim);
          if (request.id !== intent.requestId || request.plan.id !== intent.planId
            || request.executionDigest !== intent.executionDigest || request.policyDigest !== intent.policyDigest) {
            throw new JobEvidenceError('request-mismatch', 'The queued request changed; review and authorize the current request.');
          }
          progress.phase = 'approval';
          await inspectApproval({ statePath: store.statePath, consumerRoot: options.consumerRoot, receiptId: intent.receiptId,
            planId: request.plan.id, executionDigest: request.executionDigest, policyDigest: request.policyDigest });
          progress.phase = 'execution';
          await executeMigrationValidation({ options, statePath: store.statePath, receiptId: intent.receiptId,
            intentId: intent.id, guard: () => { store.assertExecutionOwnership(claim); } });
        });
        const outcome = await readValidationOutcome(outcomeBindings(store.statePath, intent));
        if (!outcome) throw new PlumberError('INVALID_INPUT', 'Execution returned without a durable outcome.');
        if (cleanupUnresolved(outcome)) {
          store.interruptExecution({ claim, reason: 'cleanup-unresolved' });
          results.push({ intentId: intent.id, status: 'interrupted', outcome, reason: 'cleanup-unresolved' });
        } else {
          store.completeExecution({ claim, outcome });
          results.push({ intentId: intent.id, status: 'completed', outcome });
        }
      } catch (error) {
        try {
          store.assertExecutionOwnership(claim);
          // Once consumption may have occurred, preserve recovery eligibility even if the result write failed.
          if (await attemptExists(outcomeBindings(store.statePath, intent).attemptPath)) {
            store.interruptExecution({ claim, reason: 'cleanup-unresolved' });
            results.push({ intentId: intent.id, status: 'interrupted', reason: 'cleanup-unresolved' });
          } else {
            const reason = error instanceof JobEvidenceError ? error.reason : progress.phase === 'approval' ? 'approval-invalid' : 'execution-failed';
            store.blockExecution({ claim, reason });
            results.push({ intentId: intent.id, status: 'blocked', reason });
          }
        } catch (failure) {
          if (!(failure instanceof PlumberError) || failure.code !== 'LEASE_LOST') throw failure;
          results.push({ intentId: intent.id, status: 'lease-lost', reason: 'lease-lost' });
        }
      }
      if (input.intentId !== undefined) break;
    }
    return { schemaVersion: 1, results };
  } finally { store.close(); }
}

/** Reconciles outcomes and owned containers only. It cannot start or repeat a consumer command. */
export async function recoverApprovedJobs(input: {
  readonly statePath: string; readonly limit?: number;
}): Promise<JobExecutionCycle> {
  const limit = boundedLimit(input.limit);
  const store = await openExistingWorkerStore(input.statePath);
  const results: JobExecutionCycle['results'][number][] = [];
  try {
    const recoverableIds = new Set(store.listExpiredExecutions().map(intent => intent.id));
    const ordered = store.listExecutionIntents().filter(intent => recoverableIds.has(intent.id)
      || (intent.status === 'interrupted' && ['execution-interrupted', 'invalid-outcome'].includes(intent.reason ?? '')))
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const candidates: ExecutionIntent[] = [];
    for (const intent of ordered) {
      if (!recoverableIds.has(intent.id)) {
        // A process may finish publishing after its lease expires. Only valid late artifacts warrant another claim.
        try { if (!await readValidationOutcome(outcomeBindings(store.statePath, intent))) continue; }
        catch { continue; }
      }
      candidates.push(intent);
      if (candidates.length === limit) break;
    }
    for (const intent of candidates) {
      const claim = store.claimRecovery(intent.id);
      if (!claim) continue;
      try {
        const bindings = outcomeBindings(store.statePath, intent);
        let invalidOutcome = false;
        let outcome: ValidationOutcome | null = null;
        if (await attemptExists(bindings.attemptPath)) {
          try { outcome = await readValidationOutcome(bindings); }
          catch { invalidOutcome = true; }
        }
        if (outcome && !cleanupUnresolved(outcome)) {
          store.reconcileExecution({ claim, outcome });
          results.push({ intentId: intent.id, status: 'completed', outcome });
          continue;
        }
        const recovered = await recoverDockerValidation({ statePath: bindings.attemptPath,
          execution: { intentId: intent.id, receiptId: intent.receiptId, requestId: intent.requestId },
          guard: () => { store.assertRecoveryOwnership(claim); } });
        if (recovered.cleanup === 'removed' || recovered.cleanup === 'not-created') {
          if (outcome) {
            store.reconcileExecution({ claim, outcome });
            results.push({ intentId: intent.id, status: 'completed', outcome, reason: 'cleanup-recovered' });
          } else {
            const reason = invalidOutcome ? 'invalid-outcome' : 'execution-interrupted';
            store.reconcileExecution({ claim, reason });
            results.push({ intentId: intent.id, status: 'interrupted', reason });
          }
        } else {
          store.reconcileExecution({ claim, reason: 'cleanup-unresolved' });
          results.push({ intentId: intent.id, status: 'interrupted', reason: 'cleanup-unresolved' });
        }
      } catch (error) {
        let leaseLost = error instanceof PlumberError && error.code === 'LEASE_LOST';
        if (!leaseLost) {
          try { store.reconcileExecution({ claim, reason: 'cleanup-unresolved' }); }
          catch (failure) {
            if (!(failure instanceof PlumberError) || failure.code !== 'LEASE_LOST') throw failure;
            leaseLost = true;
          }
        }
        results.push({ intentId: intent.id, status: leaseLost ? 'lease-lost' : 'interrupted',
          reason: leaseLost ? 'lease-lost' : 'cleanup-unresolved' });
      }
    }
    return { schemaVersion: 1, results };
  } finally { store.close(); }
}

export async function listJobExecutions(input: { readonly statePath: string }): Promise<ExecutionIntent[]> {
  const store = await openExistingWorkerStore(input.statePath);
  try { return store.listExecutionIntents(); } finally { store.close(); }
}
