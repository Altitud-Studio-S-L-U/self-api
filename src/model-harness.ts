import { createHash, randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { isCapturedConsumerPath, isConsumerTestPath } from './consumer-files.js';
import { PlumberError } from './errors.js';
import { ModelConnectionError } from './model-failure.js';
import { previewRecipe, serializeMigrationRecipe } from './migration-recipe.js';
import type { MigrationRecipe, RecipePreview } from './migration-recipe.js';

export interface ModelAdapterIdentity {
  readonly id: string;
  readonly location: 'local' | 'remote';
  readonly destination: string;
  readonly policyId: string;
}

export interface ModelContextFile {
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
  readonly role: 'source' | 'test';
}

export interface ModelProposalLimits {
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly timeoutMs: number;
}

export interface ModelProposalContext {
  readonly schemaVersion: 1;
  readonly files: readonly ModelContextFile[];
  readonly evidence: readonly { readonly id: string; readonly text: string }[];
  readonly requiredDecisions: readonly { readonly id: string; readonly question: string }[];
}

export interface PrepareModelProposalOptions {
  readonly adapter: ModelAdapterIdentity;
  readonly files: readonly ModelContextFile[];
  readonly evidence: ModelProposalContext['evidence'];
  readonly requiredDecisions?: ModelProposalContext['requiredDecisions'];
  /** Exact additional values to reject before disclosure and in the response. Never sent to the adapter. */
  readonly sensitiveValues?: readonly string[];
  readonly limits?: Partial<ModelProposalLimits>;
}

export interface ModelProposalRequest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly adapter: ModelAdapterIdentity;
  readonly context: ModelProposalContext;
  readonly contextDigest: string;
  readonly policyDigest: string;
  readonly limits: ModelProposalLimits;
  readonly inputBytes: number;
  readonly authorization: 'not-granted';
}

export interface ModelProposalConsent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: 'model-proposal';
  readonly requestId: string;
  readonly contextDigest: string;
  readonly policyDigest: string;
  readonly destination: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** The adapter is trusted application code, not model-generated code or an execution sandbox. */
export interface ModelProposalAdapter extends ModelAdapterIdentity {
  readonly propose: (context: ModelProposalContext, options: {
    readonly signal: AbortSignal;
    readonly maximumOutputBytes: number;
  }) => Promise<string>;
}

export interface ModelMigrationProposal {
  readonly schemaVersion: 1;
  readonly status: 'proposal-ready';
  readonly requestId: string;
  readonly contextDigest: string;
  readonly recipe: MigrationRecipe;
  readonly preview: RecipePreview;
  readonly authorization: 'not-granted';
  readonly validation: 'not-run';
  readonly consumerModified: false;
  readonly consumerExecuted: false;
  readonly publication: 'not-authorized';
}

export interface ModelNoProposal extends Omit<ModelMigrationProposal, 'status' | 'recipe' | 'preview'> {
  readonly status: 'decision-required';
  readonly summary: string;
  readonly decisions: ModelProposalContext['requiredDecisions'];
}

export type ModelProposalOutcome = ModelMigrationProposal | ModelNoProposal;

const MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_CONSENT_MS = 15 * 60_000;
const SEMANTIC_DECISION = Object.freeze({
  id: 'model-semantics',
  question: 'Confirm the proposed API and parser behavior against authoritative evidence; model output does not establish semantic correctness.',
});
const requests = new WeakMap<ModelProposalRequest, { readonly sensitiveValues: readonly string[] }>();
const consents = new WeakMap<ModelProposalConsent, { readonly request: ModelProposalRequest; used: boolean }>();

/** Internal orchestration guard: serialized plans cannot authorize even a synthetic provider call. */
export function isPreparedModelProposal(request: ModelProposalRequest): boolean { return requests.has(request); }

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Model inputs must be plain data.');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(value, key))
    || keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    invalid('Model input fields must be explicit data fields without accessors or unknown actions.');
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number): unknown[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid('Model collections exceed the supported bounded array profile.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid('Model collections must be dense data arrays.');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Model collections cannot contain accessors or holes.');
    return descriptor.value;
  });
}

function text(value: unknown, maximum = MAX_BYTES): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) invalid('Model input text exceeds its supported byte limit.');
  return value;
}

function identifier(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(result)) invalid('Model identifiers must be bounded printable identifiers.');
  return result;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function identity(value: unknown): ModelAdapterIdentity {
  const input = object(value, ['id', 'location', 'destination', 'policyId']);
  const id = identifier(input.id);
  const policyId = identifier(input.policyId);
  const destination = text(input.destination, 2048);
  if (input.location !== 'local' && input.location !== 'remote') invalid('A model adapter must declare its local or remote location.');
  if (input.location === 'local') {
    if (!/^local:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/u.test(destination)) invalid('Local models require an explicit local: destination identifier.');
  } else {
    let url: URL;
    try { url = new URL(destination); } catch { invalid('Remote models require an explicit HTTPS destination.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.href !== destination || /[\u0000-\u0020\u007f]/u.test(destination)) {
      invalid('Remote model destinations must be canonical HTTPS URLs without credentials, query parameters or fragments.');
    }
  }
  return Object.freeze({ id, location: input.location, destination, policyId });
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1 || result > maximum) {
    invalid('Model limits must be positive bounded integers.');
  }
  return result;
}

