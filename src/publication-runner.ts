import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isProxy } from 'node:util/types';
import { consumeApproval, inspectApproval, issueApproval } from './approval-store.js';
import type { ApprovalOrigin, ApprovalReceipt } from './approval-store.js';
import { captureConsumer, isCapturedConsumerPath } from './consumer-files.js';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';
import type { PublicationCandidate } from './publication-plan.js';

export interface GitPublicationSnapshot {
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly private: true;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly treeSha: string;
}

export interface PublicationCommitIdentity { readonly name: string; readonly email: string }

export interface PublishedPullRequest {
  readonly repositoryId: string;
  readonly headRepositoryId: string;
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly draft: boolean;
  readonly headSha: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
}

export interface GitPublicationAdapterIdentity {
  readonly id: string;
  readonly host: 'github.com';
  readonly mode: 'simulation' | 'live';
}

/** Trusted caller implementation. Writes must be create-only and must not retry uncertain requests. */
export interface GitPublicationAdapter extends GitPublicationAdapterIdentity {
  readonly readSnapshot: (destination: PublicationCandidate['destination']) => Promise<GitPublicationSnapshot>;
  readonly createCommit: (input: {
    readonly snapshot: GitPublicationSnapshot;
    readonly parentSha: string;
    readonly baseTreeSha: string;
    readonly files: readonly { readonly path: string; readonly mode: '100644' | '100755'; readonly content: string; readonly beforeBlobId: string }[];
    readonly author: PublicationCommitIdentity;
    readonly timestamp: string;
    readonly message: string;
    readonly requestId: string;
    readonly expiresAt: string;
  }) => Promise<{ readonly commitSha: string; readonly treeSha: string }>;
  readonly createBranch: (input: {
    readonly snapshot: GitPublicationSnapshot; readonly branch: string; readonly commitSha: string; readonly requestId: string; readonly expiresAt: string;
  }) => Promise<void>;
  readonly createDraftPullRequest: (input: {
    readonly snapshot: GitPublicationSnapshot; readonly baseBranch: string; readonly headBranch: string;
    readonly commitSha: string; readonly title: string; readonly body: string; readonly requestId: string; readonly expiresAt: string;
  }) => Promise<PublishedPullRequest>;
  readonly readBranch: (input: { readonly snapshot: GitPublicationSnapshot; readonly branch: string }) => Promise<{ readonly commitSha: string } | null>;
  /** Include open, closed and merged pull requests; truncation must reject rather than imply absence. */
  readonly findPullRequests: (input: {
    readonly snapshot: GitPublicationSnapshot; readonly baseBranch: string; readonly headBranch: string;
  }) => Promise<readonly PublishedPullRequest[]>;
}

export interface PublicationRequest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly action: 'publish-draft-pr';
  readonly candidate: PublicationCandidate;
  readonly adapter: GitPublicationAdapterIdentity;
  readonly snapshot: GitPublicationSnapshot;
  readonly commit: { readonly author: PublicationCommitIdentity; readonly timestamp: string; readonly message: string };
  readonly pullRequest: { readonly title: string; readonly body: string; readonly draft: true };
  readonly authorization: 'not-granted';
  readonly consumerModified: false;
}

export interface PublicationApproval {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly action: 'publish-draft-pr';
  readonly requestId: string;
  readonly expiresAt: string;
}

export interface PublicationResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly receiptId: string;
  readonly mode: 'simulation' | 'live';
  readonly status: 'published' | 'uncertain' | 'conflict';
  readonly reason: string;
  readonly commitSha?: string;
  readonly pullRequest?: PublishedPullRequest;
  readonly consumerModified: false;
}

