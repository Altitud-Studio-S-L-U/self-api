import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMigrationPlan } from './migration-plan.js';
import type { MigrationPlan, MigrationPlanOptions } from './migration-plan.js';
import { captureConsumer } from './consumer-files.js';
import type { ConsumerCapture } from './consumer-files.js';
import { issueApproval, consumeApproval } from './approval-store.js';
import type { ApprovalReceipt } from './approval-store.js';
import { dockerProfileForTests, isSupportedDockerTestPath, runDockerValidation } from './docker-runner.js';
import type { DockerProfile, DockerValidationResult } from './docker-runner.js';
import { PlumberError } from './errors.js';
import { persistValidationOutcome } from './validation-outcome.js';

export interface MigrationValidationOptions extends MigrationPlanOptions {
  readonly testPaths: readonly string[];
}

export interface MigrationValidationRequest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly plan: MigrationPlan;
  readonly spec: {
    readonly planId: string;
    readonly consumerDigest: string;
    readonly profile: DockerProfile;
    readonly testPaths: readonly string[];
    readonly actions: readonly ['baseline', 'candidate'];
  };
  readonly executionDigest: string;
  readonly policyDigest: string;
}

export interface MigrationValidationResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly receiptId: string;
  readonly status: 'passed' | 'improved' | 'regression' | 'failed' | 'blocked';
  readonly baseline: DockerValidationResult;
  readonly candidate?: DockerValidationResult;
  readonly consumerModified: false;
  readonly publication: 'not-authorized';
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function portablePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path.length <= 500
    && !/[\\:\u0000-\u001f\u007f]/u.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

async function prepare(options: MigrationValidationOptions): Promise<{
  request: MigrationValidationRequest;
  captured: ConsumerCapture;
}> {
  if (!Array.isArray(options.testPaths) || options.testPaths.length === 0 || options.testPaths.length > 20) {
    invalid('Select between 1 and 20 captured test files from one runtime explicitly.');
  }
  const testPaths = [...options.testPaths];
  if (testPaths.some(path => !isSupportedDockerTestPath(path)) || new Set(testPaths).size !== testPaths.length) {
    invalid('Validation paths must be unique relative source paths without traversal.');
  }
  let profile: DockerProfile;
  try { profile = dockerProfileForTests(testPaths); }
  catch { invalid('A validation request must select tests from exactly one supported runtime profile.'); }
  const plan = await createMigrationPlan(options);
  if (plan.status !== 'ready-for-review' || plan.files.length === 0) {
    invalid('Resolve migration decisions and provide a nonempty proposal before requesting validation.');
  }
  const captured = await captureConsumer(options.consumerRoot);
  if (captured.digest !== plan.evidence.consumerDigest) invalid('Consumer evidence changed; prepare a fresh request.');
  if ([...captured.files, ...captured.manifests].some(file => !portablePath(file.path))) {
    invalid('A captured filename cannot be represented by the isolated validation profile.');
  }
  for (const path of testPaths) {
    if (!captured.files.some(file => file.path === path)) invalid('Every selected test must be a captured source file.');
    if (plan.files.some(file => file.path === path)) invalid('This profile preserves selected tests; a recipe cannot edit them.');
  }
  const spec: MigrationValidationRequest['spec'] = {
    planId: plan.id,
    consumerDigest: captured.digest,
    profile,
    testPaths,
    actions: ['baseline', 'candidate'],
  };
  const executionDigest = digest(spec);
  const policyDigest = digest({
    version: 1,
    profile,
    snapshots: 'captured-source-and-package-manifests-only',
    dependencyInstallation: false,
    selectedTestMutation: false,
    liveConsumerMutation: false,
    publication: false,
    attemptsPerApproval: 1,
  });
  return {
    request: { schemaVersion: 1, id: digest({ executionDigest, policyDigest }), plan, spec, executionDigest, policyDigest },
    captured,
  };
}

/** Inspection only. Returned previews are private local artifacts, never Cloud messages. */
export async function prepareMigrationValidation(options: MigrationValidationOptions): Promise<MigrationValidationRequest> {
  return (await prepare(options)).request;
}