function limits(value: unknown): ModelProposalLimits {
  const input = value === undefined ? {} : object(value, [], ['maximumInputBytes', 'maximumOutputBytes', 'timeoutMs']);
  return Object.freeze({
    maximumInputBytes: boundedInteger(input.maximumInputBytes, 256 * 1024, MAX_BYTES),
    maximumOutputBytes: boundedInteger(input.maximumOutputBytes, 256 * 1024, MAX_BYTES),
    timeoutMs: boundedInteger(input.timeoutMs, 30_000, MAX_TIMEOUT_MS),
  });
}

function testPath(path: string): boolean {
  return isConsumerTestPath(path);
}

function sourcePath(value: unknown): string {
  const path = text(value, 1024);
  if (!isCapturedConsumerPath(path) || !/\.(?:tsx?|jsx?|mts|cts|mjs|cjs|py|java)$/iu.test(path)
    || /[:\u0000-\u001f\u007f]/u.test(path)) invalid('Model context requires relative captured JS, TS, Python or Java source paths.');
  return path;
}

// These recognizable patterns supplement explicit client redaction; they cannot identify every secret.
function rejectSecrets(value: string, sensitiveValues: readonly string[]): void {
  if (sensitiveValues.some(secret => value.includes(secret))
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)
    || /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|sk_(?:live|test)_[a-zA-Z0-9]{16,}|AKIA[A-Z0-9]{16})\b/u.test(value)
    || /\bBearer\s+[a-zA-Z0-9._~+/-]{12,}/iu.test(value)
    || /["']?(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/iu.test(value)) {
    invalid('Selected model context or output contains sensitive material; redact it locally before requesting a new proposal.');
  }
}

/** Select and inspect context locally. This function reads no files and invokes no model. */
export function prepareModelProposal(options: PrepareModelProposalOptions): ModelProposalRequest {
  const input = object(options, ['adapter', 'files', 'evidence'], ['requiredDecisions', 'sensitiveValues', 'limits']);
  const adapter = identity(input.adapter);
  const budget = limits(input.limits);
  const sensitiveValues = Object.freeze(array(input.sensitiveValues ?? [], 100).map(value => {
    const result = text(value, 4096);
    if (result.length < 4) invalid('Explicit sensitive values must contain at least four characters.');
    return result;
  }));
  let inputTextBytes = 0;
  const selectedText = (value: unknown): string => {
    const result = text(value, budget.maximumInputBytes);
    inputTextBytes += Buffer.byteLength(result, 'utf8');
    if (inputTextBytes > budget.maximumInputBytes) invalid('Selected model context exceeds its input byte budget.');
    rejectSecrets(result, sensitiveValues);
    return result;
  };
  const paths = new Set<string>();
  const files = Object.freeze(array(input.files, 100).map(value => {
    const file = object(value, ['path', 'sha256', 'text', 'role']);
    const path = sourcePath(file.path);
    const key = path.toLowerCase();
    if (paths.has(key)) invalid('Model context paths must be unique, including case variants.');
    paths.add(key);
    const content = selectedText(file.text);
    const sha256 = text(file.sha256, 64);
    if (sha256 !== digest(content)) invalid('Model context file hashes must match the selected text.');
    if (file.role !== 'source' && file.role !== 'test') invalid('Model files require an explicit source or test role.');
    if (file.role === 'source' && testPath(path)) invalid('Test files may be selected as read-only evidence, never editable source.');
    return Object.freeze({ path, sha256, text: content, role: file.role });
  }));
  if (!files.some(file => file.role === 'source')) invalid('Model proposals require at least one explicitly selected source file.');
  const evidenceIds = new Set<string>();
  const evidence = Object.freeze(array(input.evidence, 100).map(value => {
    const item = object(value, ['id', 'text']);
    const id = identifier(item.id);
    if (evidenceIds.has(id)) invalid('Model evidence identifiers must be unique.');
    evidenceIds.add(id);
    return Object.freeze({ id, text: selectedText(item.text) });
  }));
  const decisionIds = new Set<string>([SEMANTIC_DECISION.id]);
  const decisions = array(input.requiredDecisions ?? [], 99).map(value => {
    const decision = object(value, ['id', 'question']);
    const id = identifier(decision.id);
    const question = selectedText(decision.question);
    if (!question.trim() || decisionIds.has(id)) invalid('Model business decisions require unique identifiers and nonempty questions.');
    decisionIds.add(id);
    return Object.freeze({ id, question });
  });
  const context: ModelProposalContext = Object.freeze({
    schemaVersion: 1, files, evidence, requiredDecisions: Object.freeze([SEMANTIC_DECISION, ...decisions]),
  });
  const serialized = JSON.stringify(context);
  rejectSecrets(serialized, sensitiveValues);
  const inputBytes = Buffer.byteLength(serialized, 'utf8');
  if (inputBytes > budget.maximumInputBytes) invalid('Selected model context exceeds its serialized input byte budget.');
  const contextDigest = digest(serialized);
  const policyDigest = digest(JSON.stringify({
    profile: 'model-proposal-v2', adapter, limits: budget,
    sensitiveValueDigests: sensitiveValues.map(digest).sort(),
    maximumAttempts: 1, testsEditable: false, modelAnswersAllowed: false,
  }));
  const id = digest(JSON.stringify({ contextDigest, policyDigest }));
  const request: ModelProposalRequest = Object.freeze({
    schemaVersion: 1, id, adapter, context, contextDigest, policyDigest,
    limits: budget, inputBytes, authorization: 'not-granted',
  });
  requests.set(request, { sensitiveValues });
  return request;
}

