import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { CloudConnectionError, createCloudTransport, type CloudCredentials } from './cloud-connection.js';
import { syncWorkerToCloud } from './cloud-sync.js';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';
import { listSourceSubscriptions, observeSourcesOnce } from './source-observer.js';
import { listLocalSubscriptions, observeOnce, type ObservationCycle } from './worker.js';
import { normalizeWorkerServiceConfig, servicePath, type WorkerServiceConfig } from './worker-service-config.js';
import { appendServiceLog, checkServicePath, checkWindowsServiceAcl, hasServiceDatabase, lockWorkerService,
  readServiceRecord, serviceFailureDetails, serviceFiles, writeServiceSnapshot } from './worker-service-state.js';

export interface WorkerServiceStatus {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pid: number;
  readonly state: 'starting' | 'running' | 'degraded' | 'stopping' | 'stopped' | 'failed';
  readonly updatedAt: string;
  readonly cycles: number;
  readonly observation: 'pending' | 'healthy' | 'degraded';
  readonly cloud: 'disabled' | 'pending' | 'synced' | 'unavailable' | 'reconnect-required';
}

export interface WorkerServiceDependencies {
  /** Only trusted in-process adapters. JSON configuration cannot choose code, models or execution commands. */
  readonly observe?: typeof observeOnce;
  readonly observeSources?: typeof observeSourcesOnce;
  readonly sync?: typeof syncWorkerToCloud;
  /** A trusted scheduler seam; the default is a cancellable Node timer. */
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }

export async function loadWorkerServiceConfig(configPath: string): Promise<WorkerServiceConfig> {
  servicePath(configPath, process.platform === 'win32' ? 'windows' : 'systemd');
  checkServicePath(configPath, 'config');
  checkWindowsServiceAcl(configPath, false);
  return normalizeWorkerServiceConfig(await loadLocalJson(configPath, 64 * 1024));
}

export function readWorkerServiceStatus(config: WorkerServiceConfig): WorkerServiceStatus | undefined {
  checkServicePath(config.statePath, 'directory');
  checkWindowsServiceAcl(config.statePath, true);
  const result = readServiceRecord(config.statePath, serviceFiles.status);
  if (result === undefined) return undefined;
  if (result === null || typeof result !== 'object' || !('schemaVersion' in result) || result.schemaVersion !== 1
    || !('runId' in result) || typeof result.runId !== 'string' || !/^[a-f0-9-]{36}$/u.test(result.runId)) {
    invalid('Service status is invalid. Consult the native service manager.');
  }
  return result as WorkerServiceStatus;
}

/** Requests only the observed run to stop. A stale request never stops a replacement process. */
export function requestWorkerServiceStop(config: WorkerServiceConfig): { readonly requested: boolean; readonly runId?: string } {
  const status = readWorkerServiceStatus(config);
  if (!status || ['stopped', 'failed'].includes(status.state)) return { requested: false };
  writeServiceSnapshot(config.statePath, serviceFiles.stop, { schemaVersion: 1, runId: status.runId });
  return { requested: true, runId: status.runId };
}

function counts(cycle: ObservationCycle): { observed: number; unchanged: number; busy: number; failed: number } {
  if (!cycle || cycle.schemaVersion !== 1 || !Array.isArray(cycle.results) || cycle.results.length > 100) throw new Error('Invalid observer result.');
  const result = { observed: 0, unchanged: 0, busy: 0, failed: 0 };
  for (const item of cycle.results) {
    if (!['observed', 'unchanged', 'busy', 'failed'].includes(item.status)) throw new Error('Invalid observer status.');
    result[item.status as keyof typeof result] += 1;
  }
  return result;
}

