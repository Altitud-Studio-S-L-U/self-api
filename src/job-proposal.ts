import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { compareOpenApi } from './compare.js';
import { captureConsumer } from './consumer-files.js';
import { PlumberError } from './errors.js';
import { analyzeCapturedImpact } from './impact.js';
import { readLocalBytes } from './local-file.js';
import { prepareModelProposal, proposeMigrationWithModel } from './model-harness.js';
import type { ModelAdapterIdentity, ModelMigrationProposal, ModelNoProposal, ModelProposalAdapter, ModelProposalConsent, ModelProposalRequest, PrepareModelProposalOptions } from './model-harness.js';
import { scanCapturedConsumer } from './scan.js';
import { openExistingWorkerStore, withContractCopies } from './worker.js';

export interface JobProposalOptions {
  readonly statePath: string;
  readonly jobId: string;
  readonly enginePath: string;
  readonly adapter: ModelAdapterIdentity;
  /** Omit to suggest source files from matched calls and their directly traced parsers. */
  readonly sourcePaths?: readonly string[];
  /** Explicit read-only context. Discovery never selects or executes tests automatically. */
  readonly testPaths?: readonly string[];
  readonly evidence?: PrepareModelProposalOptions['evidence'];
  readonly requiredDecisions?: PrepareModelProposalOptions['requiredDecisions'];
  readonly sensitiveValues?: PrepareModelProposalOptions['sensitiveValues'];
  readonly limits?: PrepareModelProposalOptions['limits'];
}

export interface JobProposalBinding {
  readonly jobId: string;
  readonly subscriptionId: string;
  readonly consumerRootId: string;
  readonly consumerDigest: string;
  readonly baselineSha256: string;
  readonly revisionSha256: string;
  readonly engineVersion: string;
}

export interface JobProposalRequest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly binding: JobProposalBinding;
  readonly modelRequest: ModelProposalRequest;
  readonly testPaths: readonly string[];
  readonly discovery: {
    readonly sourcePaths: readonly string[];
    readonly testPaths: readonly string[];
    readonly coverage: 'bounded-native-fetch-syntax';
    readonly unresolvedCallCount: number;
    readonly unmappedChangeCount: number;
    readonly inspectionIssueCount: number;
  };
  readonly authorization: 'not-granted';
  readonly consumerModified: false;
  readonly consumerExecuted: false;
}

export interface JobMigrationProposal extends Omit<ModelMigrationProposal, 'requestId'> {
  readonly requestId: string;
  readonly modelRequestId: string;
  readonly binding: JobProposalBinding;
  readonly testPaths: readonly string[];
}

export interface JobNoProposal extends Omit<ModelNoProposal, 'requestId'> {
  readonly requestId: string;
  readonly modelRequestId: string;
  readonly binding: JobProposalBinding;
  readonly testPaths: readonly string[];
}

export type JobProposalOutcome = JobMigrationProposal | JobNoProposal;

const prepared = new WeakMap<JobProposalRequest, JobProposalOptions>();
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const testPath = (path: string): boolean => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/iu.test(path);
function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function stale(): never { invalid('Job proposal evidence changed; observe and review the current source and consumer again.'); }

function selectedPaths(value: readonly string[] | undefined, maximum: number): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum || value.some(path => typeof path !== 'string')
    || new Set(value.map(path => path.toLowerCase())).size !== value.length) invalid('Select bounded, unique captured source and test paths.');
  return Object.freeze([...value].sort());
}