interface PublicationLocation { readonly statePath: string; readonly consumerRoot: string }
interface PublicationOperation extends PublicationLocation {
  readonly request: PublicationRequest;
  readonly receiptId: string;
  readonly adapter: GitPublicationAdapter;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_BYTES = 16 * 1024 * 1024;
const METHODS = ['readSnapshot', 'createCommit', 'createBranch', 'createDraftPullRequest', 'readBranch', 'findPullRequests'] as const;
const CANDIDATE_KEYS = ['schemaVersion', 'status', 'authorization', 'publication', 'validation', 'evidence', 'git', 'destination', 'files', 'pullRequest', 'consumerModified', 'id', 'headBranch'];

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Publication inputs must be plain data records.');
  const own = Reflect.ownKeys(value);
  const keys = [...required, ...optional];
  if (required.some(key => !Object.hasOwn(value, key))
    || own.some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    invalid('Publication data contains missing, unknown or executable fields.');
  }
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid('Publication lists must be bounded arrays.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid('Publication lists must contain dense data entries.');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Publication lists cannot contain accessors.');
    return descriptor.value;
  });
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) invalid('Publication text exceeds its supported byte limit.');
  return value;
}
function hash(value: unknown, pattern = SHA256): string {
  const result = text(value, 64);
  if (!pattern.test(result)) invalid('Publication evidence contains an invalid hash.');
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function branch(value: unknown): string {
  const result = text(value, 200);
  if (!/^[a-z0-9][a-z0-9._/-]*$/iu.test(result) || result === 'HEAD' || result.startsWith('refs/') || result.includes('..')
    || result.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) invalid('Publication branches must be unambiguous short refs.');
  return result;
}
function target(value: unknown): PublicationCandidate['destination'] {
  const data = record(value, ['host', 'owner', 'name', 'baseBranch', 'verified']);
  const owner = text(data.owner, 39);
  const name = text(data.name, 100);
  if (data.host !== 'github.com' || data.verified !== false || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu.test(owner)
    || !/^[a-z0-9._-]+$/iu.test(name) || ['.', '..'].includes(name) || name.toLowerCase().endsWith('.git')) invalid('Publication requires an explicit GitHub repository destination.');
  return { host: 'github.com', owner, name, baseBranch: branch(data.baseBranch), verified: false };
}
function candidate(value: unknown): PublicationCandidate {
  const data = record(value, CANDIDATE_KEYS);
  const validation = record(data.validation, ['intentId', 'requestId', 'receiptId', 'status']);
  const evidence = record(data.evidence, ['planId', 'executionDigest', 'policyDigest', 'outcomeDigest']);
  const git = record(data.git, ['canonicalRootId', 'headSha', 'treeSha', 'consumerDigest']);
  const pr = record(data.pullRequest, ['title', 'body', 'draft']);
  if (data.schemaVersion !== 1 || data.status !== 'requires-remote-verification' || data.authorization !== 'not-granted'
    || data.publication !== 'not-started' || data.consumerModified !== false || pr.draft !== true
    || !['passed', 'improved'].includes(validation.status as string)
    || typeof validation.receiptId !== 'string' || !UUID.test(validation.receiptId)) invalid('Publication requires a validated, unapproved local candidate.');
  const paths = new Set<string>();
  let bytes = 0;
  const files = list(data.files, 50).map((value): PublicationCandidate['files'][number] => {
    const file = record(value, ['path', 'beforeSha256', 'afterSha256', 'before', 'after', 'mode', 'gitBlobId']);
    const path = text(file.path, 1024);
    if (!isCapturedConsumerPath(path) || !/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/iu.test(path)
      || /[:\u0000-\u001f\u007f]/u.test(path) || paths.has(path.toLowerCase())) invalid('Publication file paths must be unique captured source paths.');
    paths.add(path.toLowerCase());
    const before = text(file.before, 2 * 1024 * 1024);
    const after = text(file.after, 2 * 1024 * 1024);
    bytes += Buffer.byteLength(before) + Buffer.byteLength(after);
    if (bytes > MAX_BYTES) invalid('Publication source evidence exceeds the 16 MiB limit.');
    const beforeSha256 = hash(file.beforeSha256);
    const afterSha256 = hash(file.afterSha256);
    const gitBlobId = hash(file.gitBlobId, SHA1);
    const blob = createHash('sha1').update(`blob ${Buffer.byteLength(before)}\0`).update(before).digest('hex');
    if (beforeSha256 !== digest(before) || afterSha256 !== digest(after) || before === after || gitBlobId !== blob
      || (file.mode !== '100644' && file.mode !== '100755')) invalid('Publication files do not match their validated content or Git blobs.');
    return { path, beforeSha256, afterSha256, before, after, mode: file.mode, gitBlobId };
  });
  if (!files.length) invalid('Publication requires at least one validated edit.');
  const title = text(pr.title, 256);
  if (!title.trim() || /[\r\n\u0000]/u.test(title)) invalid('Publication requires a one-line pull request title.');
  const content: Omit<PublicationCandidate, 'id' | 'headBranch'> = {
    schemaVersion: 1, status: 'requires-remote-verification', authorization: 'not-granted', publication: 'not-started',
    validation: { intentId: hash(validation.intentId), requestId: hash(validation.requestId), receiptId: validation.receiptId, status: validation.status as 'passed' | 'improved' },
    evidence: { planId: hash(evidence.planId), executionDigest: hash(evidence.executionDigest), policyDigest: hash(evidence.policyDigest), outcomeDigest: hash(evidence.outcomeDigest) },
    git: { canonicalRootId: hash(git.canonicalRootId), headSha: hash(git.headSha, SHA1), treeSha: hash(git.treeSha, SHA1), consumerDigest: hash(git.consumerDigest) },
    destination: target(data.destination), files, pullRequest: { title, body: text(pr.body, 128 * 1024), draft: true }, consumerModified: false,
  };
  const id = digest(JSON.stringify(content));
  if (data.id !== id || data.headBranch !== `feat/api-${id.slice(0, 12)}` || data.headBranch === content.destination.baseBranch) invalid('Publication candidate content changed after preparation.');
  return { ...content, id, headBranch: data.headBranch };
}
function identity(value: unknown): GitPublicationAdapterIdentity {
  const input = record(value, ['id', 'host', 'mode']);
  const id = text(input.id, 128);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(id) || input.host !== 'github.com' || !['simulation', 'live'].includes(input.mode as string)) invalid('Publication adapter identity is invalid.');
  return { id, host: 'github.com', mode: input.mode as 'simulation' | 'live' };
}
function adapter(value: unknown): GitPublicationAdapter {
  const input = record(value, ['id', 'host', 'mode', ...METHODS]);
  const id = identity({ id: input.id, host: input.host, mode: input.mode });
  if (METHODS.some(method => typeof input[method] !== 'function')) invalid('Publication adapters require all typed operations.');
  return { ...id, ...Object.fromEntries(METHODS.map(method => [method, input[method]])) } as GitPublicationAdapter;
}
function snapshot(value: unknown, destination: PublicationCandidate['destination']): GitPublicationSnapshot {
  const input = record(value, ['repositoryId', 'owner', 'name', 'private', 'baseBranch', 'headSha', 'treeSha']);
  const repositoryId = text(input.repositoryId, 128);
  if (!/^[a-z0-9_-]{1,128}$/iu.test(repositoryId) || input.private !== true
    || typeof input.owner !== 'string' || input.owner.toLowerCase() !== destination.owner.toLowerCase()
    || typeof input.name !== 'string' || input.name.toLowerCase() !== destination.name.toLowerCase()
    || input.baseBranch !== destination.baseBranch) invalid('The remote repository identity, visibility or branch does not match the private destination.');
  return { repositoryId, owner: input.owner, name: input.name, private: true, baseBranch: destination.baseBranch,
    headSha: hash(input.headSha, SHA1), treeSha: hash(input.treeSha, SHA1) };
}
function commit(value: unknown): PublicationRequest['commit'] {
  const input = record(value, ['author', 'timestamp', 'message']);
  const person = record(input.author, ['name', 'email']);
  const name = text(person.name, 200);
  const email = text(person.email, 254);
  const timestamp = text(input.timestamp, 32);
  const message = text(input.message, 4096);
  if (!name.trim() || /[<>\r\n\u0000-\u001f\u007f]/u.test(name) || !/^[^<>\s@]+@[^<>\s@]+$/u.test(email)
    || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp || !message.trim()) invalid('Publication commit identity, timestamp or message is invalid.');
  return { author: { name, email }, timestamp, message };
}
function request(value: unknown): PublicationRequest {
  const data = record(value, ['schemaVersion', 'id', 'action', 'candidate', 'adapter', 'snapshot', 'commit', 'pullRequest', 'authorization', 'consumerModified']);
  if (data.schemaVersion !== 1 || data.action !== 'publish-draft-pr' || data.authorization !== 'not-granted' || data.consumerModified !== false) invalid('A dedicated draft publication request is required.');
  const local = candidate(data.candidate);
  const remote = snapshot(data.snapshot, local.destination);
  if (remote.headSha !== local.git.headSha || remote.treeSha !== local.git.treeSha) invalid('The verified remote base does not equal the locally validated Git revision.');
  const pr = record(data.pullRequest, ['title', 'body', 'draft']);
  if (pr.draft !== true || pr.title !== local.pullRequest.title || typeof pr.body !== 'string' || !pr.body.endsWith(`<!-- plumber-candidate:${local.id} -->`)) invalid('The publication must retain its reviewed draft pull request.');
  const content: Omit<PublicationRequest, 'id'> = {
    schemaVersion: 1, action: 'publish-draft-pr', candidate: local, adapter: identity(data.adapter), snapshot: remote,
    commit: commit(data.commit), pullRequest: { title: local.pullRequest.title, body: text(pr.body, 132 * 1024), draft: true }, authorization: 'not-granted', consumerModified: false,
  };
  const id = digest(`plumber-publication-request-v1\0${canonical(content)}`);
  if (data.id !== id) invalid('Publication request content changed after preparation.');
  return freeze({ ...content, id });
}