/** Runs in the foreground until shutdown. The OS owns boot/restart; the SDK owns serialized observation and bounded local state. */
export async function runWorkerService(input: WorkerServiceConfig | unknown, options: {
  readonly signal?: AbortSignal;
  readonly dependencies?: WorkerServiceDependencies;
} = {}): Promise<WorkerServiceStatus> {
  const config = normalizeWorkerServiceConfig(input);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) invalid('A service requires an AbortSignal for cancellation.');
  const lock = await lockWorkerService(config.statePath);
  const controller = new AbortController();
  const wait = options.dependencies?.wait ?? ((milliseconds: number, signal: AbortSignal) => delay(milliseconds, undefined, { signal }));
  const abort = (): void => { controller.abort(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let monitorError = false;
  let monitor: NodeJS.Timeout | undefined;
  let status: WorkerServiceStatus = { schemaVersion: 1, runId: lock.runId, pid: process.pid, state: 'starting',
    updatedAt: new Date().toISOString(), cycles: 0, observation: 'pending', cloud: config.cloud ? 'pending' : 'disabled' };
  const update = (changes: Partial<WorkerServiceStatus>): void => {
    status = { ...status, ...changes, updatedAt: new Date().toISOString() };
    writeServiceSnapshot(lock.directory, serviceFiles.status, status);
  };
  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    appendServiceLog(lock.directory, { timestamp: new Date().toISOString(), runId: lock.runId, event, ...fields });
  };
  try {
    update({ state: 'starting' }); log('started');
    if (config.openApi && !hasServiceDatabase(lock.directory, 'worker.sqlite3')) invalid('Register OpenAPI subscriptions before starting the service.');
    if (config.sources && !hasServiceDatabase(lock.directory, 'source-observations.sqlite3')) invalid('Register source subscriptions before starting the service.');
    if (config.openApi && (await listLocalSubscriptions({ statePath: lock.directory })).length === 0) invalid('The OpenAPI service profile has no registered subscriptions.');
    if (config.sources && (await listSourceSubscriptions({ statePath: lock.directory })).length === 0) invalid('The source service profile has no registered subscriptions.');
    let credentials: CloudCredentials | undefined;
    if (config.cloud) {
      checkServicePath(config.cloud.statePath, 'directory'); checkWindowsServiceAcl(config.cloud.statePath, true);
      checkServicePath(config.cloud.credentialsPath, 'secret'); checkWindowsServiceAcl(config.cloud.credentialsPath, true);
      credentials = await loadLocalJson(config.cloud.credentialsPath, 16_384) as CloudCredentials;
      createCloudTransport(credentials);
    }
    // Windows SCM wrappers cannot rely on POSIX signals. The request is private and tied to this random run, never a PID kill.
    monitor = setInterval(() => {
      try {
        const requested = readServiceRecord(lock.directory, serviceFiles.stop);
        if (requested && typeof requested === 'object' && 'runId' in requested && requested.runId === lock.runId) abort();
      } catch { monitorError = true; abort(); }
    }, 1000);
    const phases: { name: 'openapi' | 'sources'; interval: number; next: number; failures: number; run(): Promise<ObservationCycle> }[] = [];
    if (config.openApi) phases.push({ name: 'openapi', interval: config.openApi.intervalMs, next: 0, failures: 0,
      run: () => (options.dependencies?.observe ?? observeOnce)({ statePath: lock.directory, enginePath: config.openApi!.enginePath,
        allowHttp: config.allowHttp, signal: controller.signal }) });
    if (config.sources) phases.push({ name: 'sources', interval: config.sources.intervalMs, next: 0, failures: 0,
      run: () => (options.dependencies?.observeSources ?? observeSourcesOnce)({ statePath: lock.directory,
        allowHttp: config.allowHttp, signal: controller.signal }) });
    const refresh = (cycle = false): void => {
      const degraded = phases.some(phase => phase.failures > 0);
      update({ cycles: status.cycles + (cycle ? 1 : 0), observation: cycle ? degraded ? 'degraded' : 'healthy' : status.observation,
        state: degraded || ['unavailable', 'reconnect-required'].includes(status.cloud) ? 'degraded' : 'running' });
    };
    const synchronize = async (): Promise<void> => {
      let cloudFailures = 0;
      while (!controller.signal.aborted) {
        let terminal = false;
        let waitMs = Math.min(config.cloud!.intervalMs, 60_000);
        try {
          const result = await (options.dependencies?.sync ?? syncWorkerToCloud)({ statePath: lock.directory,
            cloudStatePath: config.cloud!.statePath, integrationIds: config.cloud!.integrationIds, credentials: credentials!, signal: controller.signal });
          if (!['synced', 'pending', 'busy'].includes(result.state)) throw new Error('Invalid sync result.');
          status = { ...status, cloud: result.state === 'synced' ? 'synced' : 'pending' };
          cloudFailures = 0;
        } catch (error) {
          terminal = error instanceof CloudConnectionError && ['AUTHORIZATION_REJECTED', 'STATUS_REJECTED', 'INVALID_CONFIGURATION'].includes(error.code);
          status = { ...status, cloud: terminal ? 'reconnect-required' : 'unavailable' };
          cloudFailures = Math.min(cloudFailures + 1, 10);
          waitMs = Math.min(waitMs * 2 ** cloudFailures, 300_000);
        }
        log('cloud-status', { state: status.cloud }); refresh();
        if (controller.signal.aborted) break;
        if (terminal) {
          await new Promise<void>(done => controller.signal.addEventListener('abort', () => done(), { once: true }));
        } else {
          try { await wait(waitMs, controller.signal); }
          catch (error) { if (!controller.signal.aborted) throw error; }
        }
      }
    };
    const observe = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        let ran = false;
        for (const phase of phases) {
          if (controller.signal.aborted || performance.now() < phase.next) continue;
          let summary: ReturnType<typeof counts> = { observed: 0, unchanged: 0, busy: 0, failed: 1 };
          try { summary = counts(await phase.run()); } catch { /* Persist only a sanitized phase failure, never source content or credentials. */ }
          phase.failures = summary.failed > 0 || summary.busy > 0 ? Math.min(phase.failures + 1, 10) : 0;
          const backoffMs = Math.min(phase.interval * 2 ** phase.failures, Math.max(phase.interval, 300_000));
          phase.next = performance.now() + backoffMs;
          log('observation', { profile: phase.name, counts: summary, retryAfterMs: backoffMs });
          ran = true;
        }
        if (ran) refresh(true);
        if (controller.signal.aborted) break;
        const next = Math.min(...phases.map(phase => phase.next));
        try { await wait(Math.max(1, next - performance.now()), controller.signal); }
        catch (error) { if (!controller.signal.aborted) throw error; }
      }
    };
    // Cloud contact has its own serial loop: a slow observation cannot withhold
    // a fresh heartbeat, and no two sync calls share ownership concurrently.
    let failure: unknown;
    await Promise.all([observe(), ...(config.cloud ? [synchronize()] : [])].map(async task => {
      try { await task; } catch (error) { failure ??= error; controller.abort(); }
    }));
    if (failure !== undefined) throw failure;
    if (monitorError) throw new Error('Local control state is invalid.');
    update({ state: 'stopping' }); log('stopping');
    update({ state: 'stopped' }); log('stopped');
    return status;
  } catch (error) {
    // Failure to replace a snapshot must not prevent an independent bounded log
    // append. The CLI also retains these allowlisted fields if storage is down.
    try { log('failed', { reason: 'local-operation-failed', ...serviceFailureDetails(error) }); } catch { /* Preserve the original storage failure. */ }
    try { update({ state: 'failed' }); } catch { /* Preserve the original storage failure. */ }
    throw error;
  } finally {
    if (monitor) clearInterval(monitor);
    options.signal?.removeEventListener('abort', abort);
    lock.close();
  }
}