/** Consent authorizes one disclosure/proposal call, never migration execution or publication. */
export function approveModelProposal(options: {
  readonly request: ModelProposalRequest;
  readonly expectedRequestId: string;
  readonly allowRemote?: boolean;
  readonly expiresAt?: number;
}): ModelProposalConsent {
  const input = object(options, ['request', 'expectedRequestId'], ['allowRemote', 'expiresAt']);
  const request = input.request as ModelProposalRequest;
  if (!requests.has(request) || input.expectedRequestId !== request.id) invalid('Inspect and confirm the exact locally prepared model request first.');
  if (input.allowRemote !== undefined && typeof input.allowRemote !== 'boolean') invalid('Remote model consent must be an explicit boolean.');
  if (request.adapter.location === 'remote' && input.allowRemote !== true) invalid('Remote model disclosure is denied unless explicitly authorized.');
  const issuedAt = Date.now();
  const expiresAt = input.expiresAt === undefined ? issuedAt + 5 * 60_000 : input.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt > issuedAt + MAX_CONSENT_MS) {
    invalid('Model consent must expire in the next fifteen minutes.');
  }
  const consent: ModelProposalConsent = Object.freeze({
    schemaVersion: 1, id: randomUUID(), scope: 'model-proposal', requestId: request.id,
    contextDigest: request.contextDigest, policyDigest: request.policyDigest,
    destination: request.adapter.destination, issuedAt, expiresAt,
  });
  consents.set(consent, { request, used: false });
  return consent;
}

