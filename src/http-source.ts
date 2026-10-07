import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { PlumberError } from './errors.js';

export interface HttpSourcePolicy {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly url: string;
  readonly origin: string;
  readonly allowedOrigins: readonly string[];
  readonly contentKind: 'json' | 'text';
  readonly maximumBytes: number;
  readonly timeoutMs: number;
  /** An opaque permission-scope label. Change it when permissions change, not merely when a token rotates. */
  readonly authContextId: string;
}
/** Private local capture. Bytes are copied on return and verified/copied again before conditional reuse. */
export interface HttpSourceSnapshot {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly url: string;
  readonly origin: string;
  readonly authContextId: string;
  readonly contentKind: 'json' | 'text';
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
  readonly capturedAt: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
}
export interface HttpSourceCredentials {
  readonly origin: string;
  readonly authContextId: string;
  readonly getAuthorization: (context: {
    readonly sourceId: string; readonly origin: string; readonly authContextId: string; readonly signal: AbortSignal;
  }) => string | Promise<string>;
}
export interface CaptureHttpSourceOptions {
  readonly source: HttpSourcePolicy;
  readonly previous?: HttpSourceSnapshot;
  readonly credentials?: HttpSourceCredentials;
  readonly signal?: AbortSignal;
}
export interface HttpSourceAddress { readonly address: string; readonly family: 4 | 6 }
export interface HttpSourceTransportRequest {
  readonly url: string;
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}
export interface HttpSourceTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  readonly cancel: () => void;
}
export interface HttpSourceDependencies {
  /** Overrides are trusted customer code, not untrusted source content or a networking sandbox. */
  readonly resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly HttpSourceAddress[]>;
  readonly transport?: (request: HttpSourceTransportRequest) => Promise<HttpSourceTransportResponse>;
  /** Constructor seam for the pinned Node HTTPS transport. Cannot be combined with transport. */
  readonly request?: typeof httpsRequest;
}
export interface HttpSourceCapture {
  readonly status: 'captured' | 'not-modified';
  readonly snapshot: HttpSourceSnapshot;
  readonly checkedAt: string;
}
export type HttpSourceFailure = 'invalid-policy' | 'authorization-required' | 'cache-mismatch' | 'address-denied' |
  'dns-failed' | 'request-failed' | 'deadline-exceeded' | 'aborted' | 'redirect-denied' | 'http-status' |
  'compressed-response' | 'response-too-large' | 'invalid-response' | 'invalid-content';
