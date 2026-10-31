import { randomUUID } from 'node:crypto';
import { constants, createWriteStream, openSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Fetcher } from 'tuf-js';
// tuf-js 5.0.1 requires this error identity to recognize the end of root rotation,
// but does not re-export it. Keep the exact dependency and boundary test pinned.
import { DownloadHTTPError } from 'tuf-js/dist/error.js';
import { publicAddress, resolveAddresses } from './public-network.js';
import type { ClientUpdateDependencies } from './client-update.js';
import { ClientUpdateError } from './client-update-errors.js';

export const UPDATE_ARTIFACT_LIMIT = 32 * 1024 * 1024;
export const UPDATE_METADATA_LIMIT = 1024 * 1024;
type Transfer = { readonly path: string; readonly absentRoot: boolean; created: boolean };

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
  constructor(private readonly metadataUrl: string, private readonly targetsUrl: string,
    private readonly temporaryDirectory: string, private readonly signal: AbortSignal,
    private readonly dependencies: ClientUpdateDependencies = {}) {}

  async downloadBytes(url: string, maximum: number): Promise<Buffer> {
    return this.downloadFile(url, Math.min(maximum, UPDATE_METADATA_LIMIT), async file => readFile(file));
  }

  async downloadFile<T>(url: string, maximum: number, handler: (path: string) => Promise<T>): Promise<T> {
    return this.fetchFile(url, maximum, handler);
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
    const temporary = join(this.temporaryDirectory, `fetch-${randomUUID()}.part`);
    const transfer: Transfer = { path: temporary, created: false,
      absentRoot: isMetadata && /^[1-9]\d*\.root\.json$/u.test(relative) };
    try {
      await this.transfer(parsed, maximum, transfer);
      if (this.signal.aborted) throw new Error('Update cancelled.');
      return await handler(temporary);
    } finally {
      if (transfer.created) await unlink(temporary);
    }
  }

  private async transfer(parsed: URL, maximum: number, transfer: Transfer): Promise<void> {
    if (++this.requests > 40) throw new ClientUpdateError('verification-failed');
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    const answers = isIP(hostname) ? [publicAddress(hostname)]
      : await abortable((this.dependencies.resolve ?? resolveAddresses)(hostname, this.signal), this.signal);
    if (this.signal.aborted || answers.length < 1 || answers.length > 64) throw new Error('Update resolution failed.');
    const validated = answers.map(answer => publicAddress(answer.address, answer.family));
    const selected = validated[0]!;
    return new Promise<void>((resolve, reject) => {
        let receiving: import('node:http').IncomingMessage | undefined;
        const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
          method: 'GET', agent: false, autoSelectFamily: false, family: selected.family,
          servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true, signal: this.signal,
          maxHeaderSize: 8192, headers: { 'accept-encoding': 'identity', 'user-agent': 'self-managed-api-release-check' },
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
            if (response.statusCode === 404 && transfer.absentRoot) {
              response.destroy();
              reject(new DownloadHTTPError('Release root absent.', 404));
            } else { response.destroy(); reject(new Error('Release HTTP status denied.')); }
            return;
          }
          const encoding = response.headers['content-encoding'];
          const length = response.headers['content-length'];
          if ((encoding !== undefined && encoding !== 'identity') || response.rawHeaders.length > 128
            || (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maximum))) {
            response.destroy(); reject(new Error('Release response denied.')); return;
          }
          let bytes = 0, chunks = 0;
          const bounds = new Transform({ transform: (chunk: Buffer, _encoding, done) => {
            bytes += chunk.length; this.received += chunk.length; chunks++;
            done(bytes > maximum || chunks > 65_536 || this.received > UPDATE_ARTIFACT_LIMIT + 8 * UPDATE_METADATA_LIMIT
              ? new ClientUpdateError('verification-failed') : null, chunk);
          } });
          let output: ReturnType<typeof createWriteStream>;
          try {
            const descriptor = openSync(transfer.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
              | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600);
            transfer.created = true; output = createWriteStream(transfer.path, { fd: descriptor, autoClose: true });
          } catch (error) { response.destroy(); reject(error); return; }
          void pipeline(response, bounds, output, { signal: this.signal }).then(() => {
            if (bytes === 0 || (length !== undefined && bytes !== Number(length))) reject(new Error('Release response length mismatch.'));
            else resolve();
          }, reject);
        });
        // Keep the complete header list inside Node's byte cap. Truncating it
        // could hide a late Content-Encoding field from the explicit checks.
        request.maxHeadersCount = 0;
        // Once streaming begins, pipeline owns completion and closes its file
        // before cleanup. A late request error must not race unlink on Windows.
        request.once('error', error => { if (receiving) receiving.destroy(error); else reject(error); });
        request.end();
    });
  }
}