/** Restores a bounded publication request from local data without credentials, remote reads or approval. */
export function validatePublicationRequest(value: unknown): PublicationRequest {
  return request(value);
}

/** Performs only destination reads through the configured adapter. It does not authorize publication. */
export async function preparePublicationRequest(options: {
  readonly candidate: PublicationCandidate; readonly adapter: GitPublicationAdapter;
  readonly author: PublicationCommitIdentity; readonly timestamp?: string;
}): Promise<PublicationRequest> {
  const input = record(options, ['candidate', 'adapter', 'author'], ['timestamp']);
  const local = candidate(input.candidate);
  const provider = adapter(input.adapter);
  const proposedCommit = commit({ author: input.author, timestamp: input.timestamp ?? new Date().toISOString(), message: `Update API integration\n\nPlumber candidate: ${local.id}` });
  let remote: GitPublicationSnapshot;
  try { remote = snapshot(await provider.readSnapshot(local.destination), local.destination); }
  catch { invalid('Could not verify the private publication destination.'); }
  if (remote.headSha !== local.git.headSha || remote.treeSha !== local.git.treeSha) invalid('Remote base changed or differs from the validated local Git revision; prepare fresh evidence.');
  const content: Omit<PublicationRequest, 'id'> = {
    schemaVersion: 1, action: 'publish-draft-pr', candidate: local,
    adapter: { id: provider.id, host: provider.host, mode: provider.mode }, snapshot: remote,
    commit: proposedCommit,
    pullRequest: { title: local.pullRequest.title, body: `${local.pullRequest.body}\n\n<!-- plumber-candidate:${local.id} -->`, draft: true },
    authorization: 'not-granted', consumerModified: false,
  };
  return request({ ...content, id: digest(`plumber-publication-request-v1\0${canonical(content)}`) });
}