const messages: Record<HttpSourceFailure, string> = {
  'invalid-policy': 'HTTP source policy is invalid or exceeds the supported limits.',
  'authorization-required': 'HTTP source credentials must explicitly match the selected origin and permission context.',
  'cache-mismatch': 'Conditional source evidence does not match this policy, authorization context, or captured bytes.',
  'address-denied': 'HTTP sources require a public address within the supported network profile.',
  'dns-failed': 'Could not resolve the HTTP source to a bounded set of public addresses.',
  'request-failed': 'HTTP source transport failed; no retry was attempted.',
  'deadline-exceeded': 'HTTP source capture exceeded its deadline.',
  'aborted': 'HTTP source capture was cancelled.',
  'redirect-denied': 'HTTP source redirects are not permitted.',
  'http-status': 'HTTP source returned an unsupported status; no empty capture or retry was produced.',
  'compressed-response': 'HTTP source compression is not supported; an identity representation is required.',
  'response-too-large': 'HTTP source response exceeds its configured byte or header budget.',
  'invalid-response': 'HTTP source response metadata is invalid for the selected capture profile.',
  'invalid-content': 'HTTP source body is not valid bounded UTF-8 content of the selected kind.',
};
const localErrors = new WeakMap<Error, HttpSourceFailure>();
export class HttpSourceError extends PlumberError {
  constructor(readonly reason: HttpSourceFailure) {
    super(['invalid-policy', 'authorization-required', 'cache-mismatch'].includes(reason) ? 'INVALID_INPUT' : 'ENGINE_FAILED', messages[reason]);
    this.name = 'HttpSourceError';
  }
}
function sourceError(reason: HttpSourceFailure): HttpSourceError {
  const error = new HttpSourceError(reason);
  localErrors.set(error, reason);
  return error;
}
function fail(reason: HttpSourceFailure): never { throw sourceError(reason); }
function hash(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_BYTES = 4 * 1024 * 1024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
function copyBytes(value: unknown, maximum: number, invalidReason: HttpSourceFailure, limitReason = invalidReason): Buffer {
  if (isProxy(value) || !isUint8Array(value)) fail(invalidReason);
  const length = Reflect.apply(byteLengthGetter, value, []) as number;
  if (length === 0) fail(invalidReason);
  if (length > maximum) fail(limitReason);
  const buffer = Reflect.apply(bufferGetter, value, []) as ArrayBuffer;
  if (isSharedArrayBuffer(buffer)) fail(invalidReason);
  const offset = Reflect.apply(byteOffsetGetter, value, []) as number;
  // Read intrinsic slots; own accessors must not bypass budgets or run while copying evidence.
  return Buffer.from(new Uint8Array(buffer, offset, length));
}
const prohibitedV4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24],
  ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) prohibitedV4.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const prohibitedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  prohibitedV6.addSubnet(network, prefix, 'ipv6');
}
function publicAddress(address: unknown, family?: unknown): HttpSourceAddress {
  if (typeof address !== 'string' || address.includes('%') || address.length > 45) fail('address-denied');
  const actual = isIP(address);
  if ((family !== undefined && family !== actual) || (actual !== 4 && actual !== 6)) fail('address-denied');
  if (actual === 4 ? prohibitedV4.check(address, 'ipv4') : !globalV6.check(address, 'ipv6') || prohibitedV6.check(address, 'ipv6')) fail('address-denied');
  return { address, family: actual };
}
function plain(value: unknown, required: readonly string[], optional: readonly string[] = [], reason: HttpSourceFailure = 'invalid-policy'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(reason);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(reason);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value')) fail(reason);
    result[key as string] = descriptor.value;
  }
  return result;
}
function array(value: unknown, maximum: number, reason: HttpSourceFailure): unknown[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) fail(reason);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail(reason);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(reason);
    return descriptor.value;
  });
}
function url(value: unknown, originOnly = false): URL {
  if (typeof value !== 'string' || !/^https:\/\//iu.test(value) || value.length > 2048 || /[\\\s\u0000-\u001f\u007f?#]/u.test(value)) fail('invalid-policy');
  let parsed: URL;
  try { parsed = new URL(value); } catch { fail('invalid-policy'); }
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password ||
    value.slice(value.indexOf('://') + 3).split('/')[0]!.includes('@') || (originOnly && parsed.pathname !== '/')) fail('invalid-policy');
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(hostname)) publicAddress(hostname);
  else if (hostname.length > 253 || hostname.endsWith('.') ||
    hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) fail('invalid-policy');
  return parsed;
}
function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1 || result > maximum) fail('invalid-policy');
  return result;
}

/** Prepare an explicit, serializable capture policy. This function performs no DNS, credential, or HTTP work. */
export function prepareHttpSource(input: unknown): HttpSourcePolicy {
  const value = plain(input, ['url', 'allowedOrigins', 'contentKind'], ['schemaVersion', 'id', 'origin', 'maximumBytes', 'timeoutMs', 'authContextId']);
  const parsed = url(value.url);
  const allowedOrigins = array(value.allowedOrigins, 32, 'invalid-policy').map(value => url(value, true).origin).sort();
  if (allowedOrigins.length === 0 || new Set(allowedOrigins).size !== allowedOrigins.length || !allowedOrigins.includes(parsed.origin) ||
    (value.contentKind !== 'json' && value.contentKind !== 'text') ||
    (value.schemaVersion !== undefined && value.schemaVersion !== 1) || (value.origin !== undefined && value.origin !== parsed.origin)) fail('invalid-policy');
  const authContextId = value.authContextId === undefined ? 'public' : value.authContextId;
  if (typeof authContextId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(authContextId)) fail('invalid-policy');
  const normalized: Omit<HttpSourcePolicy, 'id'> = { schemaVersion: 1 as const, url: parsed.href, origin: parsed.origin, allowedOrigins: Object.freeze(allowedOrigins),
    contentKind: value.contentKind, maximumBytes: boundedInteger(value.maximumBytes, MAXIMUM_BYTES, MAXIMUM_BYTES),
    timeoutMs: boundedInteger(value.timeoutMs, 15_000, 30_000), authContextId };
  const id = hash(JSON.stringify(normalized));
  if (value.id !== undefined && value.id !== id) fail('invalid-policy');
  return Object.freeze({ ...normalized, id });
}

