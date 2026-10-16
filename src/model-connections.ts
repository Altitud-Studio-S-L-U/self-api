import { createHash, randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { PlumberError } from './errors.js';
import { ModelConnectionError, requiresModelReconfiguration, type ModelFailureKind } from './model-failure.js';
import { createHttpModelAdapter, MODEL_PROBE_OUTPUT_TOKENS, probeHttpModelConnection } from './model-http-adapter.js';
import type { HttpModelAdapterOptions, HttpModelProvider, ModelConnectionProbe } from './model-http-adapter.js';
import { approveModelProposal, isPreparedModelProposal, proposeMigrationWithModel } from './model-harness.js';
import type { ModelProposalAdapter, ModelProposalConsent, ModelProposalLimits, ModelProposalOutcome, ModelProposalRequest } from './model-harness.js';

export interface ModelConnectionConfiguration {
  readonly id: string;
  readonly revision: number;
  readonly credentialRevision: number;
  readonly provider: HttpModelProvider;
  readonly model: string;
  readonly policyId: string;
  readonly maximumOutputTokens: number;
  readonly apiKeyEnv?: string;
  readonly endpoint?: string;
}
export interface ModelRoutingConfiguration {
  readonly schemaVersion: 1;
  readonly mode: 'manual' | 'auto';
  readonly primary: string;
  readonly fallback?: string;
  readonly connections: readonly ModelConnectionConfiguration[];
  readonly limits: ModelProposalLimits & { readonly maximumTotalOutputTokens: number };
}
export interface ModelConnectionState {
  readonly id: string;
  readonly revision: number;
  readonly configurationDigest: string;
  readonly status: 'unverified' | 'healthy' | 'degraded' | 'requires-reconfiguration';
  readonly verifiedAt: number | null;
  readonly latencyMs: number | null;
  readonly failure: ModelFailureKind | null;
}
/** The durable record is diagnostic. A restarted process must establish its own functional receipt. */
export interface ModelConnectionPersistence {
  read(id: string): ModelConnectionState | undefined;
  write(state: ModelConnectionState): void;
}
export interface ModelRoutingAlert {
  readonly event: 'connection-degraded' | 'reconfiguration-required' | 'fallback-selected' | 'budget-exhausted';
  readonly connectionId: string;
  readonly reason: ModelFailureKind | 'output-token-budget';
}
export interface ModelConnectionDependencies {
  readonly adapter?: typeof createHttpModelAdapter;
  readonly probe?: typeof probeHttpModelConnection;
  readonly persistence?: ModelConnectionPersistence;
  /** Trusted clock seam for expiry tests, never selected by configuration. */
  readonly now?: () => number;
}

const MAX_FRESH_MS = 5 * 60_000;
const MAX_BYTES = 1024 * 1024;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
async function boundedOperation<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  let stop: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => { reject(new ModelConnectionError('cancelled')); };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      if (signal.aborted) throw new ModelConnectionError('cancelled');
      return operation();
    })]);
  } finally { if (stop) signal.removeEventListener('abort', stop); }
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Model configuration requires plain data objects.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (required.some(key => !Object.hasOwn(descriptors, key)) || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
    || ![...required, ...optional].includes(key) || !Object.hasOwn(descriptors[key]!, 'value'))) invalid('Model configuration contains missing, unknown or accessor fields.');
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid('Model configuration limits and revisions must be bounded integers.');
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(value)) invalid('Model connections require bounded explicit identifiers.');
  return value;
}
function adapterOptions(connection: ModelConnectionConfiguration, observeCredential?: (key: string) => void): HttpModelAdapterOptions {
  const name = connection.apiKeyEnv;
  return { provider: connection.provider, model: connection.model, policyId: connection.policyId, maximumOutputTokens: connection.maximumOutputTokens,
    ...(connection.endpoint ? { endpoint: connection.endpoint } : {}), ...(name ? { getApiKey: () => {
      const key = process.env[name];
      if (!key) throw new ModelConnectionError('credentials');
      observeCredential?.(key);
      return key;
    } } : {}) };
}