/** Capture and recompute evidence locally. Stored reports are never instructions or an authority for selecting files. */
export async function prepareJobProposal(options: JobProposalOptions): Promise<JobProposalRequest> {
  const sourcePaths = selectedPaths(options.sourcePaths, 50);
  const testPaths = selectedPaths(options.testPaths, 20) ?? Object.freeze([]);
  if (typeof options.jobId !== 'string' || !/^[a-f0-9]{64}$/u.test(options.jobId)) invalid('Select a canonical observed job ID.');
  // Capture caller policy before awaiting filesystem/engine work; functions and credentials are not configuration data.
  let input: JobProposalOptions;
  try {
    input = structuredClone({ statePath: options.statePath, jobId: options.jobId, enginePath: options.enginePath,
      adapter: { id: options.adapter.id, location: options.adapter.location, destination: options.adapter.destination, policyId: options.adapter.policyId },
      ...(sourcePaths ? { sourcePaths } : {}), testPaths,
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      ...(options.requiredDecisions === undefined ? {} : { requiredDecisions: options.requiredDecisions }),
      ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  } catch { invalid('Job proposal configuration must contain serializable policy data and a model adapter identity.'); }
  const store = await openExistingWorkerStore(input.statePath);
  try {
    const { job, subscription, baseline, revision } = store.getJobEvidence(input.jobId);
    const sourceIsFresh = async (): Promise<void> => {
      if (subscription.httpSource) {
        const current = store.getHttpSnapshot(subscription.id);
        if (!current || current.sourceId !== subscription.httpSource.id || current.origin !== subscription.httpSource.origin
          || current.authContextId !== subscription.httpSource.authContextId || current.sha256 !== job.revisionSha) stale();
      } else if (hash(await readLocalBytes(subscription.sourcePath, 4 * 1024 * 1024)) !== job.revisionSha) stale();
    };
    await sourceIsFresh();
    const captured = await captureConsumer(subscription.consumerRoot);
    if (captured.digest !== job.consumerDigest || hash(baseline.bytes) !== job.baselineSha || hash(revision.bytes) !== job.revisionSha) stale();
    const comparison = await withContractCopies(store.statePath, baseline.bytes, revision.bytes,
      paths => compareOpenApi({ ...paths, enginePath: input.enginePath }));
    if (comparison.engine.version !== job.engineVersion || comparison.base.sha256 !== job.baselineSha
      || comparison.revision.sha256 !== job.revisionSha
      || hash(JSON.stringify([subscription.id, job.baselineSha, job.revisionSha, captured.digest, comparison.engine.version])) !== job.id) stale();
    const inventory = scanCapturedConsumer(captured);
    const impact = analyzeCapturedImpact({ comparison, inventory, providerBaseUrl: subscription.providerBaseUrl,
      base: { metadata: baseline.metadata, json: Buffer.from(baseline.bytes).toString('utf8') } });
    const callIds = new Set(impact.matches.flatMap(match => match.callIds));
    const calls = inventory.calls.filter(call => callIds.has(call.id));
    const suggestedSources = [...new Set(calls.flatMap(call => [call.location.file, ...call.parserLocations.map(location => location.file)]))]
      .filter(path => !testPath(path)).sort();
    const suggestedTests = captured.files.filter(file => testPath(file.path)).map(file => file.path).sort();
    const sources = sourcePaths ?? suggestedSources;
    if (!sources.length) invalid('No matched editable source was found; explicitly select captured JavaScript or TypeScript files after reviewing the impact.');
    if (sources.some(path => testPaths.includes(path))) invalid('Selected tests are read-only and cannot also be editable source.');
    const files = [...sources.map(path => ({ path, role: 'source' as const })), ...testPaths.map(path => ({ path, role: 'test' as const }))]
      .map(selection => {
        const file = captured.files.find(file => file.path === selection.path);
        if (!file) invalid('Every selected source and test must be present in the captured consumer profile.');
        return { ...file, role: selection.role };
      });
    const binding: JobProposalBinding = Object.freeze({ jobId: job.id, subscriptionId: subscription.id,
      consumerRootId: hash(await realpath(subscription.consumerRoot)), consumerDigest: captured.digest,
      baselineSha256: job.baselineSha, revisionSha256: job.revisionSha, engineVersion: comparison.engine.version });
    const discovery = Object.freeze({ sourcePaths: Object.freeze(suggestedSources), testPaths: Object.freeze(suggestedTests),
      coverage: inventory.coverage, unresolvedCallCount: impact.unresolvedCallIds.length,
      unmappedChangeCount: impact.unmappedChangeIndexes.length, inspectionIssueCount: inventory.issues.length });
    const modelRequest = prepareModelProposal({ adapter: input.adapter, files,
      evidence: [
        { id: 'keepseam/job', text: JSON.stringify(binding) },
        { id: 'keepseam/contract-base', text: Buffer.from(baseline.bytes).toString('utf8') },
        { id: 'keepseam/contract-revision', text: Buffer.from(revision.bytes).toString('utf8') },
        { id: 'keepseam/impact', text: JSON.stringify({ comparison, provider: impact.provider, calls, matches: impact.matches,
          unmappedChangeIndexes: impact.unmappedChangeIndexes, unresolvedCallIds: impact.unresolvedCallIds, issues: inventory.issues,
          coverage: impact.coverage }) },
        ...(input.evidence ?? []),
      ],
      requiredDecisions: [...(input.requiredDecisions ?? []), ...(discovery.unresolvedCallCount || discovery.unmappedChangeCount || discovery.inspectionIssueCount
        ? [{ id: 'keepseam-coverage', question: 'Review unresolved calls, unmapped contract changes and inspection issues; selected edits and tests do not establish complete integration coverage.' }] : [])],
      ...(input.sensitiveValues ? { sensitiveValues: input.sensitiveValues } : {}), ...(input.limits ? { limits: input.limits } : {}),
    });
    await sourceIsFresh();
    if ((await captureConsumer(subscription.consumerRoot)).digest !== captured.digest) stale();
    const selectedTests = Object.freeze([...testPaths]);
    const id = hash(JSON.stringify({ binding, modelRequestId: modelRequest.id, testPaths: selectedTests, discovery }));
    const request: JobProposalRequest = Object.freeze({ schemaVersion: 1, id, binding, modelRequest, testPaths: selectedTests, discovery,
      authorization: 'not-granted', consumerModified: false, consumerExecuted: false });
    prepared.set(request, { ...input, sourcePaths: Object.freeze([...sources]), testPaths: selectedTests });
    return request;
  } finally { store.close(); }
}

/** A separately approved model call. No execution receipt, queue entry or publication permission is issued here. */
export async function proposeJobMigration(options: {
  readonly request: JobProposalRequest;
  readonly expectedRequestId: string;
  readonly consent: ModelProposalConsent;
  readonly adapter: ModelProposalAdapter;
  readonly signal?: AbortSignal;
}): Promise<JobProposalOutcome> {
  const { request } = options;
  const input = prepared.get(request);
  if (!input || options.expectedRequestId !== request.id) invalid('Inspect and confirm the exact locally prepared job proposal first.');
  const current = await prepareJobProposal(input);
  if (current.id !== request.id) stale();
  const proposal = await proposeMigrationWithModel({ request: request.modelRequest, consent: options.consent, adapter: options.adapter,
    ...(options.signal ? { signal: options.signal } : {}) });
  // The model may have taken minutes. Its answer cannot authorize edits to a checkout that changed while it was thinking.
  const after = await prepareJobProposal(input);
  if (after.id !== request.id) stale();
  return { ...proposal, requestId: request.id, modelRequestId: proposal.requestId, binding: request.binding, testPaths: request.testPaths };
}
