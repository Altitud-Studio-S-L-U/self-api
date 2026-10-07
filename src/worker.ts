import { createHash } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isProxy } from 'node:util/types';
import { compareOpenApi } from './compare.js';
import { loadOpenApi } from './openapi.js';
import { readLocalBytes } from './local-file.js';
import { captureConsumer } from './consumer-files.js';
import { scanCapturedConsumer } from './scan.js';
import { analyzeCapturedImpact } from './impact.js';
import { openWorkerStore } from './worker-store.js';
import type { WorkerJob, WorkerSubscription } from './worker-store.js';
import { PlumberError } from './errors.js';
import { captureHttpSource, HttpSourceError, prepareHttpSource } from './http-source.js';
import type { HttpSourceCredentials, HttpSourceDependencies, HttpSourcePolicy, HttpSourceSnapshot } from './http-source.js';

export interface LocalSubscriptionOptions {
  readonly statePath: string;
  readonly sourcePath: string;
  readonly baselinePath: string;
  readonly consumerRoot: string;
  readonly providerBaseUrl: string;
  readonly enginePath: string;
  readonly label?: string;
}

export interface HttpSubscriptionOptions extends Omit<LocalSubscriptionOptions, 'sourcePath'> {
  readonly source: HttpSourcePolicy;
}

export interface HttpObservationOptions {
  /** Every cycle must explicitly enable network source capture; registration alone does not enable it. */
  readonly allowHttp?: boolean;
  readonly httpCredentials?: (source: HttpSourcePolicy) => HttpSourceCredentials | undefined;
  readonly httpDependencies?: HttpSourceDependencies;
  readonly signal?: AbortSignal;
}

export interface ObserveOptions extends HttpObservationOptions {
  readonly statePath: string;
  readonly enginePath: string;
  readonly subscriptionId?: string;
}

export interface ObservationCycle {
  readonly schemaVersion: 1;
  readonly aborted?: true;
  readonly results: readonly {
    subscriptionId: string;
    status: 'observed' | 'unchanged' | 'busy' | 'failed';
    jobId?: string;
    created?: boolean;
    reason?: string;
  }[];
}

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }

type ObservationPhase = 'source' | 'contract' | 'consumer' | 'analysis' | 'state';

function failureReason(error: unknown, phase: ObservationPhase): string {
  if (error instanceof HttpSourceError) return `http-${error.reason}`;
  if (error instanceof PlumberError) {
    if (error.code === 'STATE_LIMIT') return 'state-limit';
    if (error.code === 'LEASE_LOST') return 'lease-lost';
    if (error.code === 'UNSUPPORTED_CONTRACT') return 'unsupported-contract';
    if (error.code === 'INVALID_INPUT' && (phase === 'contract' || phase === 'analysis')) return 'invalid-contract';
  }
  return phase === 'source' ? 'source-unavailable' : phase === 'consumer' ? 'consumer-unavailable' : 'analysis-failed';
}

function outsideConsumer(statePath: string, consumerRoot: string): void {
  const state = resolve(statePath);
  const consumer = resolve(consumerRoot);
  const contains = (parent: string, child: string): boolean => {
    const value = relative(parent, child);
    return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
  };
  if (contains(state, consumer) || contains(consumer, state)) {
    invalid('Worker state must be outside the consumer directory and cannot contain it.');
  }
}

export async function openExistingWorkerStore(statePath: string) {
  try {
    const attributes = await lstat(join(statePath, 'worker.sqlite3'));
    if (!attributes.isFile() || attributes.isSymbolicLink()) invalid('Worker state must be an existing regular local database.');
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('No worker database exists in the selected state directory; register a subscription first.');
  }
  return openWorkerStore(statePath);
}