export function normalizeModelRoutingConfiguration(value: unknown): ModelRoutingConfiguration {
  const input = record(value, ['schemaVersion', 'primary', 'connections'], ['mode', 'fallback', 'limits']);
  if (input['schemaVersion'] !== 1 || input['mode'] !== undefined && input['mode'] !== 'manual' && input['mode'] !== 'auto') invalid('Model routing requires schemaVersion 1 and manual or auto mode.');
  const mode = input['mode'] === 'auto' ? 'auto' : 'manual';
  const list = input['connections'];
  if (!Array.isArray(list) || isProxy(list) || Object.getPrototypeOf(list) !== Array.prototype || list.length < 1 || list.length > 8) invalid('Configure one to eight local model connections.');
  const descriptors = Object.getOwnPropertyDescriptors(list);
  if (Reflect.ownKeys(descriptors).length !== list.length + 1 || Array.from({ length: list.length }, (_, index) => descriptors[String(index)])
    .some(value => !value || !Object.hasOwn(value, 'value'))) invalid('Model connections cannot contain holes or accessors.');
  const connections = Object.freeze(list.map((value): ModelConnectionConfiguration => {
    const entry = record(value, ['id', 'revision', 'credentialRevision', 'provider', 'model', 'policyId', 'maximumOutputTokens'], ['apiKeyEnv', 'endpoint']);
    const provider = entry['provider'];
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'google' && provider !== 'local-openai-compatible') invalid('Choose an implemented model provider.');
    const defaults = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY', 'local-openai-compatible': undefined };
    const apiKeyEnv = entry['apiKeyEnv'] ?? defaults[provider];
    if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(apiKeyEnv))) invalid('Credentials must refer to a local environment variable, never a literal key.');
    const model = entry['model'];
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(model)) invalid('Choose an explicit bounded model identifier.');
    if (entry['endpoint'] !== undefined && typeof entry['endpoint'] !== 'string') invalid('A local model endpoint must be a literal URL.');
    const connection: ModelConnectionConfiguration = Object.freeze({ id: identifier(entry['id']), revision: integer(entry['revision'], 1, 2147483647),
      credentialRevision: integer(entry['credentialRevision'], 1, 2147483647), provider, model, policyId: identifier(entry['policyId']),
      maximumOutputTokens: integer(entry['maximumOutputTokens'], 1, 32768),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }), ...(entry['endpoint'] === undefined ? {} : { endpoint: entry['endpoint'] }) });
    createHttpModelAdapter(adapterOptions(connection));
    return connection;
  }));
  if (new Set(connections.map(connection => connection.id)).size !== connections.length) invalid('Model connection identifiers must be unique.');
  const primary = identifier(input['primary']);
  const fallback = input['fallback'] === undefined ? undefined : identifier(input['fallback']);
  if (!connections.some(connection => connection.id === primary) || fallback !== undefined && (mode !== 'auto' || fallback === primary
    || !connections.some(connection => connection.id === fallback))) invalid('Routing requires a configured primary and at most one different, explicitly authorized Auto fallback.');
  const supplied = input['limits'] === undefined ? {} : record(input['limits'], [], ['maximumInputBytes', 'maximumOutputBytes', 'timeoutMs', 'maximumTotalOutputTokens']);
  const limits = Object.freeze({ maximumInputBytes: integer(supplied['maximumInputBytes'] ?? 256 * 1024, 1, MAX_BYTES),
    maximumOutputBytes: integer(supplied['maximumOutputBytes'] ?? 256 * 1024, 1, MAX_BYTES),
    timeoutMs: integer(supplied['timeoutMs'] ?? 120_000, 1000, 120_000),
    maximumTotalOutputTokens: integer(supplied['maximumTotalOutputTokens'] ?? 8192, MODEL_PROBE_OUTPUT_TOKENS + 1, 65_792) });
  const selected = connections.filter(connection => connection.id === primary || connection.id === fallback);
  if (selected.reduce((total, connection) => total + connection.maximumOutputTokens + MODEL_PROBE_OUTPUT_TOKENS, 0) > limits.maximumTotalOutputTokens) {
    invalid('The total output token budget must cover the selected generation ceilings and their bounded functional checks.');
  }
  return Object.freeze({ schemaVersion: 1, mode, primary, ...(fallback ? { fallback } : {}), connections, limits });
}

