import { createHash } from 'node:crypto';
import { createGitHubClient } from './github-client.js';
import type { GitHubClientOptions } from './github-client.js';
import { PlumberError } from './errors.js';
import type { GitPublicationAdapter, GitPublicationSnapshot, PublishedPullRequest } from './publication-runner.js';

export interface GitHubPublicationOptions extends GitHubClientOptions {
  /** Simulation labels the whole adapter; it must be paired with a controlled transport. */
  readonly mode?: 'live' | 'simulation';
}

function failed(message: string): never { throw new PlumberError('ENGINE_FAILED', message); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failed('GitHub returned an invalid object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 1024): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) failed('GitHub returned an invalid text field.');
  return value;
}
function sha(value: unknown): string {
  const result = text(value, 40);
  if (!/^[a-f0-9]{40}$/u.test(result)) failed('GitHub returned an unsupported object ID.');
  return result;
}
function id(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 1) failed('GitHub returned an invalid repository ID.');
  return String(value);
}
function repositoryPath(value: { readonly owner: string; readonly name: string }): string {
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/iu.test(value.owner) || !/^[a-z0-9._-]{1,100}$/iu.test(value.name)
    || ['.', '..'].includes(value.name)) throw new PlumberError('INVALID_INPUT', 'GitHub repository identity is invalid.');
  return `/repos/${value.owner}/${value.name}`;
}
function ref(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,199}$/iu.test(value) || value.includes('..') || value.startsWith('refs/')
    || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new PlumberError('INVALID_INPUT', 'GitHub branch reference is invalid.');
  }
  return encodeURIComponent(value);
}
function blobId(content: string): string { return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex'); }

/** Customer-to-GitHub transport. Construction does not resolve credentials or contact GitHub. */
export function createGitHubPublicationAdapter(options: GitHubPublicationOptions): GitPublicationAdapter {
  const mode = options.mode ?? 'live';
  if (!['live', 'simulation'].includes(mode) || (mode === 'simulation' && options.transport === undefined)) {
    throw new PlumberError('INVALID_INPUT', 'A simulated GitHub adapter requires an explicit controlled transport.');
  }
  const client = createGitHubClient(options);
  const readRepository = async (destination: { readonly owner: string; readonly name: string }): Promise<Record<string, unknown>> => {
    const result = object(await client.request('GET', repositoryPath(destination)));
    const owner = text(object(result.owner).login);
    if (result.private !== true || result.fork !== false || result.archived !== false || result.disabled !== false
      || object(result.permissions).push !== true || owner.toLowerCase() !== destination.owner.toLowerCase()
      || text(result.name).toLowerCase() !== destination.name.toLowerCase()) {
      failed('GitHub destination must be the selected private, writable, active, non-fork repository.');
    }
    id(result.id);
    return result;
  };
  const verifyIdentity = async (snapshot: GitPublicationSnapshot): Promise<void> => {
    if (id((await readRepository(snapshot)).id) !== snapshot.repositoryId) failed('GitHub repository identity changed.');
  };
  const readBranch = async (snapshot: Pick<GitPublicationSnapshot, 'owner' | 'name'>, branch: string): Promise<{ commitSha: string } | null> => {
    const value = await client.request('GET', `${repositoryPath(snapshot)}/git/ref/heads/${ref(branch)}`, undefined, true);
    if (value === null) return null;
    const result = object(value);
    const commit = object(result.object);
    if (result.ref !== `refs/heads/${branch}` || commit.type !== 'commit') failed('GitHub returned an unexpected branch reference.');
    return { commitSha: sha(commit.sha) };
  };
  const verifyBase = async (snapshot: GitPublicationSnapshot): Promise<void> => {
    await verifyIdentity(snapshot);
    const branch = await readBranch(snapshot, snapshot.baseBranch);
    if (branch?.commitSha !== snapshot.headSha) failed('GitHub base changed after review; prepare and validate fresh evidence.');
  };
  const authorized = (expiresAt: string): void => {
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.now() >= Date.parse(expiresAt)) {
      failed('GitHub publication authorization expired; no new write was started.');
    }
  };
  const pullRequest = (value: unknown, snapshot: GitPublicationSnapshot): PublishedPullRequest => {
    const result = object(value);
    const base = object(result.base);
    const head = object(result.head);
    const repositoryId = id(object(base.repo).id);
    const headRepositoryId = id(object(head.repo).id);
    if (repositoryId !== snapshot.repositoryId || headRepositoryId !== snapshot.repositoryId || !Number.isSafeInteger(result.number)
      || (result.number as number) < 1 || typeof result.draft !== 'boolean' || !['open', 'closed'].includes(result.state as string)) {
      failed('GitHub pull request identity or state does not match the destination.');
    }
    const number = result.number as number;
    const url = text(result.html_url, 2048);
    if (url !== `https://github.com/${snapshot.owner}/${snapshot.name}/pull/${number}`) failed('GitHub returned an unexpected pull request URL.');
    if (result.merged_at !== null && (typeof result.merged_at !== 'string' || !Number.isFinite(Date.parse(result.merged_at)))) {
      failed('GitHub returned an invalid merge status.');
    }
    if (result.merged_at !== null && result.state !== 'closed') failed('GitHub returned inconsistent pull request state.');
    return { repositoryId, headRepositoryId, number, url, state: result.merged_at !== null ? 'merged' : result.state as 'open' | 'closed',
      draft: result.draft, headSha: sha(head.sha), headBranch: text(head.ref, 200), baseBranch: text(base.ref, 200),
      title: text(result.title, 256), body: result.body === null ? '' : text(result.body, 132 * 1024) };
  };
  return Object.freeze({
    id: 'github-rest-v1', host: 'github.com', mode,
    async readSnapshot(destination) {
      const repository = await readRepository(destination);
      const head = await readBranch(destination, destination.baseBranch);
      if (head === null) failed('The selected GitHub base branch does not exist.');
      const commit = object(await client.request('GET', `${repositoryPath(destination)}/git/commits/${head.commitSha}`));
      if (sha(commit.sha) !== head.commitSha) failed('GitHub returned a different base commit.');
      return { repositoryId: id(repository.id), owner: text(object(repository.owner).login), name: text(repository.name), private: true,
        baseBranch: destination.baseBranch, headSha: head.commitSha, treeSha: sha(object(commit.tree).sha) };
    },
    async createCommit(input) {
      await verifyBase(input.snapshot);
      if (input.parentSha !== input.snapshot.headSha || input.baseTreeSha !== input.snapshot.treeSha || input.files.length < 1 || input.files.length > 50) {
        failed('GitHub commit no longer matches the approved base or file scope.');
      }
      const base = repositoryPath(input.snapshot);
      const tree: { path: string; mode: '100644' | '100755'; type: 'blob'; sha: string }[] = [];
      const paths = new Set<string>();
      // Read the exact parent trees, never a truncated recursive result, before uploading any content.
      const cache = new Map<string, Record<string, unknown>[]>();
      const getTree = async (treeSha: string): Promise<Record<string, unknown>[]> => {
        const cached = cache.get(treeSha); if (cached) return cached;
        const response = object(await client.request('GET', `${base}/git/trees/${treeSha}`));
        if (sha(response.sha) !== treeSha || response.truncated !== false || !Array.isArray(response.tree) || response.tree.length > 10_000) failed('GitHub base tree is incomplete or invalid.');
        const entries = response.tree.map(object); cache.set(treeSha, entries); return entries;
      };
      for (const file of input.files) {
        if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes(':') || paths.has(file.path.toLowerCase())
          || file.path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
          || !['100644', '100755'].includes(file.mode) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 2 * 1024 * 1024) {
          failed('GitHub commit contains an unsupported file.');
        }
        paths.add(file.path.toLowerCase());
        const segments = file.path.split('/');
        if (segments.length > 21) failed('GitHub file nesting exceeds the inspection budget.');
        let treeSha = input.baseTreeSha;
        for (let index = 0; index < segments.length; index++) {
          const matches = (await getTree(treeSha)).filter(entry => entry.path === segments[index]);
          if (matches.length !== 1) failed('GitHub base file is missing or ambiguous.');
          const entry = matches[0]!;
          if (index === segments.length - 1) {
            if (entry.type !== 'blob' || entry.mode !== file.mode || sha(entry.sha) !== file.beforeBlobId) failed('GitHub base blob changed after validation.');
          } else {
            if (entry.type !== 'tree' || entry.mode !== '040000') failed('GitHub path traversal encountered a non-directory.');
            treeSha = sha(entry.sha);
          }
        }
      }
      for (const file of input.files) {
        authorized(input.expiresAt);
        const blob = object(await client.request('POST', `${base}/git/blobs`, { content: Buffer.from(file.content).toString('base64'), encoding: 'base64' }, false, input.expiresAt));
        if (sha(blob.sha) !== blobId(file.content)) failed('GitHub uploaded blob does not match the approved content.');
        tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: sha(blob.sha) });
      }
      authorized(input.expiresAt);
      const createdTree = object(await client.request('POST', `${base}/git/trees`, { base_tree: input.baseTreeSha, tree }, false, input.expiresAt));
      const treeSha = sha(createdTree.sha);
      const identity = { ...input.author, date: input.timestamp };
      authorized(input.expiresAt);
      const commit = object(await client.request('POST', `${base}/git/commits`, { message: input.message, tree: treeSha,
        parents: [input.parentSha], author: identity, committer: identity }, false, input.expiresAt));
      if (sha(object(commit.tree).sha) !== treeSha || !Array.isArray(commit.parents) || commit.parents.length !== 1
        || sha(object(commit.parents[0]).sha) !== input.parentSha) failed('GitHub created commit has unexpected ancestry.');
      for (const role of ['author', 'committer']) {
        const person = object(commit[role]);
        if (person.name !== input.author.name || person.email !== input.author.email || typeof person.date !== 'string'
          || Math.floor(Date.parse(person.date) / 1000) !== Math.floor(Date.parse(input.timestamp) / 1000)) {
          failed('GitHub created commit has unexpected identity or timestamp.');
        }
      }
      if (commit.message !== input.message) failed('GitHub created commit has an unexpected message.');
      return { commitSha: sha(commit.sha), treeSha };
    },
    async createBranch(input) {
      await verifyBase(input.snapshot);
      if (!/^feat\/api-[a-f0-9]{12}$/u.test(input.branch) || input.branch === input.snapshot.baseBranch) failed('GitHub publication branch is outside the supported scope.');
      authorized(input.expiresAt);
      const response = object(await client.request('POST', `${repositoryPath(input.snapshot)}/git/refs`, { ref: `refs/heads/${input.branch}`, sha: sha(input.commitSha) }, false, input.expiresAt));
      if (response.ref !== `refs/heads/${input.branch}` || object(response.object).type !== 'commit' || sha(object(response.object).sha) !== input.commitSha) {
        failed('GitHub branch response differs from the reviewed commit.');
      }
    },
    async createDraftPullRequest(input) {
      await verifyBase(input.snapshot);
      if (input.baseBranch !== input.snapshot.baseBranch) failed('GitHub pull request targets a different base.');
      if ((await readBranch(input.snapshot, input.headBranch))?.commitSha !== input.commitSha) {
        failed('GitHub publication branch changed before draft creation; preserve the branch and review the conflict.');
      }
      authorized(input.expiresAt);
      const response = await client.request('POST', `${repositoryPath(input.snapshot)}/pulls`, {
        title: input.title, body: input.body, head: input.headBranch, base: input.baseBranch, draft: true, maintainer_can_modify: false,
      }, false, input.expiresAt);
      const pr = pullRequest(response, input.snapshot);
      if (!pr.draft || pr.state !== 'open' || pr.headBranch !== input.headBranch || pr.baseBranch !== input.baseBranch
        || pr.title !== input.title || pr.body !== input.body) failed('GitHub draft pull request differs from the approved request.');
      return pr;
    },
    async readBranch(input) { await verifyIdentity(input.snapshot); return readBranch(input.snapshot, input.branch); },
    async findPullRequests(input) {
      await verifyIdentity(input.snapshot);
      const found: PublishedPullRequest[] = [];
      const seen = new Set<number>();
      for (let page = 1; page <= 10; page++) {
        const query = new URLSearchParams({ state: 'all', head: `${input.snapshot.owner}:${input.headBranch}`, base: input.baseBranch, per_page: '100', page: String(page) });
        const response = await client.request('GET', `${repositoryPath(input.snapshot)}/pulls?${query}`);
        if (!Array.isArray(response) || response.length > 100) failed('GitHub pull request page is invalid.');
        for (const item of response) {
          const pr = pullRequest(item, input.snapshot);
          if (pr.headBranch !== input.headBranch || pr.baseBranch !== input.baseBranch || seen.has(pr.number)) failed('GitHub pull request listing is inconsistent.');
          seen.add(pr.number); found.push(pr);
        }
        if (response.length < 100) return found;
      }
      failed('GitHub pull request listing exceeds the pagination budget; absence cannot be established.');
    },
  } satisfies GitPublicationAdapter);
}