/** One bounded attempt through a customer-controlled adapter; returned JSON remains untrusted data. */
export async function proposeMigrationWithModel(options: {
  readonly request: ModelProposalRequest;
  readonly consent: ModelProposalConsent;
  readonly adapter: ModelProposalAdapter;
  readonly signal?: AbortSignal;
}): Promise<ModelProposalOutcome> {
  const startedAt = performance.now();
  const input = object(options, ['request', 'consent', 'adapter'], ['signal']);
  const request = input.request as ModelProposalRequest;
  const state = requests.get(request);
  const consent = input.consent as ModelProposalConsent;
  const authorization = consents.get(consent);
  if (!state || !authorization || authorization.request !== request || authorization.used || consent.expiresAt <= Date.now()) {
    invalid('Model consent is missing, expired, already consumed, or belongs to different context.');
  }
  const adapter = object(input.adapter, ['id', 'location', 'destination', 'policyId', 'propose']);
  const adapterIdentity = identity({ id: adapter.id, location: adapter.location, destination: adapter.destination, policyId: adapter.policyId });
  if (JSON.stringify(adapterIdentity) !== JSON.stringify(request.adapter) || typeof adapter.propose !== 'function') {
    invalid('The model adapter does not match the authorized destination and provider policy.');
  }
  const signal = input.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('A model cancellation signal must be an AbortSignal.');
  if (signal?.aborted) invalid('The model proposal was cancelled before disclosure.');
  const deadline = startedAt + request.limits.timeoutMs;
  const checkDeadline = (): void => {
    if (signal?.aborted || performance.now() >= deadline) {
      invalid('The model proposal was cancelled or exceeded its deadline; no proposal was accepted.');
    }
  };
  checkDeadline();
  authorization.used = true;
  const controller = new AbortController();
  const propose = adapter.propose as ModelProposalAdapter['propose'];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  let output: unknown;
  try {
    output = await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) invalid('The model proposal was cancelled before disclosure.');
        checkDeadline();
        return propose(request.context, { signal: controller.signal, maximumOutputBytes: request.limits.maximumOutputBytes });
      }),
      new Promise<never>((_, reject) => {
        const stop = (): void => {
          controller.abort();
          reject(new PlumberError('INVALID_INPUT', 'The model proposal was cancelled or exceeded its deadline.'));
        };
        cancel = stop;
        signal?.addEventListener('abort', stop, { once: true });
        timer = setTimeout(stop, Math.max(1, Math.ceil(deadline - performance.now())));
      }),
    ]);
    checkDeadline();
  } catch (error) {
    // Adapter errors may contain prompts, credentials or provider response bodies.
    if (error instanceof ModelConnectionError) throw new ModelConnectionError(error.kind, 'INVALID_INPUT');
    invalid('The model proposal failed, was cancelled, or exceeded its deadline; no proposal was accepted.');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel !== undefined) signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > request.limits.maximumOutputBytes) {
    invalid('The model must return one JSON recipe within the authorized output byte budget.');
  }
  rejectSecrets(output, state.sensitiveValues);
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { invalid('The model response must be a single JSON migration recipe.'); }
  const response = object(parsed, ['schemaVersion', 'summary', 'decisions', 'files']);
  const mergeDecisions = (decisions: MigrationRecipe['decisions']): ModelProposalContext['requiredDecisions'] => {
    if (decisions.some(decision => Object.hasOwn(decision, 'answer'))) invalid('Models cannot answer business or semantic decisions on behalf of a reviewer.');
    const required = new Map(request.context.requiredDecisions.map(decision => [decision.id, decision]));
    for (const decision of decisions) {
      if (required.has(decision.id) && required.get(decision.id)!.question !== decision.question) invalid('Model proposals cannot rewrite required business decisions.');
      required.set(decision.id, { id: decision.id, question: decision.question });
    }
    if (required.size > 100) invalid('A model outcome cannot contain more than one hundred review decisions.');
    return [...required.values()];
  };
  if (array(response.files, 50).length === 0) {
    if (response.schemaVersion !== 1) invalid('Only model outcome schema version 1 is supported.');
    const summary = text(response.summary, 4096);
    if (!summary.trim()) invalid('A no-proposal outcome requires a nonempty explanation.');
    const ids = new Set<string>();
    const decisions = array(response.decisions, 100).map(value => {
      const decision = object(value, ['id', 'question']);
      const id = identifier(decision.id);
      const question = text(decision.question, 4096);
      if (!question.trim() || ids.has(id)) invalid('No-proposal decisions require unique identifiers and nonempty questions.');
      ids.add(id);
      return { id, question };
    });
    if (!decisions.length) invalid('A no-proposal outcome requires at least one unresolved decision.');
    for (const value of [summary, ...decisions.flatMap(decision => [decision.id, decision.question])]) rejectSecrets(value, state.sensitiveValues);
    const reviewed = mergeDecisions(decisions);
    checkDeadline();
    return { schemaVersion: 1, status: 'decision-required', requestId: request.id, contextDigest: request.contextDigest,
      summary, decisions: reviewed, authorization: 'not-granted', validation: 'not-run', consumerModified: false,
      consumerExecuted: false, publication: 'not-authorized' };
  }
  const serializedRecipe = serializeMigrationRecipe(parsed);
  rejectSecrets(serializedRecipe, state.sensitiveValues);
  const recipe: MigrationRecipe = JSON.parse(serializedRecipe);
  const decodedText = [recipe.summary, ...recipe.decisions.flatMap(decision => [
    decision.id, decision.question, ...(decision.answer === undefined ? [] : [decision.answer]),
  ]), ...recipe.files.flatMap(file => [file.path, ...file.edits.flatMap(edit => [edit.before, edit.after])])];
  for (const value of decodedText) rejectSecrets(value, state.sensitiveValues);
  const selected = new Map(request.context.files.filter(file => file.role === 'source').map(file => [file.path, file]));
  if (recipe.files.some(file => !selected.has(file.path))) invalid('Model proposals cannot expand the selected editable source scope or modify tests.');
  const normalized: MigrationRecipe = JSON.parse(serializeMigrationRecipe({ ...recipe, decisions: mergeDecisions(recipe.decisions) }));
  const preview = previewRecipe(normalized, [...selected.values()].map(({ path, sha256, text }) => ({ path, sha256, text })));
  // In-process synchronous work cannot be interrupted by a timer; never accept its late output.
  checkDeadline();
  return {
    schemaVersion: 1, status: 'proposal-ready', requestId: request.id, contextDigest: request.contextDigest, recipe: normalized, preview,
    authorization: 'not-granted', validation: 'not-run', consumerModified: false,
    consumerExecuted: false, publication: 'not-authorized',
  };
}
