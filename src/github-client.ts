import { PlumberError } from './errors.js';

export interface GitHubClientOptions {
  /** Resolve a short-lived customer credential at request time; never persisted by this client. */
  readonly getToken: () => string | Promise<string>;
  /** A trusted transport override for controlled tests or customer networking. */
  readonly transport?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface GitHubClient {
  request(method: 'GET' | 'POST', path: string, body?: unknown, allowMissing?: boolean, expiresAt?: string): Promise<unknown | null>;
}

const safeErrors = new WeakSet<PlumberError>();
function safeError(code: 'INVALID_INPUT' | 'ENGINE_FAILED', message: string): PlumberError {
  const error = new PlumberError(code, message);
  safeErrors.add(error);
  return error;
}
function invalid(message: string): never { throw safeError('INVALID_INPUT', message); }
function failed(message: string): never { throw safeError('ENGINE_FAILED', message); }

/** Fixed-origin, bounded requests. This client never retries writes or follows redirects. */
export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  if (!options || typeof options.getToken !== 'function' || (options.transport !== undefined && typeof options.transport !== 'function')) {
    invalid('GitHub requires a trusted credential resolver and transport.');
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) invalid('GitHub timeout must be between 1 and 60000 ms.');
  const transport = options.transport ?? globalThis.fetch;
  return Object.freeze({
    async request(method: 'GET' | 'POST', path: string, body?: unknown, allowMissing = false, expiresAt?: string): Promise<unknown | null> {
      if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|\?|$)/u.test(path)
        || path.includes('\\') || /[\u0000-\u0020\u007f#]/u.test(path) || path.length > 4096) invalid('Unsupported GitHub request route.');
      const url = new URL(path, 'https://api.github.com');
      if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith('/repos/') || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu.test(path)) invalid('GitHub requests must use the fixed API origin.');
      let encoded: string | undefined;
      if (body !== undefined) {
        if (method !== 'POST') invalid('GitHub reads cannot have request bodies.');
        encoded = JSON.stringify(body);
        if (!encoded || Buffer.byteLength(encoded) > 4 * 1024 * 1024) invalid('GitHub request exceeds the 4 MiB byte budget.');
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(safeError('ENGINE_FAILED', 'GitHub request timed out; a write may have completed remotely.')); }, timeoutMs);
      });
      const work = async (): Promise<unknown | null> => {
        const token = await options.getToken();
        if (controller.signal.aborted) failed('GitHub request deadline expired.');
        if (expiresAt !== undefined && (!Number.isFinite(Date.parse(expiresAt)) || Date.now() >= Date.parse(expiresAt))) {
          failed('GitHub publication authorization expired before transport.');
        }
        if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(token)) invalid('GitHub credentials must be nonempty printable tokens without whitespace.');
        const response = await transport(url, {
          method, redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'plumber-local-runner',
            ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(encoded === undefined ? {} : { body: encoded }),
        });
        const discard = (): void => { void response.body?.cancel().catch(() => {}); };
        if (response.redirected || (response.url && new URL(response.url).origin !== 'https://api.github.com')) {
          discard(); failed('GitHub transport returned an unexpected destination.');
        }
        if (response.status === 404 && allowMissing && method === 'GET') { discard(); return null; }
        if (!response.ok) {
          discard();
          if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
            failed('GitHub rate limit reached; pause and reconcile any uncertain write before retrying.');
          }
          failed(`GitHub request failed with HTTP ${response.status}; no automatic retry was attempted.`);
        }
        if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json') || !response.body) {
          discard(); failed('GitHub response must contain JSON.');
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 2 * 1024 * 1024)) {
          discard(); failed('GitHub response exceeds the 2 MiB byte budget.');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            if (controller.signal.aborted) failed('GitHub response deadline expired.');
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > 2 * 1024 * 1024) failed('GitHub response exceeds the 2 MiB byte budget.');
            chunks.push(value);
          }
          try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown; }
          catch { failed('GitHub response is not valid UTF-8 JSON.'); }
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      };
      try { return await Promise.race([work(), deadline]); }
      catch (error) {
        if (error instanceof PlumberError && safeErrors.has(error)) throw error;
        failed('GitHub transport failed; a write may have completed remotely.');
      } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
    },
  });
}
