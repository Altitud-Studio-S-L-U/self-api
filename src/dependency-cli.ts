import { parseArgs } from 'node:util';
import { escapeTerminal, jsonLine } from './cli-presentation.js';
import { analyzeNpmAdvisories, loadNpmDependencyInventory } from './dependency-inventory.js';
import type { NpmAdvisoryReport, NpmDependencyInventory } from './dependency-inventory.js';
import { PlumberError } from './errors.js';

export interface DependencyCliOptions {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}
function invalid(): never {
  throw new PlumberError('INVALID_INPUT', 'Use deps-scan <package-lock.json> [--json] or deps-audit <package-lock.json> --advisories <local-file> [--json].');
}
function renderInventory(inventory: NpmDependencyInventory): string {
  const unresolved = inventory.dependencies.filter((dependency) => dependency.resolution === 'unknown').length;
  const missing = inventory.declarations.filter((declaration) => declaration.lockfileEntry === 'not-recorded').length;
  const lines = [
    `Npm lockfile: version ${inventory.lockfileVersion}; digest ${inventory.sha256}`,
    `Dependency entries: ${inventory.dependencies.length}; unresolved: ${unresolved}; declarations without a root entry: ${missing}`,
    ...inventory.dependencies.map((dependency) => `- ${escapeTerminal(dependency.name ?? '(unknown package)')} ${escapeTerminal(dependency.version ?? '(unknown version)')}: ${dependency.relationship}; ${dependency.resolution}${dependency.reason ? ` (${dependency.reason})` : ''}`),
    'Coverage: npm lockfile packages only. Recorded versions do not verify installed files or deployment.',
    'Declarations remain separate from recorded versions. Ranges were not resolved; code was not executed.',
    'No registry requests, advisory downloads, dependency installation, or vulnerability assessment.',
  ];
  return `${lines.join('\n')}\n`;
}
function renderAdvisories(report: NpmAdvisoryReport): string {
  const counts = { affected: 0, unknown: 0, unlisted: 0, withdrawn: 0 };
  for (const finding of report.findings) {
    if (finding.status === 'affected-known-version') counts.affected += 1;
    else if (finding.status === 'unknown') counts.unknown += 1;
    else if (finding.status === 'withdrawn-advisory') counts.withdrawn += 1;
    else counts.unlisted += 1;
  }
  return [
    `Npm advisory correlation: affected exact matches ${counts.affected}; unknown ${counts.unknown}; unlisted ${counts.unlisted}; withdrawn ${counts.withdrawn}`,
    `Unresolved dependency entries: ${report.unresolvedDependencies}`,
    ...report.findings.map((finding) => `- ${escapeTerminal(finding.advisoryId)} ${escapeTerminal(finding.package)} ${escapeTerminal(finding.version ?? '(unknown version)')}: ${finding.status}${finding.location ? ` at ${escapeTerminal(finding.location)}` : ''}`),
    'Coverage: provided advisories and explicitly listed exact versions only. No ranges or online feeds were resolved.',
    'An unlisted version is unaffected only within the supplied list; this is not a complete vulnerability assessment.',
    'Installation is not verified. Exploitability is not assessed. No code, package scripts, or installs were run.',
    '',
  ].join('\n');
}

export async function runDependencyCli(args: string[], options: DependencyCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
        advisories: { type: 'string' }, json: { type: 'boolean' },
      } });
    } catch { invalid(); }
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) invalid();
      seen.add(token.name);
    }
    const [command, lockfilePath] = parsed.positionals;
    if (parsed.positionals.length !== 2 || !lockfilePath?.trim()) invalid();
    if (command === 'deps-scan') {
      if (parsed.values.advisories !== undefined) invalid();
      const inventory = await loadNpmDependencyInventory(lockfilePath);
      stdout(parsed.values.json ? jsonLine(inventory) : renderInventory(inventory));
      return inventory.dependencies.some((dependency) => dependency.resolution === 'unknown')
        || inventory.declarations.some((declaration) => declaration.lockfileEntry === 'not-recorded') ? 1 : 0;
    }
    if (command === 'deps-audit') {
      if (!parsed.values.advisories?.trim()) invalid();
      const report = await analyzeNpmAdvisories({ lockfilePath, advisoryPath: parsed.values.advisories });
      stdout(parsed.values.json ? jsonLine(report) : renderAdvisories(report));
      return report.unresolvedDependencies > 0 || report.findings.some((finding) => finding.status === 'affected-known-version' || finding.status === 'unknown') ? 1 : 0;
    }
    invalid();
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'ENGINE_FAILED', message: 'Local dependency inspection failed unexpectedly.' } }));
    return 2;
  }
}
