import { randomUUID } from 'node:crypto';
import { constants, createWriteStream, openSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import type { Fetcher } from 'tuf-js';
// tuf-js 5.0.1 requires this error identity to recognize the end of root rotation,
// but does not re-export it. Keep the exact dependency and boundary test pinned.
import { DownloadHTTPError } from 'tuf-js/dist/error.js';
import { publicAddress, resolveAddresses } from './public-network.js';
import type { ClientUpdateDependencies } from './client-update.js';
import type { CloudUpdateAuthorization } from './client-update-auth.js';
import { ClientUpdateError, type ClientUpdateReason } from './client-update-errors.js';

export const UPDATE_ARTIFACT_LIMIT = 32 * 1024 * 1024;
export const UPDATE_METADATA_LIMIT = 1024 * 1024;
type Transfer = { readonly kind: 'download'; readonly path: string; readonly absentRoot: boolean; created: boolean; readonly proof?: string; readonly token?: string }
  | { readonly kind: 'token'; readonly body: string; readonly proof: string };

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Update cancelled.');
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => { reject(new Error('Update cancelled.')); };
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

export function releaseBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\s%?#]/u.test(value)) throw new Error('Invalid release URL.');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.href !== value
    || !parsed.pathname.endsWith('/') || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/u.test(parsed.pathname)) throw new Error('Invalid release URL.');
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(hostname)) publicAddress(hostname);
  return parsed.href;
}

/** All update downloads use the same total deadline, explicit roots and pinned public DNS. */
export class ReleaseFetcher implements Fetcher {
  private requests = 0;
  private received = 0;
  private observedFailure: ClientUpdateError | undefined;
  /** tuf-js wraps snapshot/targets failures without retaining their cause. */
  get failure(): ClientUpdateError | undefined { return this.observedFailure; }
  constructor(private readonly metadataUrl: string, private readonly targetsUrl: string,
    private readonly temporaryDirectory: string, private readonly signal: AbortSignal,
    private readonly dependencies: ClientUpdateDependencies = {}, private readonly authorization?: CloudUpdateAuthorization) {}

  async downloadBytes(url: string, maximum: number): Promise<Buffer> {
    return this.downloadFile(url, Math.min(maximum, UPDATE_METADATA_LIMIT), async file => readFile(file));
  }

  async downloadFile<T>(url: string, maximum: number, handler: (path: string) => Promise<T>): Promise<T> {
    try { return await this.fetchFile(url, maximum, handler); }
    catch (error) {
      if (this.authorization && error instanceof ClientUpdateError) this.observedFailure ??= error;
      throw error;
    }
  }