export class ModelConnections {
  readonly configuration: ModelRoutingConfiguration;
  readonly configurationDigest: string;
  private readonly entries = new Map<string, { config: ModelConnectionConfiguration; adapter: ModelProposalAdapter; options: HttpModelAdapterOptions;
    state: ModelConnectionState; verifiedInRun: boolean; credential: { verified: string | undefined; candidate: string | undefined; checking: boolean; epoch: number } }>();
  private busy = false;
  constructor(configuration: unknown, private readonly dependencies: ModelConnectionDependencies = {}) {
    this.configuration = normalizeModelRoutingConfiguration(configuration);
    this.configurationDigest = hash(this.configuration);
    for (const config of this.configuration.connections) {
      const digest = hash(config), previous = dependencies.persistence?.read(config.id);
      if (previous && (config.revision < previous.revision || config.revision === previous.revision && digest !== previous.configurationDigest)) {
        invalid('Model configuration changed without an increased connection revision.');
      }
      const state: ModelConnectionState = previous?.configurationDigest === digest ? previous : {
        id: config.id, revision: config.revision, configurationDigest: digest, status: 'unverified', verifiedAt: null, latencyMs: null, failure: null,
      };
      const credential = { verified: undefined as string | undefined, candidate: undefined as string | undefined, checking: false, epoch: 0 };
      const options = adapterOptions(config, key => {
        const fingerprint = hash(key);
        if (credential.checking) credential.candidate = fingerprint;
        else if (fingerprint !== credential.verified) throw new ModelConnectionError('credentials');
      });
      this.entries.set(config.id, { config, options, adapter: (dependencies.adapter ?? createHttpModelAdapter)(options), state, verifiedInRun: false, credential });
    }
  }
  private entry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) invalid('The model connection is outside the local configuration.');
    return entry;
  }
  selectedIds(): readonly string[] { return Object.freeze([this.configuration.primary, ...(this.configuration.fallback ? [this.configuration.fallback] : [])]); }
  adapter(id: string): ModelProposalAdapter { return this.entry(id).adapter; }
  connection(id: string): ModelConnectionConfiguration { return this.entry(id).config; }
  state(id: string): ModelConnectionState { return this.entry(id).state; }
  credentialEpoch(id: string): number { return this.entry(id).credential.epoch; }
  states(): readonly (ModelConnectionState & { readonly fresh: boolean })[] {
    return Object.freeze([...this.entries].map(([id, entry]) => Object.freeze({ ...entry.state, fresh: this.fresh(id) })));
  }
  fresh(id: string): boolean {
    const { state, verifiedInRun } = this.entry(id), now = (this.dependencies.now ?? Date.now)();
    return verifiedInRun && state.status === 'healthy' && state.verifiedAt !== null && now >= state.verifiedAt && now - state.verifiedAt <= MAX_FRESH_MS;
  }
  private save(id: string, value: Partial<ModelConnectionState>): void {
    const entry = this.entry(id);
    const state = Object.freeze({ ...entry.state, ...value });
    this.dependencies.persistence?.write(state);
    entry.state = state;
  }
  recordFailure(id: string, failure: ModelFailureKind): void {
    this.entry(id).verifiedInRun = false;
    this.save(id, { status: requiresModelReconfiguration(failure) ? 'requires-reconfiguration' : 'degraded', failure });
  }
  acquire(): () => void {
    if (this.busy) invalid('This model connection runtime already has an active check or proposal.');
    this.busy = true;
    return () => { this.busy = false; };
  }
  /** Call only after explicit probe consent or the exact proposal consent. No timer invokes this method. */
  async verify(id: string, signal: AbortSignal, explicitReconfiguration = false): Promise<ModelConnectionProbe> {
    const entry = this.entry(id);
    if (entry.state.status === 'requires-reconfiguration' && !explicitReconfiguration) throw new ModelConnectionError(entry.state.failure ?? 'credentials');
    if (signal.aborted) throw new ModelConnectionError('cancelled');
    if (entry.credential.checking) invalid('A functional check already owns this model connection.');
    entry.credential.checking = true;
    entry.credential.candidate = undefined;
    try {
      const result = await boundedOperation(signal, () => (this.dependencies.probe ?? probeHttpModelConnection)(entry.options, signal));
      if (signal.aborted) throw new ModelConnectionError('cancelled');
      if (!result || result.status !== 'verified' || !Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0
        || result.maximumOutputTokens !== MODEL_PROBE_OUTPUT_TOKENS) throw new ModelConnectionError('invalid-response');
      this.save(id, { status: 'healthy', verifiedAt: (this.dependencies.now ?? Date.now)(), latencyMs: result.latencyMs, failure: null });
      if (entry.credential.verified !== undefined && entry.credential.candidate !== entry.credential.verified) entry.credential.epoch++;
      entry.credential.verified = entry.credential.candidate;
      entry.verifiedInRun = true;
      return result;
    } catch (error) {
      const failure = signal.aborted ? 'cancelled' : error instanceof ModelConnectionError ? error.kind : 'invalid-response';
      this.recordFailure(id, failure);
      throw new ModelConnectionError(failure);
    } finally { entry.credential.checking = false; entry.credential.candidate = undefined; }
  }
}