/** Explicit authorization by a trusted local caller, not proof of a human identity. */
export async function approveMigrationValidation(input: {
  options: MigrationValidationOptions;
  expectedRequestId: string;
  statePath: string;
  origin: 'local-cli' | 'explicit-sdk-caller';
}): Promise<ApprovalReceipt> {
  const { request } = await prepare(input.options);
  if (request.id !== input.expectedRequestId) invalid('The reviewed request changed; review the current proposal before approval.');
  return issueApproval({
    statePath: input.statePath,
    consumerRoot: input.options.consumerRoot,
    planId: request.plan.id,
    executionDigest: request.executionDigest,
    policyDigest: request.policyDigest,
    origin: input.origin,
  });
}

async function stageSnapshot(path: string, captured: ConsumerCapture, plan?: MigrationPlan): Promise<void> {
  await mkdir(path, { mode: 0o755 });
  // The private attempt parent protects host access; the mounted root must be readable by the container UID even with umask 077.
  await chmod(path, 0o755);
  for (const file of [...captured.files, ...captured.manifests]) {
    const segments = file.path.split('/');
    const target = join(path, ...segments);
    let directory = path;
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      await mkdir(directory, { recursive: true, mode: 0o755 });
      await chmod(directory, 0o755);
    }
    const changed = plan?.files.find(candidate => candidate.path === file.path);
    if (changed && (changed.beforeSha256 !== file.sha256 || changed.before !== file.text)) {
      invalid('Captured source no longer matches the approved proposal.');
    }
    await writeFile(target, changed?.after ?? file.text, { flag: 'wx', mode: 0o444 });
    await chmod(target, 0o444);
  }
}

function completed(result: DockerValidationResult): boolean {
  return result.status === 'passed' || result.status === 'failed';
}

/** Consumes one approval before staging. Failures do not restore or silently retry it. */
export async function executeMigrationValidation(input: {
  options: MigrationValidationOptions;
  statePath: string;
  receiptId: string;
  intentId?: string;
  guard?: () => void;
}): Promise<MigrationValidationResult> {
  if (input.intentId !== undefined && (typeof input.intentId !== 'string' || !/^[a-f0-9]{64}$/u.test(input.intentId))) {
    invalid('Execution intent identifiers must be canonical hashes.');
  }
  input.guard?.();
  const { request, captured } = await prepare(input.options);
  input.guard?.();
  const { attemptPath } = await consumeApproval({
    statePath: input.statePath,
    consumerRoot: input.options.consumerRoot,
    receiptId: input.receiptId,
    planId: request.plan.id,
    executionDigest: request.executionDigest,
    policyDigest: request.policyDigest,
  });
  input.guard?.();
  // Snapshots use captured bytes; the live checkout is never a container mount.
  await writeFile(join(attemptPath, 'request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  const baselinePath = join(attemptPath, 'baseline');
  const candidatePath = join(attemptPath, 'candidate');
  await stageSnapshot(baselinePath, captured);
  await stageSnapshot(candidatePath, captured, request.plan);
  const execution = { intentId: input.intentId ?? createHash('sha256').update(input.receiptId).digest('hex'), receiptId: input.receiptId, requestId: request.id };
  const guard = input.guard ?? (() => {});
  guard();
  const baseline = await runDockerValidation({ snapshotPath: baselinePath, testPaths: request.spec.testPaths, statePath: attemptPath,
    execution: { ...execution, phase: 'baseline' }, guard });
  let candidate: DockerValidationResult | undefined;
  if (completed(baseline)) {
    guard();
    candidate = await runDockerValidation({ snapshotPath: candidatePath, testPaths: request.spec.testPaths, statePath: attemptPath,
      execution: { ...execution, phase: 'candidate' }, guard });
  }
  let status: MigrationValidationResult['status'] = 'blocked';
  if (completed(baseline) && candidate && completed(candidate)) {
    status = candidate.status === 'passed'
      ? (baseline.status === 'passed' ? 'passed' : 'improved')
      : (baseline.status === 'passed' ? 'regression' : 'failed');
  }
  const result: MigrationValidationResult = {
    schemaVersion: 1, requestId: request.id, receiptId: input.receiptId, status,
    baseline, ...(candidate ? { candidate } : {}), consumerModified: false, publication: 'not-authorized',
  };
  guard();
  await persistValidationOutcome({ attemptPath, result, ...(input.intentId ? { intentId: input.intentId } : {}) });
  return result;
}