function etag(value: unknown, reason: HttpSourceFailure): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 512 || !/^(?:W\/)?"[\x21\x23-\x7e]*"$/u.test(value)) fail(reason);
  return value;
}
function lastModified(value: unknown, reason: HttpSourceFailure): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length !== 29 || !Number.isFinite(Date.parse(value)) || new Date(value).toUTCString() !== value) fail(reason);
  return value;
}
function previousSnapshot(input: unknown, source: HttpSourcePolicy): HttpSourceSnapshot {
  const value = plain(input, ['schemaVersion', 'sourceId', 'url', 'origin', 'authContextId', 'contentKind', 'bytes', 'sha256', 'byteLength', 'capturedAt', 'etag', 'lastModified'], [], 'cache-mismatch');
  if (value.schemaVersion !== 1 || value.sourceId !== source.id || value.url !== source.url || value.origin !== source.origin ||
    value.authContextId !== source.authContextId || value.contentKind !== source.contentKind ||
    typeof value.sha256 !== 'string' || !SHA256.test(value.sha256) || typeof value.capturedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.capturedAt) || !Number.isFinite(Date.parse(value.capturedAt)) ||
    new Date(value.capturedAt).toISOString() !== value.capturedAt) fail('cache-mismatch');
  const bytes = copyBytes(value.bytes, source.maximumBytes, 'cache-mismatch');
  if (value.byteLength !== bytes.length || hash(bytes) !== value.sha256) fail('cache-mismatch');
  validateContent(bytes, source.contentKind);
  return Object.freeze({ schemaVersion: 1, sourceId: source.id, url: source.url, origin: source.origin, authContextId: source.authContextId,
    contentKind: source.contentKind, bytes, sha256: value.sha256, byteLength: bytes.length, capturedAt: value.capturedAt,
    etag: etag(value.etag, 'cache-mismatch'), lastModified: lastModified(value.lastModified, 'cache-mismatch') });
}
/** Validate/copy local cache evidence without DNS, credential resolution, or HTTP requests. */
export function validateHttpSourceSnapshot(source: HttpSourcePolicy, input: unknown): HttpSourceSnapshot {
  return previousSnapshot(input, prepareHttpSource(source));
}
function validateContent(bytes: Uint8Array, kind: HttpSourcePolicy['contentKind']): void {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid-content'); }
  if (bytes.byteLength === 0 || text.includes('\0')) fail('invalid-content');
  if (kind === 'text') return;
  let depth = 0, inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) { if (character === '\\') index += 1; else if (character === '"') inString = false; }
    else if (character === '"') inString = true;
    else if (character === '{' || character === '[') { depth += 1; if (depth > 128) fail('invalid-content'); }
    else if (character === '}' || character === ']') depth -= 1;
  }
  try { JSON.parse(text, (_key: string, value: unknown) => { if (typeof value === 'number' && !Number.isFinite(value)) fail('invalid-content'); return value; }); }
  catch { fail('invalid-content'); }
}