export interface ModelRouteRequest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly configurationDigest: string;
  readonly mode: 'manual' | 'auto';
  readonly contextDigest: string;
  readonly attempts: readonly { readonly connectionId: string; readonly revision: number; readonly credentialEpoch: number; readonly request: ModelProposalRequest }[];
  readonly limits: ModelRoutingConfiguration['limits'];
  readonly maximumGenerations: number;
  readonly maximumFunctionalChecks: number;
  readonly functionalCheck: { readonly privateCode: false; readonly maximumOutputTokens: number };
  readonly authorization: 'not-granted';
}
export interface ModelRouteConsent { readonly id: string; readonly requestId: string; readonly expiresAt: number }
const plans = new WeakMap<ModelRouteRequest, ModelConnections>();
const approvals = new WeakMap<ModelRouteConsent, { request: ModelRouteRequest; used: boolean }>();

export function prepareModelRoute(connections: ModelConnections, requests: readonly ModelProposalRequest[]): ModelRouteRequest {
  const ids = connections.selectedIds(), limits = connections.configuration.limits;
  if (requests.length !== ids.length || !requests[0]) invalid('Prepare exactly the manually selected destination or the two authorized Auto destinations.');
  const contextDigest = requests[0].contextDigest;
  const attempts = Object.freeze(ids.map((id, index) => {
    const request = requests[index]!;
    const { propose: _propose, ...identity } = connections.adapter(id);
    if (!isPreparedModelProposal(request) || hash(request.adapter) !== hash(identity) || request.contextDigest !== contextDigest
      || hash(request.limits) !== hash({ maximumInputBytes: limits.maximumInputBytes, maximumOutputBytes: limits.maximumOutputBytes, timeoutMs: limits.timeoutMs })) {
      invalid('Every authorized route must bind the same context, exact adapter identity and shared limits.');
    }
    return Object.freeze({ connectionId: id, revision: connections.connection(id).revision, credentialEpoch: connections.credentialEpoch(id), request });
  }));
  const fields = { schemaVersion: 1 as const, configurationDigest: connections.configurationDigest, mode: connections.configuration.mode, contextDigest,
    attempts, limits, maximumGenerations: ids.length, maximumFunctionalChecks: ids.length,
    functionalCheck: Object.freeze({ privateCode: false as const, maximumOutputTokens: MODEL_PROBE_OUTPUT_TOKENS }), authorization: 'not-granted' as const };
  const request: ModelRouteRequest = Object.freeze({ ...fields, id: hash(fields) });
  plans.set(request, connections);
  return request;
}

