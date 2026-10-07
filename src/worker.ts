import { createHash } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compareOpenApi } from './compare.js';
import { loadOpenApi } from './openapi.js';
import { readLocalBytes } from './local-file.js';
import { captureConsumer } from './consumer-files.js';
import { scanCapturedConsumer } from './scan.js';
import { analyzeCapturedImpact } from './impact.js';
import { openWorkerStore } from './worker-store.js';
import type { WorkerJob, WorkerSubscription } from './worker-store.js';
import { PlumberError } from './errors.js';

export interface LocalSubscriptionOptions {
  readonly statePath: string;
  readonly sourcePath: string;
  readonly baselinePath: string;
  readonly consumerRoot: string;
  readonly providerBaseUrl: string;
  readonly enginePath: string;
  readonly label?: string;
}

export interface ObservationCycle {
  readonly schemaVersion: 1;
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
export async function registerLocalSubscription(options: LocalSubscriptionOptions): Promise<WorkerSubscription> {
  outsideConsumer(options.statePath, options.consumerRoot);
  if (options.label !== undefined && (typeof options.label !== 'string' || options.label.trim().length === 0 || Buffer.byteLength(options.label) > 200)) {
    invalid('Subscription labels must be nonempty and no larger than 200 UTF-8 bytes.');
  }
  const baselineBytes = await readLocalBytes(options.baselinePath, 4 * 1024 * 1024);
  // Check the selected source as a local regular file, but let observation report invalid future content.
  await readLocalBytes(options.sourcePath, 4 * 1024 * 1024);
  const captured = await captureConsumer(options.consumerRoot);
  const inventory = scanCapturedConsumer(captured);
  const sourcePath = await realpath(options.sourcePath);
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
      const id = createHash('sha256').update(JSON.stringify([...identityPaths, providerBaseUrl])).digest('hex');
      return store.register({ id, label: options.label ?? report.provider.origin, sourcePath, consumerRoot, providerBaseUrl,
        baseline: { bytes: baselineBytes, metadata: base.metadata } });
    });
  } finally { store.close(); }
}

/** One bounded, explicit polling cycle. Importing the SDK never starts it. */
export async function observeOnce(options: {
  readonly statePath: string;
  readonly enginePath: string;
  readonly subscriptionId?: string;
}): Promise<ObservationCycle> {
  const store = await openExistingWorkerStore(options.statePath);
  const results: ObservationCycle['results'][number][] = [];
  try {
    const subscriptions = store.listSubscriptions().filter(item => options.subscriptionId === undefined || item.id === options.subscriptionId);
    if (options.subscriptionId !== undefined && subscriptions.length === 0) invalid('The selected subscription does not exist.');
    for (const subscription of subscriptions) {
      const lease = store.claim(subscription.id);
      if (!lease) { results.push({ subscriptionId: subscription.id, status: 'busy' }); continue; }
      let phase: ObservationPhase = 'source';
      try {
        outsideConsumer(store.statePath, subscription.consumerRoot);
        const revisionBytes = await readLocalBytes(subscription.sourcePath, 4 * 1024 * 1024);
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
        const committed = store.completeObservation({ lease, ...observed });
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
    return { schemaVersion: 1, results };
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
