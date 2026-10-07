import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { PlumberError } from './errors.js';

export type IntegrationVersionAxis = 'api' | 'sdk' | 'webhook' | 'mcp-protocol' | 'mcp-server';
export type IntegrationSourceKind = 'openapi' | 'json-schema' | 'json-sample' | 'documentation' |
  'changelog' | 'mcp' | 'sdk-release' | 'security-advisory' | 'framework-export' | 'database-schema';

export interface IntegrationSource {
  readonly id: string;
  readonly kind: IntegrationSourceKind;
  readonly location: { readonly type: 'https'; readonly url: string } | { readonly type: 'local'; readonly path: string };
  readonly provenance: 'declared-contract' | 'observed-behavior' | 'documentation-claim' | 'inferred';
  readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly sha256?: string;
  readonly capturedAt?: string;
}

export interface IntegrationDateEvidence {
  /** Null records an ambiguous or unannounced date; it does not imply indefinite support. */
  readonly date: string | null;
  readonly sourceIds: readonly string[];
  readonly note?: string;
}

export interface IntegrationKnownVersion {
  readonly id: string;
  readonly axis: IntegrationVersionAxis;
  readonly value: string;
  readonly sourceIds: readonly string[];
  readonly scope?: {
    readonly operations: readonly string[];
    readonly regions: readonly string[];
    readonly marketplaces: readonly string[];
  };
  readonly supportEnds?: IntegrationDateEvidence;
  readonly retirement?: IntegrationDateEvidence;
}

export interface IntegrationEffectiveVersion {
  readonly axis: IntegrationVersionAxis;
  readonly value: string | null;
  readonly sourceIds: readonly string[];
  readonly selector: 'account' | 'request-header' | 'endpoint' | 'package' | 'negotiated' | 'unknown';
  readonly selectorName?: string;
  readonly endpointId?: string;
  readonly repositoryRevision?: string;
}

export interface IntegrationContractReference {
  readonly sourceId: string;
  readonly pointer: string;
}

export interface IntegrationBoundary {
  readonly id: string;
  readonly inputContract?: IntegrationContractReference;
  readonly outputContract?: IntegrationContractReference;
  readonly requirements: readonly {
    readonly id: string;
    readonly kind: 'permission' | 'capability' | 'dependency' | 'configuration' | 'business-decision';
    readonly description: string;
    readonly sourceIds: readonly string[];
  }[];
}

/** Local inventory only. URLs and paths are declarations, never authorization to retrieve them. */
export interface IntegrationManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly provider: string;
  readonly product: string;
  readonly endpoints: readonly { readonly id: string; readonly url: string; readonly environment: string }[];
  readonly sources: readonly IntegrationSource[];
  readonly knownVersions: readonly IntegrationKnownVersion[];
  readonly effectiveVersions: readonly IntegrationEffectiveVersion[];
  readonly boundaries: readonly IntegrationBoundary[];
  readonly versionCoverage: 'listed-only';
}

export interface RegisteredIntegrationBoundary {
  readonly manifest: IntegrationManifest;
  readonly boundaryId: string;
}

const MAXIMUM_BYTES = 256 * 1024;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const AXES: readonly IntegrationVersionAxis[] = ['api', 'sdk', 'webhook', 'mcp-protocol', 'mcp-server'];
const SOURCE_KINDS: readonly IntegrationSourceKind[] = ['openapi', 'json-schema', 'json-sample', 'documentation',
  'changelog', 'mcp', 'sdk-release', 'security-advisory', 'framework-export', 'database-schema'];
const CONTRACT_SOURCES = new Set<IntegrationSourceKind>(['openapi', 'json-schema', 'mcp', 'framework-export', 'database-schema']);
const registered = new WeakMap<Function, RegisteredIntegrationBoundary>();

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid('Integration manifests require plain JSON objects.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length ||
    keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)) ||
    required.some(key => !Object.hasOwn(value, key)) ||
    keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    invalid('An integration manifest contains missing, unknown, or executable fields.');
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) result[key as string] = Object.getOwnPropertyDescriptor(value, key)!.value;
  return result;
}