export function approveModelRoute(options: { readonly request: ModelRouteRequest; readonly expectedRequestId: string; readonly allowRemote?: boolean; readonly expiresAt?: number }): ModelRouteConsent {
  const input = { ...record(options, ['request', 'expectedRequestId'], ['allowRemote', 'expiresAt']) };
  const request = input['request'] as ModelRouteRequest;
  const allowRemote = input['allowRemote'];
  if (allowRemote !== undefined && typeof allowRemote !== 'boolean') invalid('Remote model consent must be an explicit boolean.');
  if (!plans.has(request) || input['expectedRequestId'] !== request.id) invalid('Inspect and confirm the exact model route, destinations, revisions and limits first.');
  if (request.attempts.some(attempt => attempt.request.adapter.location === 'remote') && allowRemote !== true) invalid('Each remote destination requires explicit disclosure and functional-check consent.');
  const now = Date.now(), expiresAt = input['expiresAt'] === undefined ? now + 5 * 60_000 : input['expiresAt'];
  if (typeof expiresAt !== 'number') invalid('Model routing consent must expire within fifteen minutes.');
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 15 * 60_000) invalid('Model routing consent must expire within fifteen minutes.');
  const consent = Object.freeze({ id: randomUUID(), requestId: request.id, expiresAt });
  approvals.set(consent, { request, used: false });
  return consent;
}