export async function withContractCopies<T>(statePath: string, base: Uint8Array, revision: Uint8Array,
  action: (paths: { basePath: string; revisionPath: string }) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(statePath, '.observe-'));
  try {
    const basePath = join(directory, 'base.json');
    const revisionPath = join(directory, 'revision.json');
    await writeFile(basePath, base, { flag: 'wx', mode: 0o600 });
    await writeFile(revisionPath, revision, { flag: 'wx', mode: 0o600 });
    return await action({ basePath, revisionPath });
  } finally {
    const actual = await realpath(directory);
    const attributes = await lstat(directory);
    if (attributes.isSymbolicLink() || actual !== directory || dirname(actual) !== statePath || !basename(actual).startsWith('.observe-')) {
      invalid('The owned observation directory changed; cleanup was withheld.');
    }
    await rm(actual, { recursive: true, force: false });
  }
}

/** Configures a comparison baseline; it does not assert what the customer has adopted or deployed. */
async function registerConfiguredSubscription(options: LocalSubscriptionOptions, httpSource: HttpSourcePolicy | null): Promise<WorkerSubscription> {
  outsideConsumer(options.statePath, options.consumerRoot);
  if (options.label !== undefined && (typeof options.label !== 'string' || options.label.trim().length === 0 || Buffer.byteLength(options.label) > 200)) {
    invalid('Subscription labels must be nonempty and no larger than 200 UTF-8 bytes.');
  }
  const baselineBytes = await readLocalBytes(options.baselinePath, 4 * 1024 * 1024);
  // Check the selected source as a local regular file, but let observation report invalid future content.
  if (httpSource === null) await readLocalBytes(options.sourcePath, 4 * 1024 * 1024);
  const captured = await captureConsumer(options.consumerRoot);
  const inventory = scanCapturedConsumer(captured);
  const sourcePath = httpSource === null ? await realpath(options.sourcePath) : httpSource.url;
  const consumerRoot = await realpath(options.consumerRoot);
  const store = await openWorkerStore(options.statePath);
  try {
    outsideConsumer(store.statePath, consumerRoot);
    return await withContractCopies(store.statePath, baselineBytes, baselineBytes, async paths => {
      const comparison = await compareOpenApi({ ...paths, enginePath: options.enginePath });
      const base = await loadOpenApi(paths.basePath);
      const report = analyzeCapturedImpact({ comparison, inventory, base, providerBaseUrl: options.providerBaseUrl });
      const providerBaseUrl = `${report.provider.origin}${report.provider.basePath}`;
      const identityPaths = process.platform === 'win32' ? [sourcePath.toLowerCase(), consumerRoot.toLowerCase()] : [sourcePath, consumerRoot];
      const identity = httpSource === null ? [...identityPaths, providerBaseUrl]
        : ['https', httpSource.id, identityPaths[1], providerBaseUrl];
      const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      return store.register({ id, label: options.label ?? report.provider.origin, sourcePath, consumerRoot, providerBaseUrl,
        baseline: { bytes: baselineBytes, metadata: base.metadata }, ...(httpSource === null ? {} : { httpSource }) });
    });
  } finally { store.close(); }
}

/** Configures a local read-only source without any network access. */
export async function registerLocalSubscription(options: LocalSubscriptionOptions): Promise<WorkerSubscription> {
  return registerConfiguredSubscription(options, null);
}

/** Persists an explicit HTTPS policy with a local baseline. Registration performs no HTTP or credential lookup. */
export async function registerHttpSubscription(options: HttpSubscriptionOptions): Promise<WorkerSubscription> {
  const source = prepareHttpSource(options.source);
  if (source.contentKind !== 'json') invalid('OpenAPI observation requires a JSON HTTP source.');
  return registerConfiguredSubscription({ ...options, sourcePath: source.url }, source);
}