function array(value: unknown, maximum: number): unknown[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    invalid('Integration collections require bounded plain arrays.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
    invalid('Integration arrays must be dense and cannot contain extra properties.');
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Integration arrays cannot contain accessors.');
    return descriptor.value;
  });
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid('An integration field has an unsupported value.');
  return value as T;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function sortById<T extends { readonly id: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.id < right.id ? -1 : left.id === right.id ? 0 : 1);
}

/** Validate and copy an explicit inventory without reading files, contacting providers, or running consumers. */
export function normalizeIntegrationManifest(input: unknown): IntegrationManifest {
  const manifest = record(input, ['schemaVersion', 'provider', 'product', 'sources', 'knownVersions', 'effectiveVersions'],
    ['id', 'endpoints', 'boundaries', 'versionCoverage']);
  if (manifest.schemaVersion !== 1 || (Object.hasOwn(manifest, 'versionCoverage') && manifest.versionCoverage !== 'listed-only')) {
    invalid('Only integration manifest version 1 with listed-only coverage is supported.');
  }
  let bytes = 0;
  const text = (value: unknown, maximum = 512): string => {
    if (typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) ||
      Buffer.byteLength(value, 'utf8') > maximum) invalid('Integration text must be nonempty, bounded, and free of control characters.');
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAXIMUM_BYTES) invalid('Integration manifest exceeds the 256 KiB limit.');
    return value;
  };
  const identifier = (value: unknown): string => {
    const result = text(value, 96);
    if (!IDENTIFIER.test(result)) invalid('Integration identifiers must use lowercase letters, numbers, dots, hyphens, or underscores.');
    return result;
  };
  const url = (value: unknown): string => {
    const original = text(value, 2048);
    let parsed: URL;
    try { parsed = new URL(original); } catch { invalid('Integration URLs must be absolute HTTPS URLs without credentials, queries, or fragments.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      original.includes('?') || original.includes('#') || /[\\\s]/u.test(original)) {
      invalid('Integration URLs must be absolute HTTPS URLs without credentials, queries, or fragments.');
    }
    return parsed.href;
  };
  const unique = <T>(items: T[], key: (value: T) => string): T[] => {
    if (new Set(items.map(key)).size !== items.length) invalid('Integration collections cannot contain duplicate identifiers or selectors.');
    return items;
  };
  const provider = text(manifest.provider, 128);
  const product = text(manifest.product, 128);
  const endpoints = sortById(unique(array(Object.hasOwn(manifest, 'endpoints') ? manifest.endpoints : [], 32).map(value => {
    const endpoint = record(value, ['id', 'url', 'environment']);
    return { id: identifier(endpoint.id), url: url(endpoint.url), environment: identifier(endpoint.environment) };
  }), endpoint => endpoint.id));
  const sources = sortById(unique(array(manifest.sources, 128).map((value): IntegrationSource => {
    const source = record(value, ['id', 'kind', 'location', 'provenance', 'coverage'], ['sha256', 'capturedAt']);
    const location = record(source.location, ['type'], ['url', 'path']);
    let normalizedLocation: IntegrationSource['location'];
    if (location.type === 'https' && Object.hasOwn(location, 'url') && !Object.hasOwn(location, 'path')) {
      normalizedLocation = { type: 'https', url: url(location.url) };
    } else if (location.type === 'local' && Object.hasOwn(location, 'path') && !Object.hasOwn(location, 'url')) {
      const path = text(location.path, 1024);
      if (/[\\:*?<>|]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
        invalid('Local source locations must be relative POSIX paths without traversal or wildcards.');
      }
      normalizedLocation = { type: 'local', path };
    } else invalid('Each source requires exactly one HTTPS URL or local relative path.');
    const kind = choice(source.kind, SOURCE_KINDS);
    const provenance = choice(source.provenance, ['declared-contract', 'observed-behavior', 'documentation-claim', 'inferred']);
    if (kind === 'json-sample' && !['observed-behavior', 'inferred'].includes(provenance)) {
      invalid('JSON samples cannot be represented as declared contracts.');
    }
    let sha256: string | undefined;
    if (Object.hasOwn(source, 'sha256')) {
      sha256 = text(source.sha256, 64);
      if (!SHA256.test(sha256)) invalid('Source digests must be lowercase SHA-256 values.');
    }
    let capturedAt: string | undefined;
    if (Object.hasOwn(source, 'capturedAt')) {
      capturedAt = text(source.capturedAt, 24);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(capturedAt) ||
        !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) {
        invalid('Capture timestamps must be valid canonical UTC timestamps.');
      }
    }
    return { id: identifier(source.id), kind, location: normalizedLocation, provenance,
      coverage: choice(source.coverage, ['complete', 'partial', 'unknown']),
      ...(sha256 === undefined ? {} : { sha256 }), ...(capturedAt === undefined ? {} : { capturedAt }) };
  }), source => source.id));
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const sourceIds = (value: unknown, allowEmpty = false): string[] => {
    const result = unique(array(value, 32).map(identifier), id => id).sort();
    if ((!allowEmpty && result.length === 0) || result.some(id => !sourceById.has(id))) {
      invalid('Evidence must reference registered sources and cannot be empty for an asserted fact.');
    }
    return result;
  };
  const datedEvidence = (value: unknown): IntegrationDateEvidence => {
    const evidence = record(value, ['date', 'sourceIds'], ['note']);
    const date = evidence.date === null ? null : text(evidence.date, 10);
    if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date)) {
      invalid('Support and retirement dates must be actual ISO calendar dates, or null with an explanation.');
    }
    const note = Object.hasOwn(evidence, 'note') ? text(evidence.note, 2048) : undefined;
    if (date === null && note === undefined) invalid('An uncertain date requires an explanation.');
    return { date, sourceIds: sourceIds(evidence.sourceIds), ...(note === undefined ? {} : { note }) };
  };
  const scopeList = (value: unknown): string[] => unique(array(value, 64).map(item => text(item, 256)), item => item).sort();
  const knownVersions = sortById(unique(array(manifest.knownVersions, 256).map((value): IntegrationKnownVersion => {
    const version = record(value, ['id', 'axis', 'value', 'sourceIds'], ['scope', 'supportEnds', 'retirement']);
    let scope: IntegrationKnownVersion['scope'];
    if (Object.hasOwn(version, 'scope')) {
      const inputScope = record(version.scope, ['operations', 'regions', 'marketplaces']);
      scope = { operations: scopeList(inputScope.operations), regions: scopeList(inputScope.regions),
        marketplaces: scopeList(inputScope.marketplaces) };
    }
    return { id: identifier(version.id), axis: choice(version.axis, AXES), value: text(version.value, 128),
      sourceIds: sourceIds(version.sourceIds), ...(scope === undefined ? {} : { scope }),
      ...(Object.hasOwn(version, 'supportEnds') ? { supportEnds: datedEvidence(version.supportEnds) } : {}),
      ...(Object.hasOwn(version, 'retirement') ? { retirement: datedEvidence(version.retirement) } : {}) };
  }), version => version.id));
  const effectiveVersions = unique(array(manifest.effectiveVersions, 128).map((value): IntegrationEffectiveVersion => {
    const effective = record(value, ['axis', 'value', 'sourceIds', 'selector'], ['selectorName', 'endpointId', 'repositoryRevision']);
    const axis = choice(effective.axis, AXES);
    const version = effective.value === null ? null : text(effective.value, 128);
    const selector = choice(effective.selector, ['account', 'request-header', 'endpoint', 'package', 'negotiated', 'unknown']);
    const selectorName = Object.hasOwn(effective, 'selectorName') ? text(effective.selectorName, 214) : undefined;
    if ((version === null) !== (selector === 'unknown')) invalid('Unknown effective versions must have a null value and unknown selector.');
    if ((selector === 'request-header' || selector === 'package') !== (selectorName !== undefined)) {
      invalid('Only request-header and package selectors require a selector name.');
    }
    if ((selector === 'package' && axis !== 'sdk') || (axis === 'sdk' && version !== null && selector !== 'package')) {
      invalid('SDK package versions and API versions require separate selectors.');
    }
    if (selector === 'request-header' && (!/^[A-Za-z][A-Za-z0-9-]{0,95}$/u.test(selectorName!) ||
      /authorization|cookie|token|secret|api-?key/iu.test(selectorName!))) {
      invalid('Version selectors cannot contain authentication or cookie header names.');
    }
    if (selector === 'package' && !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(selectorName!)) {
      invalid('Package selectors require a package name without a version, path, or URL.');
    }
    let endpointId: string | undefined;
    if (Object.hasOwn(effective, 'endpointId')) {
      endpointId = identifier(effective.endpointId);
      if (!endpoints.some(endpoint => endpoint.id === endpointId)) invalid('Effective versions must reference a registered endpoint.');
    }
    let repositoryRevision: string | undefined;
    if (Object.hasOwn(effective, 'repositoryRevision')) {
      repositoryRevision = text(effective.repositoryRevision, 64);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(repositoryRevision)) invalid('Repository revisions must be complete hexadecimal commit IDs.');
    }
    return { axis, value: version, sourceIds: sourceIds(effective.sourceIds, version === null), selector,
      ...(selectorName === undefined ? {} : { selectorName }), ...(endpointId === undefined ? {} : { endpointId }),
      ...(repositoryRevision === undefined ? {} : { repositoryRevision }) };
  }), value => JSON.stringify([value.axis, value.selector, value.selectorName ?? null, value.endpointId ?? null]))
    .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) === JSON.stringify(right) ? 0 : 1);
  const contractReference = (value: unknown): IntegrationContractReference => {
    const reference = record(value, ['sourceId', 'pointer']);
    const sourceId = identifier(reference.sourceId);
    const source = sourceById.get(sourceId);
    if (!source || !CONTRACT_SOURCES.has(source.kind) || source.provenance !== 'declared-contract') {
      invalid('Boundary contracts must reference registered declared schemas, not examples or inferred behavior.');
    }
    const pointer = reference.pointer === '' ? '' : text(reference.pointer, 1024);
    if (pointer !== '' && (!pointer.startsWith('/') || /~(?![01])/u.test(pointer))) invalid('Contract pointers must use JSON Pointer syntax.');
    return { sourceId, pointer };
  };
  const boundaries = sortById(unique(array(Object.hasOwn(manifest, 'boundaries') ? manifest.boundaries : [], 128).map((value): IntegrationBoundary => {
    const boundary = record(value, ['id', 'requirements'], ['inputContract', 'outputContract']);
    const requirements = sortById(unique(array(boundary.requirements, 64).map(item => {
      const requirement = record(item, ['id', 'kind', 'description', 'sourceIds']);
      return { id: identifier(requirement.id), kind: choice(requirement.kind,
        ['permission', 'capability', 'dependency', 'configuration', 'business-decision']),
      description: text(requirement.description, 2048), sourceIds: sourceIds(requirement.sourceIds) };
    }), requirement => requirement.id));
    return { id: identifier(boundary.id), requirements,
      ...(Object.hasOwn(boundary, 'inputContract') ? { inputContract: contractReference(boundary.inputContract) } : {}),
      ...(Object.hasOwn(boundary, 'outputContract') ? { outputContract: contractReference(boundary.outputContract) } : {}) };
  }), boundary => boundary.id));
  const normalized = { schemaVersion: 1 as const, provider, product, endpoints, sources, knownVersions, effectiveVersions,
    boundaries, versionCoverage: 'listed-only' as const };
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAXIMUM_BYTES) invalid('Integration manifest exceeds the 256 KiB limit.');
  const id = createHash('sha256').update(serialized, 'utf8').digest('hex');
  if (Object.hasOwn(manifest, 'id') && manifest.id !== id) invalid('The integration manifest does not match its content digest.');
  return freeze({ ...normalized, id });
}

/** Register metadata on the original function: no wrapper, proxy, validation, or traffic interception. */
export function defineIntegrationBoundary<F extends Function>(manifest: unknown, handler: F, boundaryId?: string): F {
  if (typeof handler !== 'function' || isProxy(handler)) invalid('Integration boundaries require a non-proxy function.');
  const normalized = normalizeIntegrationManifest(manifest);
  const selected = boundaryId ?? (normalized.boundaries.length === 1 ? normalized.boundaries[0]!.id : undefined);
  if (selected === undefined || !normalized.boundaries.some(boundary => boundary.id === selected)) {
    invalid('Select one registered boundary; its identifier is required when the manifest declares several boundaries.');
  }
  const existing = registered.get(handler);
  if (existing && (existing.manifest.id !== normalized.id || existing.boundaryId !== selected)) {
    invalid('An existing function boundary cannot be silently replaced; register a new function explicitly.');
  }
  if (!existing) registered.set(handler, freeze({ manifest: normalized, boundaryId: selected }));
  return handler;
}

export function getIntegrationBoundary(handler: Function): RegisteredIntegrationBoundary | undefined {
  return registered.get(handler);
}