function binding(value: PublicationRequest, location: PublicationLocation) {
  return { ...location, planId: digest(`publication-plan-v1\0${value.id}`),
    executionDigest: digest(`publication-execution-v1\0${value.id}`),
    policyDigest: digest(`publication-policy-v1\0${canonical({ adapter: value.adapter, snapshot: value.snapshot, action: value.action })}`) };
}
function pathId(path: string): string { return digest(process.platform === 'win32' ? path.toLowerCase() : path); }
async function directory(value: string): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value === '-' || /^[\\/]{2}/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) invalid('Publication state requires a regular local directory.');
  const withoutDrive = process.platform === 'win32' && /^[a-z]:[\\/]/iu.test(value) ? value.slice(2) : value;
  if (withoutDrive.includes(':') || /(?:^|[\\/])(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/iu.test(value)
    || (process.platform === 'win32' && withoutDrive.split(/[\\/]/u).some(part => part !== '.' && part !== '..' && /[. ]$/u.test(part)))) invalid('Publication state cannot use network, device or ambiguous paths.');
  const path = resolve(value);
  const root = parse(path).root;
  let current = root;
  for (const part of ['', ...path.slice(root.length).split(sep).filter(Boolean)]) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid('Publication directories cannot contain symbolic links or junctions.');
  }
  return realpath(path);
}
async function consumer(value: PublicationRequest, root: string): Promise<string> {
  const absolute = await directory(root);
  if (pathId(absolute) !== value.candidate.git.canonicalRootId) invalid('Publication approval belongs to a different consumer root.');
  return absolute;
}
async function currentConsumer(value: PublicationRequest, root: string): Promise<string> {
  const absolute = await consumer(value, root);
  if ((await captureConsumer(absolute)).digest !== value.candidate.git.consumerDigest) invalid('Consumer source changed after validation; prepare and validate current evidence again.');
  return absolute;
}
async function write(path: string, data: unknown): Promise<void> {
  await directory(dirname(path));
  const json = `${JSON.stringify(data)}\n`;
  if (Buffer.byteLength(json) > 256 * 1024) invalid('Publication journal entry exceeds its bounded size.');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(json, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}
async function optional(path: string): Promise<unknown | undefined> {
  try { await lstat(path); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  return loadLocalJson(path, 256 * 1024);
}

export async function approvePublicationRequest(options: PublicationLocation & {
  readonly request: PublicationRequest; readonly expectedRequestId: string; readonly origin: ApprovalOrigin;
}): Promise<PublicationApproval> {
  record(options, ['request', 'expectedRequestId', 'statePath', 'consumerRoot', 'origin']);
  const value = request(options.request);
  if (options.expectedRequestId !== value.id) invalid('Confirm the exact inspected publication request before approving it.');
  const consumerRoot = await currentConsumer(value, options.consumerRoot);
  const receipt = await issueApproval({ ...binding(value, { statePath: options.statePath, consumerRoot }), origin: options.origin });
  return { schemaVersion: 1, id: receipt.id, action: 'publish-draft-pr', requestId: value.id, expiresAt: receipt.expiresAt };
}

function providerFor(value: PublicationRequest, input: GitPublicationAdapter): GitPublicationAdapter {
  const provider = adapter(input);
  if (canonical(value.adapter) !== canonical({ id: provider.id, host: provider.host, mode: provider.mode })) invalid('Publication adapter differs from the approved provider or simulation mode.');
  return provider;
}
async function currentSnapshot(value: PublicationRequest, provider: GitPublicationAdapter): Promise<void> {
  const now = snapshot(await provider.readSnapshot(value.candidate.destination), value.candidate.destination);
  if (canonical(now) !== canonical(value.snapshot)) invalid('Remote repository identity or base changed after approval.');
}
function commitResult(value: unknown): { commitSha: string; treeSha: string } {
  const data = record(value, ['commitSha', 'treeSha']);
  return { commitSha: hash(data.commitSha, SHA1), treeSha: hash(data.treeSha, SHA1) };
}
function remoteBranch(value: unknown): { commitSha: string } | null {
  if (value === null) return null;
  const data = record(value, ['commitSha']);
  return { commitSha: hash(data.commitSha, SHA1) };
}
function pullRequest(value: unknown, request: PublicationRequest): PublishedPullRequest {
  const data = record(value, ['repositoryId', 'headRepositoryId', 'number', 'url', 'state', 'draft', 'headSha', 'headBranch', 'baseBranch', 'title', 'body']);
  const repository = request.snapshot;
  if (data.repositoryId !== repository.repositoryId || data.headRepositoryId !== repository.repositoryId
    || !Number.isSafeInteger(data.number) || (data.number as number) < 1 || !['open', 'closed', 'merged'].includes(data.state as string)
    || typeof data.draft !== 'boolean' || data.headBranch !== request.candidate.headBranch || data.baseBranch !== repository.baseBranch) invalid('The observed pull request does not belong to the approved repository and refs.');
  const url = text(data.url, 2048);
  const expected = `https://github.com/${repository.owner}/${repository.name}/pull/${data.number}`;
  if (url.toLowerCase() !== expected.toLowerCase()) invalid('The observed pull request URL is outside the approved destination.');
  return { repositoryId: repository.repositoryId, headRepositoryId: repository.repositoryId, number: data.number as number,
    url, state: data.state as PublishedPullRequest['state'], draft: data.draft, headSha: hash(data.headSha, SHA1),
    headBranch: request.candidate.headBranch, baseBranch: repository.baseBranch, title: text(data.title, 256), body: text(data.body, 132 * 1024) };
}
async function existing(value: PublicationRequest, provider: GitPublicationAdapter): Promise<PublishedPullRequest[]> {
  return list(await provider.findPullRequests({ snapshot: value.snapshot, baseBranch: value.snapshot.baseBranch, headBranch: value.candidate.headBranch }), 100)
    .map(item => pullRequest(item, value));
}
function result(value: PublicationRequest, receiptId: string, status: PublicationResult['status'], reason: string,
  extra: Pick<PublicationResult, 'commitSha' | 'pullRequest'> = {}): PublicationResult {
  return { schemaVersion: 1, requestId: value.id, receiptId, mode: value.adapter.mode, status, reason, ...extra, consumerModified: false };
}
function matches(pr: PublishedPullRequest, value: PublicationRequest, commitSha: string): boolean {
  return pr.headSha === commitSha && pr.title === value.pullRequest.title && pr.body === value.pullRequest.body;
}
async function outcome(path: string, value: PublicationResult): Promise<PublicationResult> {
  await write(join(path, 'result.json'), value);
  return value;
}

/** Consumes dedicated publication approval before any remote mutation; this operation never retries writes. */
export async function publishPublication(options: PublicationOperation): Promise<PublicationResult> {
  record(options, ['request', 'receiptId', 'statePath', 'consumerRoot', 'adapter']);
  const value = request(options.request);
  const provider = providerFor(value, options.adapter);
  const consumerRoot = await currentConsumer(value, options.consumerRoot);
  const bound = { ...binding(value, { statePath: options.statePath, consumerRoot }), receiptId: options.receiptId };
  await inspectApproval(bound);
  // Reads are deliberately before consumption. A stale destination is not a remote write attempt.
  try { await currentSnapshot(value, provider); }
  catch { invalid('Publication destination changed or could not be verified; no remote write was attempted.'); }
  const { attemptPath, receipt } = await consumeApproval(bound);
  const unexpired = (): void => { if (Date.parse(receipt.expiresAt) <= Date.now()) invalid('Publication approval expired before this write phase.'); };
  await write(join(attemptPath, 'publication.json'), { schemaVersion: 1, requestId: value.id, candidateId: value.candidate.id,
    repositoryId: value.snapshot.repositoryId, adapter: value.adapter, headBranch: value.candidate.headBranch });
  let commitSha: string | undefined;
  try {
    const branch = remoteBranch(await provider.readBranch({ snapshot: value.snapshot, branch: value.candidate.headBranch }));
    if (branch || (await existing(value, provider)).length) {
      return await outcome(attemptPath, result(value, options.receiptId, 'conflict', 'The destination branch or a pull request already exists; no overwrite or new pull request was attempted.'));
    }
    await currentConsumer(value, consumerRoot);
    unexpired();
    await write(join(attemptPath, '01-commit-intent.json'), { requestId: value.id, action: 'create-immutable-commit' });
    unexpired();
    const created = commitResult(await provider.createCommit({ snapshot: value.snapshot, parentSha: value.snapshot.headSha,
      baseTreeSha: value.snapshot.treeSha, files: value.candidate.files.map(file => ({ path: file.path, mode: file.mode, content: file.after, beforeBlobId: file.gitBlobId })),
      ...value.commit, requestId: value.id, expiresAt: receipt.expiresAt }));
    commitSha = created.commitSha;
    if (created.commitSha === value.snapshot.headSha || created.treeSha === value.snapshot.treeSha) invalid('The created commit did not contain a changed source tree.');
    await write(join(attemptPath, '02-commit.json'), { requestId: value.id, ...created });
    await currentSnapshot(value, provider);
    await currentConsumer(value, consumerRoot);
    unexpired();
    await write(join(attemptPath, '03-branch-intent.json'), { requestId: value.id, action: 'create-only-branch', branch: value.candidate.headBranch, commitSha });
    unexpired();
    await provider.createBranch({ snapshot: value.snapshot, branch: value.candidate.headBranch, commitSha, requestId: value.id, expiresAt: receipt.expiresAt });
    const actual = remoteBranch(await provider.readBranch({ snapshot: value.snapshot, branch: value.candidate.headBranch }));
    if (actual?.commitSha !== commitSha) invalid('The remote publication branch does not equal the created commit.');
    await write(join(attemptPath, '04-branch.json'), { requestId: value.id, commitSha });
    await currentSnapshot(value, provider);
    await currentConsumer(value, consumerRoot);
    if ((await existing(value, provider)).length) invalid('A pull request appeared concurrently; reconcile its identity before any further action.');
    unexpired();
    await write(join(attemptPath, '05-pr-intent.json'), { requestId: value.id, action: 'create-draft-pull-request', commitSha });
    unexpired();
    const pr = pullRequest(await provider.createDraftPullRequest({ snapshot: value.snapshot, baseBranch: value.snapshot.baseBranch,
      headBranch: value.candidate.headBranch, commitSha, title: value.pullRequest.title, body: value.pullRequest.body, requestId: value.id, expiresAt: receipt.expiresAt }), value);
    if (!pr.draft || pr.state !== 'open' || !matches(pr, value, commitSha)) invalid('The created pull request does not match the approved draft and commit.');
    const after = remoteBranch(await provider.readBranch({ snapshot: value.snapshot, branch: value.candidate.headBranch }));
    if (after?.commitSha !== commitSha) invalid('The publication branch changed while opening the pull request.');
    return await outcome(attemptPath, result(value, options.receiptId, 'published', 'The adapter confirmed the approved draft pull request and exact commit.', { commitSha, pullRequest: pr }));
  } catch {
    // Transport errors can contain credentials or response bodies. Preserve typed uncertainty, never replay.
    const pending = result(value, options.receiptId, 'uncertain', 'Publication did not finish with verified evidence. Reconcile this attempt before any further publication.',
      commitSha === undefined ? {} : { commitSha });
    try { return await outcome(attemptPath, pending); } catch { return pending; }
  }
}

async function attempt(value: PublicationRequest, options: PublicationOperation): Promise<string> {
  if (!UUID.test(options.receiptId)) invalid('A canonical publication receipt identifier is required.');
  const consumerRoot = await consumer(value, options.consumerRoot);
  const state = await directory(options.statePath);
  const within = (parent: string, child: string): boolean => { const part = relative(parent, child); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
  if (within(state, consumerRoot) || within(consumerRoot, state)) invalid('Publication state must be separate from the consumer root.');
  const bound = binding(value, { statePath: state, consumerRoot });
  const receipt = record(await loadLocalJson(join(state, 'receipts', `${options.receiptId}.json`), 4096),
    ['schemaVersion', 'id', 'stateRootId', 'consumerRootId', 'planId', 'executionDigest', 'policyDigest', 'origin', 'issuedAt', 'expiresAt']) as unknown as ApprovalReceipt;
  if (receipt.schemaVersion !== 1 || receipt.id !== options.receiptId || receipt.stateRootId !== pathId(state)
    || receipt.consumerRootId !== pathId(consumerRoot) || receipt.planId !== bound.planId
    || receipt.executionDigest !== bound.executionDigest || receipt.policyDigest !== bound.policyDigest) invalid('Publication receipt does not match this request and local storage.');
  // Reconciliation is read-only and remains available after publication consent expires.
  const path = await directory(join(state, 'attempts', options.receiptId));
  const marker = record(await loadLocalJson(join(path, 'marker.json'), 4096), ['schemaVersion', 'receiptId', 'planId', 'executionDigest', 'consumedAt']);
  if (marker.schemaVersion !== 1 || marker.receiptId !== options.receiptId || marker.planId !== bound.planId || marker.executionDigest !== bound.executionDigest) invalid('The publication attempt marker has different bindings.');
  const stored = record(await loadLocalJson(join(path, 'publication.json'), 4096), ['schemaVersion', 'requestId', 'candidateId', 'repositoryId', 'adapter', 'headBranch']);
  if (stored.schemaVersion !== 1 || stored.requestId !== value.id || stored.candidateId !== value.candidate.id
    || stored.repositoryId !== value.snapshot.repositoryId || canonical(identity(stored.adapter)) !== canonical(value.adapter)
    || stored.headBranch !== value.candidate.headBranch) invalid('The publication journal belongs to different approved evidence.');
  return path;
}

/** Observes the original attempt only. It never recreates a branch or retries opening a pull request. */
export async function reconcilePublication(options: PublicationOperation): Promise<PublicationResult> {
  record(options, ['request', 'receiptId', 'statePath', 'consumerRoot', 'adapter']);
  const value = request(options.request);
  const provider = providerFor(value, options.adapter);
  const path = await attempt(value, options);
  const storedCommit = await optional(join(path, '02-commit.json'));
  if (storedCommit === undefined) return result(value, options.receiptId, 'uncertain', 'No durable commit identity was recorded. The original immutable-object write cannot be safely replayed.');
  const fields = record(storedCommit, ['requestId', 'commitSha', 'treeSha']);
  if (fields.requestId !== value.id) invalid('The recorded publication commit belongs to another request.');
  const known = commitResult({ commitSha: fields.commitSha, treeSha: fields.treeSha });
  try {
    // Base advancement after a PR was created is normal. Repository identity must still match.
    const now = snapshot(await provider.readSnapshot(value.candidate.destination), value.candidate.destination);
    if (now.repositoryId !== value.snapshot.repositoryId) return result(value, options.receiptId, 'conflict', 'The repository identity changed; no reconciliation write was attempted.', { commitSha: known.commitSha });
    const branch = remoteBranch(await provider.readBranch({ snapshot: now, branch: value.candidate.headBranch }));
    const prs = await existing(value, provider);
    if (branch && branch.commitSha !== known.commitSha) return result(value, options.receiptId, 'conflict', 'The publication branch contains different commits and will not be overwritten.', { commitSha: known.commitSha });
    const matching = prs.filter(pr => matches(pr, value, known.commitSha));
    if (matching.length === 1 && prs.length === 1 && (branch || matching[0]!.state !== 'open')) {
      const recovered = result(value, options.receiptId, 'published', 'The existing pull request matches the durable commit; its current state is preserved.', { commitSha: known.commitSha, pullRequest: matching[0]! });
      try { await write(join(path, 'reconciled.json'), recovered); }
      catch (error) {
        // Keep the first observation; subsequent reconciliation may see a later human-managed PR state.
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      }
      return recovered;
    }
    if (prs.length) return result(value, options.receiptId, 'conflict', 'Existing pull request evidence is ambiguous or differs from the approved content; no duplicate was created.', { commitSha: known.commitSha });
    return result(value, options.receiptId, 'uncertain', 'No matching pull request was observed. Delayed remote writes remain possible; this attempt is not automatically retried.', { commitSha: known.commitSha });
  } catch {
    return result(value, options.receiptId, 'uncertain', 'Remote evidence could not be fully verified; reconciliation made no remote changes.', { commitSha: known.commitSha });
  }
}
