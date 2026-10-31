import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';
import { ModelConnections } from './model-connections.js';
import { ModelConnectionStore } from './model-connections-store.js';
import type { probeHttpModelConnection } from './model-http-adapter.js';
import { ModelConnectionError } from './model-failure.js';
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
  readonly models?: 'pending' | 'unverified' | 'healthy' | 'degraded' | 'requires-reconfiguration';
}

export interface WorkerServiceDependencies {
  /** Only trusted in-process adapters. JSON configuration cannot choose executable code or commands. */
  readonly observe?: typeof observeOnce;
  readonly observeSources?: typeof observeSourcesOnce;
  readonly probeModel?: typeof probeHttpModelConnection;
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
  let result: unknown;
  try { result = readServiceRecord(config.statePath, serviceFiles.status); }
  catch (error) {
    if (error instanceof SyntaxError) invalid('Service status is invalid. Consult the native service manager.');
    throw error;
  }
  if (result === undefined) return undefined;
  const fields = ['schemaVersion', 'runId', 'pid', 'state', 'updatedAt', 'cycles', 'observation', 'models'];
  if (result === null || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !fields.includes(key))
    || !('schemaVersion' in result) || result.schemaVersion !== 1
    || !('runId' in result) || typeof result.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(result.runId)
    || !('pid' in result) || typeof result.pid !== 'number' || !Number.isSafeInteger(result.pid) || result.pid < 1
    || !('cycles' in result) || typeof result.cycles !== 'number' || !Number.isSafeInteger(result.cycles) || result.cycles < 0
    || !('updatedAt' in result) || typeof result.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result.updatedAt)
    || !Number.isFinite(Date.parse(result.updatedAt)) || new Date(result.updatedAt).toISOString() !== result.updatedAt) {
    invalid('Service status is invalid. Consult the native service manager.');
  }
  const choice = <T extends string>(value: unknown, allowed: readonly T[]): T => {
    const matched = allowed.find(item => item === value);
    if (matched === undefined) invalid('Service status is invalid. Consult the native service manager.');
    return matched;
  };
  return {
    schemaVersion: 1, runId: result.runId, pid: result.pid, updatedAt: result.updatedAt, cycles: result.cycles,
    state: choice('state' in result ? result.state : undefined, ['starting', 'running', 'degraded', 'stopping', 'stopped', 'failed']),
    observation: choice('observation' in result ? result.observation : undefined, ['pending', 'healthy', 'degraded']),
    ...('models' in result ? { models: choice(result.models, ['pending', 'unverified', 'healthy', 'degraded', 'requires-reconfiguration']) } : {}),
  };
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
    updatedAt: new Date().toISOString(), cycles: 0, observation: 'pending', ...(config.models ? { models: 'pending' } : {}) };
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
        state: degraded || status.models === 'degraded' || status.models === 'requires-reconfiguration' ? 'degraded' : 'running' });
    };
    const checkConfiguredModels = async (): Promise<void> => {
      if (!config.models) return;
      let store: ModelConnectionStore | undefined;
      let connections: ModelConnections | undefined;
      try {
        checkServicePath(config.models.configPath, 'config'); checkWindowsServiceAcl(config.models.configPath, false);
        const value = await loadLocalJson(config.models.configPath, 16_384);
        store = await ModelConnectionStore.open(lock.directory);
        connections = new ModelConnections(value, { persistence: store,
          ...(options.dependencies?.probeModel ? { probe: options.dependencies.probeModel } : {}) });
        if (!store.permitsStartupProbe(connections.configurationDigest)) { update({ models: 'unverified' }); return; }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(connections.configuration.limits.timeoutMs)]);
        let checks = 0;
        for (const id of connections.selectedIds()) {
          if (connections.state(id).status === 'requires-reconfiguration') continue;
          checks++;
          try { await connections.verify(id, signal); }
          catch (error) { if (!(error instanceof ModelConnectionError) || error.kind === 'cancelled' || error.kind === 'invalid-response') throw error; }
        }
        const states = connections.selectedIds().map(id => connections!.state(id));
        const healthy = states.filter(value => value.status === 'healthy').length;
        const state = healthy === states.length ? 'healthy' : healthy > 0 ? 'degraded'
          : states.some(value => value.status === 'requires-reconfiguration') ? 'requires-reconfiguration' : 'degraded';
        update({ models: state });
        log('model-connections', { state, checks, privateCodeSent: false });
      } catch {
        if (!controller.signal.aborted) {
          const blocked = connections?.states().some(value => value.status === 'requires-reconfiguration');
          update({ models: blocked ? 'requires-reconfiguration' : 'degraded' });
          log('model-connections', { state: 'unavailable', privateCodeSent: false });
        }
      } finally { store?.close(); if (!controller.signal.aborted) refresh(); }
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
        try { await wait(Math.min(60_000, Math.max(1, next - performance.now())), controller.signal); }
        catch (error) { if (!controller.signal.aborted) throw error; }
      }
    };
    let failure: unknown;
    await Promise.all([observe(), ...(config.models ? [checkConfiguredModels()] : [])].map(async task => {
      try { await task; } catch (error) { failure ??= error; abort(); }
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