async function resolvePublic(hostname: string, signal: AbortSignal): Promise<readonly HttpSourceAddress[]> {
  const resolver = new Resolver({ timeout: 5_000, tries: 1 });
  const stop = (): void => { resolver.cancel(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) fail('aborted');
    const result = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    return result.flatMap((value, index) => value.status === 'fulfilled'
      ? value.value.map(address => ({ address, family: index === 0 ? 4 as const : 6 as const })) : []);
  } finally { signal.removeEventListener('abort', stop); resolver.cancel(); }
}
function nodeTransport(input: HttpSourceTransportRequest, constructor: typeof httpsRequest): Promise<HttpSourceTransportResponse> {
  return new Promise((resolveResponse, reject) => {
    const lookup: LookupFunction = (hostname, options, callback) => {
      if (hostname !== input.hostname) { callback(new Error('Unexpected lookup host.'), ''); return; }
      if (options.all) callback(null, [{ address: input.address, family: input.family }]);
      else callback(null, input.address, input.family);
    };
    const options: RequestOptions & { autoSelectFamily: boolean } = { method: 'GET', headers: { ...input.headers }, signal: input.signal,
      agent: false, lookup, family: input.family, autoSelectFamily: false, rejectUnauthorized: true,
      ...(isIP(input.hostname) ? {} : { servername: input.hostname }), maxHeaderSize: 8192 };
    const request = constructor(new URL(input.url), options, response => {
      const headers: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index]!.toLowerCase();
        (headers[name] ??= []).push(response.rawHeaders[index + 1]!);
      }
      resolveResponse({ statusCode: response.statusCode ?? 0, headers, body: response as AsyncIterable<Uint8Array>,
        cancel: () => { response.destroy(); request.destroy(); } });
    });
    request.maxHeadersCount = 0;
    request.on('error', reject);
    request.end();
  });
}
function responseHeaders(input: unknown): Map<string, string[]> {
  if (input === null || typeof input !== 'object' || isProxy(input) || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid-response');
  const result = new Map<string, string[]>();
  let count = 0, bytes = 0;
  for (const name of Reflect.ownKeys(input)) {
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) fail('invalid-response');
    const descriptor = Object.getOwnPropertyDescriptor(input, name)!;
    if (!Object.hasOwn(descriptor, 'value')) fail('invalid-response');
    if (descriptor.value === undefined) continue;
    const values = Array.isArray(descriptor.value) ? array(descriptor.value, 64, 'invalid-response') : [descriptor.value];
    for (const value of values) {
      if (typeof value !== 'string' || /[^\x20-\x7e]/u.test(value)) fail('invalid-response');
      count += 1; bytes += name.length + value.length + 4;
      if (count > 64 || bytes > 8192) fail('response-too-large');
      result.set(name.toLowerCase(), [...(result.get(name.toLowerCase()) ?? []), value]);
    }
  }
  return result;
}
function header(headers: Map<string, string[]>, name: string): string | undefined {
  const values = headers.get(name);
  if (values && values.length !== 1) fail('invalid-response');
  return values?.[0];
}
function contentType(value: string | undefined, kind: HttpSourcePolicy['contentKind']): void {
  if (!value) fail('invalid-response');
  const [type, ...parameters] = value.toLowerCase().split(';').map(part => part.trim());
  if (kind === 'json' ? !/^application\/(?:[a-z0-9.+-]+\+)?json$/u.test(type!) : !['text/plain', 'text/markdown', 'text/html'].includes(type!)) fail('invalid-response');
  let charset = false;
  for (const parameter of parameters) {
    if (parameter.startsWith('charset=')) {
      if (charset || !/^charset=(?:utf-8|"utf-8")$/u.test(parameter)) fail('invalid-response');
      charset = true;
    } else if (!/^[a-z0-9-]+=(?:[a-z0-9.+-]+|"[^"\r\n]*")$/u.test(parameter)) fail('invalid-response');
  }
}

/** Bounded GET only. No redirects, decompression, retries, credential discovery, or implicit source authorization. */
export async function captureHttpSource(options: CaptureHttpSourceOptions, dependencies: HttpSourceDependencies = {}): Promise<HttpSourceCapture> {
  const startedAt = performance.now();
  const source = prepareHttpSource(options.source);
  const deadline = startedAt + source.timeoutMs;
  const previous = options.previous === undefined ? undefined : previousSnapshot(options.previous, source);
  const externalSignal = options.signal;
  if (externalSignal !== undefined && (isProxy(externalSignal) || !(externalSignal instanceof AbortSignal))) fail('invalid-policy');
  let credentials: HttpSourceCredentials | undefined;
  if (options.credentials !== undefined) {
    const value = plain(options.credentials, ['origin', 'authContextId', 'getAuthorization'], [], 'authorization-required');
    if (value.origin !== source.origin || value.authContextId !== source.authContextId || source.authContextId === 'public' ||
      typeof value.getAuthorization !== 'function' || isProxy(value.getAuthorization)) fail('authorization-required');
    credentials = { origin: source.origin, authContextId: source.authContextId, getAuthorization: value.getAuthorization as HttpSourceCredentials['getAuthorization'] };
  } else if (source.authContextId !== 'public') fail('authorization-required');
  const resolver = dependencies.resolve ?? resolvePublic;
  const constructor = dependencies.request ?? httpsRequest;
  if (typeof resolver !== 'function' || typeof constructor !== 'function' ||
    (dependencies.transport !== undefined && (typeof dependencies.transport !== 'function' || dependencies.request !== undefined))) fail('invalid-policy');
  const transport = dependencies.transport ?? (request => nodeTransport(request, constructor));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: HttpSourceTransportResponse | undefined;
  let rejectCancelled: ((error: HttpSourceError) => void) | undefined;
  let cancellationReason: 'aborted' | 'deadline-exceeded' | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const stop = (reason: 'aborted' | 'deadline-exceeded'): void => {
    if (cancellationReason !== undefined) return;
    cancellationReason = reason;
    controller.abort();
    try { response?.cancel(); } catch { /* A trusted override may fail to cancel; the caller still receives a fixed failure. */ }
    rejectCancelled!(sourceError(reason));
  };
  const abort = (): void => { stop('aborted'); };
  const check = (): void => {
    if (controller.signal.aborted) fail(cancellationReason ?? 'aborted');
    if (performance.now() >= deadline) fail('deadline-exceeded');
  };
  externalSignal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => { stop('deadline-exceeded'); }, Math.max(1, Math.ceil(deadline - performance.now())));
  const work = async (): Promise<HttpSourceCapture> => {
    check();
    const parsed = new URL(source.url);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    let addresses: readonly HttpSourceAddress[];
    if (isIP(hostname)) addresses = [publicAddress(hostname)];
    else {
      let resolved: readonly HttpSourceAddress[];
      try { resolved = await resolver(hostname, controller.signal); }
      catch { check(); fail('dns-failed'); }
      check();
      addresses = array(resolved, 64, 'dns-failed').map(value => {
        const address = plain(value, ['address', 'family'], [], 'dns-failed');
        return publicAddress(address.address, address.family);
      });
      if (addresses.length === 0) fail('dns-failed');
    }
    check();
    const headers: Record<string, string> = { Accept: source.contentKind === 'json' ? 'application/json' : 'text/plain, text/markdown, text/html',
      'Accept-Encoding': 'identity', 'User-Agent': 'plumber-local-source-observer' };
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
    if (credentials) {
      let authorization: unknown;
      try { authorization = await credentials.getAuthorization(Object.freeze({ sourceId: source.id, origin: source.origin,
        authContextId: source.authContextId, signal: controller.signal })); }
      catch { check(); fail('authorization-required'); }
      check();
      if (typeof authorization !== 'string' || authorization.length > 4096 || !/^[A-Za-z][A-Za-z0-9_-]* [\x21-\x7e]+$/u.test(authorization)) fail('authorization-required');
      headers.Authorization = authorization;
    }
    check();
    response = await transport(Object.freeze({ url: source.url, hostname, ...addresses[0]!, headers: Object.freeze(headers), signal: controller.signal }));
    if (controller.signal.aborted) { try { response.cancel(); } catch { /* Discard a late trusted transport result. */ } check(); }
    check();
    const metadata = responseHeaders(response.headers);
    const encoding = header(metadata, 'content-encoding');
    if (encoding !== undefined && encoding.toLowerCase() !== 'identity') fail('compressed-response');
    if (!Number.isInteger(response.statusCode)) fail('invalid-response');
    if (response.statusCode >= 300 && response.statusCode < 400 && response.statusCode !== 304) fail('redirect-denied');
    const responseEtag = etag(header(metadata, 'etag'), 'invalid-response');
    const responseModified = lastModified(header(metadata, 'last-modified'), 'invalid-response');
    if (response.statusCode === 304) {
      if (!previous || (!previous.etag && !previous.lastModified) ||
        (responseEtag !== null && responseEtag !== previous.etag) || (responseModified !== null && responseModified !== previous.lastModified)) fail('cache-mismatch');
      check();
      return Object.freeze({ status: 'not-modified', snapshot: previous, checkedAt: new Date().toISOString() });
    }
    if (response.statusCode !== 200) fail('http-status');
    contentType(header(metadata, 'content-type'), source.contentKind);
    const contentLength = header(metadata, 'content-length');
    if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))) fail('invalid-response');
    if (contentLength !== undefined && Number(contentLength) > source.maximumBytes) fail('response-too-large');
    const chunks: Buffer[] = [];
    let length = 0, chunkCount = 0;
    for await (const chunk of response.body) {
      check();
      const bytes = copyBytes(chunk, source.maximumBytes, 'invalid-response', 'response-too-large');
      chunkCount += 1; length += bytes.length;
      if (length > source.maximumBytes || chunkCount > 65_536) fail('response-too-large');
      chunks.push(bytes);
    }
    check();
    if (contentLength !== undefined && Number(contentLength) !== length) fail('invalid-response');
    const bytes = Buffer.concat(chunks, length);
    validateContent(bytes, source.contentKind);
    // A timer cannot preempt synchronous parsing; expired parsing must still reject the capture.
    check();
    const capturedAt = new Date().toISOString();
    const snapshot: HttpSourceSnapshot = Object.freeze({ schemaVersion: 1, sourceId: source.id, url: source.url, origin: source.origin,
      authContextId: source.authContextId, contentKind: source.contentKind, bytes, sha256: hash(bytes), byteLength: length, capturedAt,
      etag: responseEtag, lastModified: responseModified });
    check();
    return Object.freeze({ status: 'captured', snapshot, checkedAt: capturedAt });
  };
  try {
    if (externalSignal?.aborted) abort();
    return await Promise.race([work(), cancelled]);
  } catch (error) {
    return fail(localErrors.get(error as Error) ?? 'request-failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
    controller.abort();
    try { response?.cancel(); } catch { /* Cancellation cannot expose trusted transport errors or replace the capture result. */ }
  }
}