/** One bounded, explicit polling cycle. Importing the SDK never starts it. */
export async function observeOnce(options: ObserveOptions): Promise<ObservationCycle> {
  options = { ...options };
  if ((options.allowHttp !== undefined && typeof options.allowHttp !== 'boolean')
    || (options.httpCredentials !== undefined && typeof options.httpCredentials !== 'function')) invalid('HTTP observation requires explicit enablement and a trusted credential resolver.');
  if (options.signal !== undefined && (isProxy(options.signal) || !(options.signal instanceof AbortSignal))) invalid('Worker observation cancellation requires an AbortSignal.');
  const store = await openExistingWorkerStore(options.statePath);
  const results: ObservationCycle['results'][number][] = [];
  try {
    const subscriptions = store.listSubscriptions().filter(item => options.subscriptionId === undefined || item.id === options.subscriptionId);
    if (options.subscriptionId !== undefined && subscriptions.length === 0) invalid('The selected subscription does not exist.');
    for (const subscription of subscriptions) {
      if (options.signal?.aborted) break;
      const lease = store.claim(subscription.id);
      if (!lease) { results.push({ subscriptionId: subscription.id, status: 'busy' }); continue; }
      let phase: ObservationPhase = 'source';
      try {
        outsideConsumer(store.statePath, subscription.consumerRoot);
        let httpSnapshot: HttpSourceSnapshot | undefined;
        let revisionBytes: Buffer;
        if (subscription.httpSource) {
          if (options.allowHttp !== true) {
            store.failObservation({ lease, reason: 'http-not-enabled' });
            results.push({ subscriptionId: subscription.id, status: 'failed', reason: 'http-not-enabled' });
            continue;
          }
          // Load conditional evidence only after owning the lease; another process may have committed before this claim.
          const previous = store.getHttpSnapshot(subscription.id, lease);
          if (options.signal?.aborted) {
            store.failObservation({ lease, reason: 'http-aborted' });
            break;
          }
          const credentials = options.httpCredentials?.(subscription.httpSource);
          const captured = await captureHttpSource({ source: subscription.httpSource,
            ...(previous === undefined ? {} : { previous }), ...(credentials === undefined ? {} : { credentials }),
            ...(options.signal === undefined ? {} : { signal: options.signal }) }, options.httpDependencies);
          revisionBytes = Buffer.from(captured.snapshot.bytes);
          httpSnapshot = { ...captured.snapshot, bytes: revisionBytes };
        } else revisionBytes = await readLocalBytes(subscription.sourcePath, 4 * 1024 * 1024);
        const baseline = store.getBaseline(subscription.id);
        const observed = await withContractCopies(store.statePath, baseline.bytes, revisionBytes, async paths => {
          phase = 'contract';
          const base = await loadOpenApi(paths.basePath);
          const revision = await loadOpenApi(paths.revisionPath);
          phase = 'consumer';
          const captured = await captureConsumer(subscription.consumerRoot);
          const inventory = scanCapturedConsumer(captured);
          phase = 'analysis';
          const comparison = await compareOpenApi({ ...paths, enginePath: options.enginePath });
          const report = analyzeCapturedImpact({ comparison, inventory, base, providerBaseUrl: subscription.providerBaseUrl });
          return { snapshot: { bytes: revisionBytes, metadata: revision.metadata }, report };
        });
        phase = 'state';
        const committed = store.completeObservation({ lease, ...observed, ...(httpSnapshot === undefined ? {} : { httpSnapshot }) });
        results.push({ subscriptionId: subscription.id, status: committed.transition ? 'observed' : 'unchanged',
          created: committed.created, ...(committed.job ? { jobId: committed.job.id } : {}) });
      } catch (error) {
        let reason = failureReason(error, phase);
        if (reason !== 'lease-lost') {
          try { store.failObservation({ lease, reason }); }
          catch (failure) { reason = failure instanceof PlumberError && failure.code === 'LEASE_LOST' ? 'lease-lost' : 'state-unavailable'; }
        }
        results.push({ subscriptionId: subscription.id, status: 'failed', reason });
      }
    }
    return { schemaVersion: 1, results, ...(options.signal?.aborted ? { aborted: true as const } : {}) };
  } finally { store.close(); }
}

export async function listLocalSubscriptions(options: { readonly statePath: string }): Promise<WorkerSubscription[]> {
  const store = await openExistingWorkerStore(options.statePath);
  try { return store.listSubscriptions(); } finally { store.close(); }
}

export async function listMaintenanceJobs(options: { readonly statePath: string }): Promise<WorkerJob[]> {
  const store = await openExistingWorkerStore(options.statePath);
  try { return store.listJobs(); } finally { store.close(); }
}
