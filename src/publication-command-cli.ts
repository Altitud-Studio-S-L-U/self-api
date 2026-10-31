import { parseArgs } from 'node:util';
import { confirmLocalRequest, escapeTerminal, jsonLine } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { createGitHubPublicationAdapter } from './github-publication.js';
import { loadLocalJson } from './local-file.js';
import type { PublicationCandidate } from './publication-plan.js';
import { approvePublicationRequest, preparePublicationRequest, publishPublication, reconcilePublication, validatePublicationRequest } from './publication-runner.js';
import type { GitPublicationAdapter, PublicationRequest, PublicationResult } from './publication-runner.js';

export interface PublicationCommandCliOptions {
  /** Trusted adapter factory, primarily for controlled local integration tests. */
  readonly adapter?: () => GitPublicationAdapter;
  readonly prepare?: typeof preparePublicationRequest;
  readonly approve?: typeof approvePublicationRequest;
  readonly publish?: typeof publishPublication;
  readonly reconcile?: typeof reconcilePublication;
  readonly confirm?: (requestId: string) => Promise<boolean>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const commands = new Map([
  ['publication-review', new Set(['candidate', 'author-name', 'author-email', 'github', 'json'])],
  ['publication-approve', new Set(['request', 'state', 'consumer'])],
  ['publication-publish', new Set(['request', 'state', 'consumer', 'approval', 'github', 'json'])],
  ['publication-reconcile', new Set(['request', 'state', 'consumer', 'approval', 'github', 'json'])],
]);

function invalid(): never {
  throw new PlumberError('INVALID_INPUT', 'Invalid publication command arguments. Review, publish and reconcile require --github; approval requires interactive confirmation. Local JSON inputs are limited to 4 MiB.');
}

function github(): GitPublicationAdapter {
  return createGitHubPublicationAdapter({ getToken: () => {
    const token = process.env.GH_TOKEN;
    if (!token) throw new PlumberError('INVALID_INPUT', 'Set GH_TOKEN locally before an explicitly enabled GitHub operation. Credentials are never read from command arguments or stored in publication journals.');
    return token;
  } });
}

function renderRequest(value: PublicationRequest, includeSource: boolean): string {
  const lines = [
    `Publication request: ${escapeTerminal(value.id)}`,
    `Action: create a draft pull request. Mode: ${escapeTerminal(value.adapter.mode)}.`,
    `Destination: github.com/${escapeTerminal(value.snapshot.owner)}/${escapeTerminal(value.snapshot.name)} (private; repository ID ${escapeTerminal(value.snapshot.repositoryId)})`,
    `Base: ${escapeTerminal(value.snapshot.baseBranch)} @ ${escapeTerminal(value.snapshot.headSha)}`,
    `Base tree: ${escapeTerminal(value.snapshot.treeSha)}`,
    `New branch: ${escapeTerminal(value.candidate.headBranch)} (create-only)`,
    `Validation evidence: ${escapeTerminal(value.candidate.validation.status)}; request ${escapeTerminal(value.candidate.validation.requestId)}`,
    `Commit author: ${escapeTerminal(value.commit.author.name)} <${escapeTerminal(value.commit.author.email)}>`,
    `Commit date: ${escapeTerminal(value.commit.timestamp)}`,
    `Commit message: ${escapeTerminal(value.commit.message)}`,
    `Draft title: ${escapeTerminal(value.pullRequest.title)}`,
    'Selected modified source is sent directly to the selected GitHub repository when published.',
    'The reviewed base and consumer evidence are checked again before publication. Approval permits one attempt and expires after 15 minutes.',
    'Live consumer files remain unchanged. No force push, merge or deployment is authorized.',
  ];
  for (const file of value.candidate.files) {
    lines.push(`- ${escapeTerminal(file.path)}: ${escapeTerminal(file.beforeSha256)} -> ${escapeTerminal(file.afterSha256)}; mode ${escapeTerminal(file.mode)}`);
    if (includeSource) {
      lines.push('  Before:', ...file.before.split('\n').map(line => `- ${escapeTerminal(line)}`));
      lines.push('  After:', ...file.after.split('\n').map(line => `+ ${escapeTerminal(line)}`));
    }
  }
  if (includeSource) lines.push('Draft body:', ...value.pullRequest.body.split('\n').map(line => escapeTerminal(line)));
  else lines.push('Use --json to save the complete private request locally, including exact source changes.');
  lines.push('Publication is not authorized until its separate approval step.');
  return `${lines.join('\n')}\n`;
}

function renderResult(value: PublicationResult): string {
  const lines = [`Publication: ${escapeTerminal(value.status)}. Mode: ${escapeTerminal(value.mode)}.`,
    `Request: ${escapeTerminal(value.requestId)}`, `Approval: ${escapeTerminal(value.receiptId)}`, escapeTerminal(value.reason)];
  if (value.commitSha) lines.push(`Commit: ${escapeTerminal(value.commitSha)}`);
  if (value.pullRequest) lines.push(`Pull request: ${escapeTerminal(value.pullRequest.url)} (${escapeTerminal(value.pullRequest.state)}${value.pullRequest.draft ? ', draft' : ''})`);
  if (value.status === 'uncertain') lines.push('Reconcile this attempt before any further publication. No automatic retry was made.');
  lines.push('Live consumer unchanged. Adoption, merge and deployment are not established by publication.');
  return `${lines.join('\n')}\n`;
}

export async function runPublicationCommandCli(args: string[], options: PublicationCommandCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((value: string) => { process.stdout.write(value); });
  const stderr = options.stderr ?? ((value: string) => { process.stderr.write(value); });
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
        candidate: { type: 'string' }, request: { type: 'string' }, state: { type: 'string' }, consumer: { type: 'string' }, approval: { type: 'string' },
        'author-name': { type: 'string' }, 'author-email': { type: 'string' }, github: { type: 'boolean' }, json: { type: 'boolean' },
      } });
    } catch { invalid(); }
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) invalid();
      seen.add(token.name);
    }
    const [command] = parsed.positionals;
    const allowed = commands.get(command ?? '');
    if (!allowed || parsed.positionals.length !== 1 || Object.keys(parsed.values).some(key => !allowed.has(key))) invalid();
    if (command !== 'publication-approve' && parsed.values.github !== true) invalid();
    if (command === 'publication-review') {
      const path = parsed.values.candidate;
      const name = parsed.values['author-name'];
      const email = parsed.values['author-email'];
      if (!path?.trim() || !name?.trim() || !email?.trim()) invalid();
      const candidate = await loadLocalJson(path, MAX_FILE_BYTES) as PublicationCandidate;
      const prepared = await (options.prepare ?? preparePublicationRequest)({ candidate, adapter: (options.adapter ?? github)(), author: { name, email } });
      const request = validatePublicationRequest(prepared);
      stdout(parsed.values.json ? jsonLine(request) : renderRequest(request, false));
      return 0;
    }
    const { request: path, state: statePath, consumer: consumerRoot } = parsed.values;
    if (!path?.trim() || !statePath?.trim() || !consumerRoot?.trim()) invalid();
    const request = validatePublicationRequest(await loadLocalJson(path, MAX_FILE_BYTES));
    if (command === 'publication-approve') {
      stdout(renderRequest(request, true));
      if (!await (options.confirm ?? confirmLocalRequest)(request.id)) {
        stdout('Publication approval cancelled; no authorization was issued.\n');
        return 1;
      }
      const approval = await (options.approve ?? approvePublicationRequest)({ request, expectedRequestId: request.id, statePath, consumerRoot, origin: 'local-cli' });
      stdout(`Publication approval: ${escapeTerminal(approval.id)}\nExpires: ${escapeTerminal(approval.expiresAt)}\nPublishing remains a separate explicit command.\n`);
      return 0;
    }
    const receiptId = parsed.values.approval;
    if (!receiptId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(receiptId)) invalid();
    const input = { request, receiptId, statePath, consumerRoot, adapter: (options.adapter ?? github)() };
    const result = command === 'publication-publish' ? await (options.publish ?? publishPublication)(input)
      : await (options.reconcile ?? reconcilePublication)(input);
    stdout(parsed.values.json ? jsonLine(result) : renderResult(result));
    return result.status === 'published' ? 0 : result.status === 'conflict' ? 1 : 2;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'ENGINE_FAILED', message: 'Publication command failed unexpectedly; reconcile any previously started attempt.' } }));
    return 2;
  }
}