  private async fetchFile<T>(url: string, maximum: number, handler: (path: string) => Promise<T>): Promise<T> {
    const parsed = new URL(url);
    const isMetadata = url.startsWith(this.metadataUrl);
    const root = isMetadata ? this.metadataUrl : this.targetsUrl;
    const relative = url.slice(root.length);
    if (parsed.href !== url || !url.startsWith(root) || parsed.origin !== new URL(root).origin || parsed.protocol !== 'https:'
      || parsed.username || parsed.password || parsed.search || parsed.hash || /[\\%\s]/u.test(url)
      || relative.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-zA-Z0-9._/-]+$/u.test(relative)) throw new Error('Release destination denied.');
    const limit = isMetadata ? UPDATE_METADATA_LIMIT : UPDATE_ARTIFACT_LIMIT;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > limit) throw new Error('Update download limit.');
    if (this.authorization && (isMetadata ? !/^(?:timestamp\.json|[1-9]\d{0,9}\.(?:root|snapshot|targets)\.json)$/u.test(relative)
      : !/^(?:[a-zA-Z0-9._-]+\/)*[a-f0-9]{64}\.[a-zA-Z0-9._-]+$/u.test(relative))) throw new Error('Release destination denied.');
    let token: string | undefined, proof: string | undefined;
    if (this.authorization) {
      token = this.authorization.tokenValue();
      if (!token) {
        const url = `${this.authorization.baseUrl}/api/worker/v1/token`, startedAt = Date.now();
        const bytes = await this.transfer(new URL(url), 16_384, { kind: 'token', body: this.authorization.tokenBody(), proof: await this.authorization.proof(url, 'POST') });
        token = this.authorization.acceptToken(bytes, startedAt);
      }
      proof = await this.authorization.proof(url, 'GET', token);
    }
    const temporary = join(this.temporaryDirectory, `fetch-${randomUUID()}.part`);
    const transfer: Transfer = { kind: 'download', path: temporary, created: false,
      absentRoot: isMetadata && /^[1-9]\d*\.root\.json$/u.test(relative), ...(proof && token ? { proof, token } : {}) };
    try {
      await this.transfer(parsed, maximum, transfer);
      if (this.signal.aborted) throw new Error('Update cancelled.');
      return await handler(temporary);
    } finally {
      if (transfer.created) await unlink(temporary);
    }
  }

  private async transfer(parsed: URL, maximum: number, transfer: Transfer): Promise<Buffer> {
    if (++this.requests > 40) throw new ClientUpdateError('verification-failed');
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    let answers: readonly import('./public-network.js').PublicAddress[];
    try { answers = isIP(hostname) ? [publicAddress(hostname)]
      : await abortable((this.dependencies.resolve ?? resolveAddresses)(hostname, this.signal), this.signal); }
    catch (error) { if (this.authorization) throw new ClientUpdateError('network-unavailable'); throw error; }
    if (this.authorization && answers.length === 0) throw new ClientUpdateError('network-unavailable');
    if (this.signal.aborted || answers.length < 1 || answers.length > 64) throw new Error('Update resolution failed.');
    const validated = answers.map(answer => publicAddress(answer.address, answer.family));
    const selected = validated[0]!;
    return new Promise<Buffer>((resolve, reject) => {
        let receiving: import('node:http').IncomingMessage | undefined;
        const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
          method: transfer.kind === 'token' ? 'POST' : 'GET', agent: false, autoSelectFamily: false, family: selected.family,
          servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true, signal: this.signal,
          maxHeaderSize: 8192, headers: { 'accept-encoding': 'identity', 'user-agent': 'keepseam-release-check',
            ...(transfer.proof ? { DPoP: transfer.proof } : {}),
            ...(transfer.kind === 'token' ? { 'content-type': 'application/x-www-form-urlencoded' }
              : transfer.token ? { authorization: `DPoP ${transfer.token}` } : {}) },
          lookup: (name, options, callback) => {
            if (name !== hostname) { callback(new Error('Unexpected update hostname.'), ''); return; }
            if (options.all) callback(null, [selected]);
            else callback(null, selected.address, selected.family);
          },
        };
        const request = (this.dependencies.request ?? httpsRequest)(parsed, requestOptions, response => {
          receiving = response;
          if (response.statusCode !== 200) {
            // Only a missing next root means rotation is complete. A forbidden
            // destination is an error, even though upstream also accepts 403.
            if (response.statusCode === 404 && transfer.kind === 'download' && transfer.absentRoot) {
              response.destroy();
              reject(new DownloadHTTPError('Release root absent.', 404));
            } else if (this.authorization) void this.httpFailure(response).then(reject, reject);
            else { response.destroy(); reject(new Error('Release HTTP status denied.')); }
            return;
          }
          const encoding = response.headers['content-encoding'];
          const length = response.headers['content-length'];
          if ((encoding !== undefined && encoding !== 'identity') || response.rawHeaders.length > 128
            || transfer.kind === 'token' && !/^application\/json(?:\s*;|$)/iu.test(response.headers['content-type'] ?? '')
            || (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maximum))) {
            response.destroy(); reject(new Error('Release response denied.')); return;
          }
          let bytes = 0, chunks = 0;
          const bounds = new Transform({ transform: (chunk: Buffer, _encoding, done) => {
            bytes += chunk.length; this.received += chunk.length; chunks++;
            done(bytes > maximum || chunks > 65_536 || this.received > UPDATE_ARTIFACT_LIMIT + 8 * UPDATE_METADATA_LIMIT
              ? new ClientUpdateError('verification-failed') : null, chunk);
          } });
          const chunksReceived: Buffer[] = [];
          let output: Writable;
          try {
            if (transfer.kind === 'token') output = new Writable({ write(chunk: Buffer, _encoding, done) { chunksReceived.push(chunk); done(); } });
            else {
              const descriptor = openSync(transfer.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
                | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600);
              transfer.created = true; output = createWriteStream(transfer.path, { fd: descriptor, autoClose: true });
            }
          } catch (error) { response.destroy(); reject(error); return; }
          void pipeline(response, bounds, output, { signal: this.signal }).then(() => {
            if (bytes === 0 || (length !== undefined && bytes !== Number(length))) reject(new Error('Release response length mismatch.'));
            else resolve(Buffer.concat(chunksReceived));
          }, error => reject(this.authorization && !(error instanceof ClientUpdateError) ? new ClientUpdateError('network-unavailable') : error));
        });
        // Keep the complete header list inside Node's byte cap. Truncating it
        // could hide a late Content-Encoding field from the explicit checks.
        request.maxHeadersCount = 0;
        // Once streaming begins, pipeline owns completion and closes its file
        // before cleanup. A late request error must not race unlink on Windows.
        request.once('error', error => { if (receiving) receiving.destroy(error); else reject(this.authorization ? new ClientUpdateError('network-unavailable') : error); });
        if (transfer.kind === 'token') request.end(transfer.body); else request.end();
    });
  }

  private async httpFailure(response: import('node:http').IncomingMessage): Promise<ClientUpdateError> {
    const status = response.statusCode ?? 0;
    const fallback = status === 401 || status === 403 ? 'authorization-rejected' : status === 429 ? 'rate-limited'
      : status === 404 ? 'target-unavailable' : status === 410 ? 'release-withdrawn' : status >= 500 ? 'network-unavailable' : 'verification-failed';
    if (status !== 503 || (response.headers['content-encoding'] !== undefined && response.headers['content-encoding'] !== 'identity') || !/^application\/json(?:\s*;|$)/iu.test(response.headers['content-type'] ?? '')
      || response.rawHeaders.length > 128 || Number(response.headers['content-length'] ?? 0) > 4096) {
      response.destroy(); return new ClientUpdateError(fallback);
    }
    const codes: Readonly<Record<string, Exclude<ClientUpdateReason, 'none'>>> = {
      UPDATE_FEED_UNAVAILABLE: 'feed-unavailable', UPDATE_TRUST_EXPIRED: 'trust-expired',
      UPDATE_TARGETS_EXPIRED: 'targets-expired', UPDATE_FRESHNESS_EXPIRED: 'metadata-expired',
    };
    let bytes = 0, count = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of response) {
        bytes += chunk.length; this.received += chunk.length; count++;
        if (bytes > 4096 || count > 4096 || this.received > UPDATE_ARTIFACT_LIMIT + 8 * UPDATE_METADATA_LIMIT) break;
        chunks.push(Buffer.from(chunk));
      }
      if (bytes <= 4096 && count <= 4096) {
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (input && typeof input === 'object' && 'error' in input && input.error && typeof input.error === 'object'
          && 'code' in input.error && typeof input.error.code === 'string' && Object.hasOwn(codes, input.error.code)) {
          return new ClientUpdateError(codes[input.error.code]!);
        }
      }
    } catch { /* The fixed HTTP status remains authoritative; provider bodies are never reported. */ }
    finally { response.destroy(); }
    return new ClientUpdateError(fallback);
  }
}
