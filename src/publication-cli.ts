import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { escapeTerminal, jsonLine } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { prepareJobPublicationCandidate } from './publication-plan.js';

export interface PublicationCliOptions {
  readonly prepare?: typeof prepareJobPublicationCandidate;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

type PublicationCandidate = Awaited<ReturnType<typeof prepareJobPublicationCandidate>>;

function invalid(): never {
  throw new PlumberError('INVALID_INPUT', 'Invalid publication-plan arguments. Supply an intent ID, --state, an absolute --git executable, --engine, --repository OWNER/REPO and --base.');
}

function renderCandidate(candidate: PublicationCandidate): string {
  const lines = [
    `Publication candidate: ${escapeTerminal(candidate.id)}`,
    `Status: ${escapeTerminal(candidate.status)}`,
    `Validation: ${escapeTerminal(candidate.validation.status)}`,
    `Git HEAD: ${escapeTerminal(candidate.git.headSha)}`,
    `Git tree: ${escapeTerminal(candidate.git.treeSha)}`,
    `Repository destination (not verified): ${escapeTerminal(candidate.destination.host)}/${escapeTerminal(candidate.destination.owner)}/${escapeTerminal(candidate.destination.name)}`,
    `Base branch (not verified): ${escapeTerminal(candidate.destination.baseBranch)}`,
    `Proposed branch: ${escapeTerminal(candidate.headBranch)}`,
    `Draft PR title: ${escapeTerminal(candidate.pullRequest.title)}`,
  ];
  for (const file of candidate.files) {
    lines.push(`- Proposed file: ${escapeTerminal(file.path)} (${escapeTerminal(file.beforeSha256)} -> ${escapeTerminal(file.afterSha256)})`);
  }
  lines.push('Local proposal only. Authorization: not granted. Publication: not started.',
    'No network access or GitHub writes. Live consumer unchanged.',
    'Use --json for exact local source previews. They contain source code and must remain local.');
  return `${lines.join('\n')}\n`;
}

export async function runPublicationCli(args: string[], options: PublicationCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
        state: { type: 'string' }, git: { type: 'string' }, engine: { type: 'string' }, repository: { type: 'string' },
        base: { type: 'string' }, json: { type: 'boolean' },
      } });
    } catch { invalid(); }
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) invalid();
      seen.add(token.name);
    }
    const [command, intentId] = parsed.positionals;
    const { state: statePath, git: gitPath, engine: enginePath, repository, base: baseBranch } = parsed.values;
    if (command !== 'publication-plan' || parsed.positionals.length !== 2 || !intentId || !/^[a-f0-9]{64}$/u.test(intentId)
      || !statePath?.trim() || !gitPath?.trim() || !isAbsolute(gitPath) || !enginePath?.trim()
      || !repository || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u.test(repository)
      || !baseBranch?.trim()) invalid();
    const candidate = await (options.prepare ?? prepareJobPublicationCandidate)({ statePath, intentId, gitPath, enginePath, repository, baseBranch });
    stdout(parsed.values.json ? jsonLine(candidate) : renderCandidate(candidate));
    return 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'ENGINE_FAILED', message: 'Publication proposal failed unexpectedly.' } }));
    return 2;
  }
}