interface ModelRouteOptions {
  readonly request: ModelRouteRequest;
  readonly consent: ModelRouteConsent;
  readonly signal?: AbortSignal;
  readonly onAlert?: (alert: ModelRoutingAlert) => void;
}
type ModelRouteExecution<T extends ModelProposalOutcome> = (request: ModelProposalRequest, consent: ModelProposalConsent, adapter: ModelProposalAdapter, signal: AbortSignal) => Promise<T>;
export interface ModelRouteResult<T extends ModelProposalOutcome = ModelProposalOutcome> {
  readonly outcome: T;
  readonly connectionId: string;
  readonly generations: number;
  readonly functionalChecks: number;
  readonly reservedOutputTokens: number;
  readonly alerts: readonly ModelRoutingAlert[];
}
export function runModelRoute<T extends ModelProposalOutcome>(options: ModelRouteOptions & { readonly execute: ModelRouteExecution<T> }): Promise<ModelRouteResult<T>>;
export function runModelRoute(options: ModelRouteOptions): Promise<ModelRouteResult>;
export async function runModelRoute(options: ModelRouteOptions & { readonly execute?: ModelRouteExecution<ModelProposalOutcome> }): Promise<ModelRouteResult> {
  const input = { ...record(options, ['request', 'consent'], ['signal', 'onAlert', 'execute']) };
  const request = input['request'] as ModelRouteRequest, consent = input['consent'] as ModelRouteConsent;
  const externalSignal = input['signal'], onAlert = input['onAlert'];
  const execute = input['execute'] as ModelRouteExecution<ModelProposalOutcome> | undefined;
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) invalid('Model route cancellation requires an AbortSignal.');
  if (onAlert !== undefined && typeof onAlert !== 'function' || execute !== undefined && typeof execute !== 'function') invalid('Model route hooks must be functions.');
  const connections = plans.get(request), approval = approvals.get(consent);
  if (!connections || !approval || approval.request !== request || approval.used || consent.expiresAt <= Date.now()) invalid('Model route consent is missing, expired, consumed or bound to another request.');
  const release = connections.acquire();
  approval.used = true;
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), request.limits.timeoutMs);
  const deadline = performance.now() + request.limits.timeoutMs;
  const alerts: ModelRoutingAlert[] = [];
  const emit = (alert: ModelRoutingAlert): void => { alerts.push(Object.freeze(alert)); onAlert?.(alert); };
  let generations = 0, functionalChecks = 0, reservedOutputTokens = 0;
  let lastFailure: ModelConnectionError | undefined;
  const checked = new Set<string>();
  const check = (): void => {
    if (signal.aborted || performance.now() >= deadline) { controller.abort(); throw new ModelConnectionError('cancelled'); }
    if (consent.expiresAt <= Date.now()) invalid('Model route consent expired; the remaining chain is stopped.');
  };
  const reserve = (id: string, tokens: number): void => {
    check();
    if (reservedOutputTokens + tokens > request.limits.maximumTotalOutputTokens) {
      emit({ event: 'budget-exhausted', connectionId: id, reason: 'output-token-budget' });
      invalid('The authorized model output token budget is exhausted.');
    }
    reservedOutputTokens += tokens;
  };
  const connectionFailure = (id: string, error: unknown): void => {
    if (!(error instanceof ModelConnectionError)) throw error;
    lastFailure = error;
    if (requiresModelReconfiguration(error.kind)) emit({ event: 'reconfiguration-required', connectionId: id, reason: error.kind });
    else if (error.kind === 'transient') emit({ event: 'connection-degraded', connectionId: id, reason: error.kind });
    if (error.kind === 'cancelled' || error.kind === 'invalid-response') throw error;
  };
  const ensureFresh = async (id: string): Promise<void> => {
    if (connections.fresh(id) || checked.has(id)) return;
    checked.add(id);
    const state = connections.state(id);
    if (state.status === 'requires-reconfiguration') { connectionFailure(id, new ModelConnectionError(state.failure ?? 'credentials')); return; }
    reserve(id, MODEL_PROBE_OUTPUT_TOKENS);
    functionalChecks++;
    try { await connections.verify(id, signal); } catch (error) { connectionFailure(id, error); }
  };
  try {
    for (const attempt of request.attempts) {
      check();
      if (connections.credentialEpoch(attempt.connectionId) !== attempt.credentialEpoch) invalid('A credential changed after this route was prepared; review a new request.');
    }
    for (const attempt of request.attempts) {
      check();
      await ensureFresh(attempt.connectionId);
      if (connections.credentialEpoch(attempt.connectionId) !== attempt.credentialEpoch) invalid('A credential changed after this route was prepared; review a new request.');
      if (!connections.fresh(attempt.connectionId)) continue;
      const adapter = connections.adapter(attempt.connectionId);
      if (attempt.connectionId !== connections.configuration.primary) emit({ event: 'fallback-selected', connectionId: attempt.connectionId, reason: lastFailure?.kind ?? 'transient' });
      reserve(attempt.connectionId, connections.connection(attempt.connectionId).maximumOutputTokens);
      generations++;
      const proposalConsent = approveModelProposal({ request: attempt.request, expectedRequestId: attempt.request.id,
        ...(adapter.location === 'remote' ? { allowRemote: true } : {}), expiresAt: consent.expiresAt });
      try {
        const outcome = await boundedOperation(signal, () => execute ? execute(attempt.request, proposalConsent, adapter, signal)
          : proposeMigrationWithModel({ request: attempt.request, consent: proposalConsent, adapter, signal }));
        check();
        return Object.freeze({ outcome, connectionId: attempt.connectionId, generations, functionalChecks, reservedOutputTokens, alerts: Object.freeze(alerts) });
      } catch (error) {
        check();
        if (!(error instanceof ModelConnectionError)) throw error;
        connections.recordFailure(attempt.connectionId, error.kind);
        connectionFailure(attempt.connectionId, error);
      }
    }
    throw lastFailure ?? new ModelConnectionError('transient');
  } finally { clearTimeout(timer); controller.abort(); release(); }
}
