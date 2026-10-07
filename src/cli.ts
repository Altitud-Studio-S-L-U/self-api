#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { compareOpenApi } from './compare.js';
import type { ComparisonReport } from './contracts.js';
import { PlumberError } from './errors.js';
import { scanConsumer } from './scan.js';
import { analyzeImpact } from './impact.js';
import type { ImpactReport } from './impact.js';
import type { ConsumerInventory } from './consumer-contracts.js';
import { createMigrationPlan } from './migration-plan.js';
import type { MigrationPlan } from './migration-plan.js';
import { loadLocalJson } from './local-file.js';
import { createInterface } from 'node:readline/promises';
import { prepareMigrationValidation, approveMigrationValidation, executeMigrationValidation } from './migration-validation.js';
import type { MigrationValidationRequest } from './migration-validation.js';

interface CliOptions {
  readonly compare?: typeof compareOpenApi;
  readonly scan?: typeof scanConsumer;
  readonly impact?: typeof analyzeImpact;
  readonly plan?: typeof createMigrationPlan;
  readonly prepareValidation?: typeof prepareMigrationValidation;
  readonly approveValidation?: typeof approveMigrationValidation;
  readonly executeValidation?: typeof executeMigrationValidation;
  readonly confirm?: (requestId: string) => Promise<boolean>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const help = `Usage: plumber compare <base.json> <revision.json> --engine <path> [--json]
       plumber scan <consumer-directory> [--json]
       plumber impact <base.json> <revision.json> --consumer <directory> --provider-base-url <url> --engine <path> [--json]
       plumber plan <base.json> <revision.json> --consumer <directory> --provider-base-url <url> --engine <path> --recipe <recipe.json> [--json]
       plumber validation-plan <base.json> <revision.json> <plan-options> --test <relative-test-file> [--json]
       plumber approve <base.json> <revision.json> <plan-options> --test <relative-test-file> --state <outside-directory>
       plumber validate <base.json> <revision.json> <plan-options> --test <relative-test-file> --state <outside-directory> --approval <receipt-id> [--json]

Compare local OpenAPI JSON contracts using an explicitly selected oasdiff executable.

Options:
  --engine <path>  Path to the local oasdiff executable (required).
  --consumer <directory>  Consumer repository to inspect without executing code.
  --provider-base-url <url>  Explicit HTTP(S) provider origin and optional base path.
  --recipe <path>  Explicit local migration decisions and exact edits (plan only).
  --test <path>    Captured Node test file; repeat to select multiple tests.
  --state <path>   Private local state outside the consumer checkout.
  --approval <id>  Single-use approval from an explicit approve action.
  --json           Write the comparison report as JSON to stdout.
  -h, --help       Show this help.

Exit codes: 0 = no breaking changes detected, 1 = breaking changes detected,
            2 = invalid input or comparison engine failure.
Errors are written as JSON to stderr in both output modes.
Coverage is structural only; consumer impact is not analyzed.
Use impact to associate potential native-fetch usages; every impact report requires review.
scan exits 1 for unresolved calls or inspection issues; impact exits 1 for contract breaking changes,
including changes with no observed consumer match. Inspection commands do not execute consumer scripts.
plan exits 0 for a syntax-checked proposal, 1 for pending decisions, or 2 for invalid input.
Planning never grants authorization or modifies consumer files; JSON plans contain local source previews.
<plan-options> means --consumer, --provider-base-url, --engine, and --recipe as above.
approve requires a terminal confirmation of the exact request; it never starts validation.
validate runs approved tests against isolated copies using the fixed Linux x64 Docker profile.
validate exits 0 only when both baseline and candidate pass, 1 for completed failures/improvement,
or 2 for invalid authorization/unavailable execution. It never changes the live consumer or publishes.
`;

function escapeTerminal(text: string): string {
  // Contract and engine text must not control the terminal or reorder its output.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function jsonLine(value: unknown): string {
  return `${escapeTerminal(JSON.stringify(value))}\n`;
}

function renderReport(report: ComparisonReport, withConsumerEvidence = false): string {
  const summary = report.status === 'breaking-changes'
    ? 'Breaking changes detected.'
    : 'No breaking changes detected.';
  const lines = [
    summary,
    `Engine: ${escapeTerminal(report.engine.name)} ${escapeTerminal(report.engine.version)}`,
    `API version: ${escapeTerminal(report.base.apiVersion)} -> ${escapeTerminal(report.revision.apiVersion)}`,
    `Content changed: ${report.contentChanged ? 'yes' : 'no'}`,
    `Coverage: structural contract only.${withConsumerEvidence ? '' : ' Consumer impact: not analyzed.'}`,
    `Changes: ${report.changes.length}`,
  ];
  for (const change of report.changes) {
    const target = [change.operation, change.path]
      .filter((value): value is string => value !== undefined)
      .map(escapeTerminal)
      .join(' ');
    lines.push(`- [${escapeTerminal(change.level)}] ${escapeTerminal(change.id)}: ${target ? `${target} — ` : ''}${escapeTerminal(change.text)}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderInventory(inventory: ConsumerInventory): string {
  const lines = [
    `Captured files: ${inventory.files.length}`,
    `Native fetch calls: ${inventory.calls.length}`,
    `Unresolved calls: ${inventory.calls.filter(call => call.resolution === 'unresolved').length}`,
    `Inspection issues: ${inventory.issues.length}`,
    `Skipped entries: ${inventory.skipped.length}`,
    'Coverage: bounded syntax inspection. Imports, aliases, and dynamic dispatch require review.',
    'Consumer code executed: no. Validation scripts are candidates only.',
  ];
  for (const call of inventory.calls) {
    lines.push(`- ${escapeTerminal(call.location.file)}:${call.location.line}:${call.location.column} ${call.method ?? '?'} ${escapeTerminal(call.pathPattern ?? '?')} (${call.resolution})`);
  }
  for (const candidate of inventory.validationCandidates) {
    lines.push(`- Validation candidate: ${escapeTerminal(candidate.manifest)} / ${escapeTerminal(candidate.script)}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderImpact(report: ImpactReport): string {
  const links = report.matches.flatMap(match => match.callIds.map(id => {
    const call = report.inventory.calls.find(candidate => candidate.id === id)!;
    const change = report.comparison.changes[match.changeIndex]!;
    return `- ${escapeTerminal(change.id)} -> ${escapeTerminal(call.location.file)}:${call.location.line}:${call.location.column}`;
  }));
  return `${renderReport(report.comparison, true)}${renderInventory(report.inventory)}Potentially affected changes: ${report.matches.length}\n${links.length ? `${links.join('\n')}\n` : ''}Unmapped changes: ${report.unmappedChangeIndexes.length}\nConclusion: review required; no migration or consumer compatibility has been validated.\n`;
}

function renderPlan(plan: MigrationPlan): string {
  const lines = [
    `Migration proposal: ${plan.id}`,
    escapeTerminal(plan.summary),
    `Status: ${plan.status}`,
    `Authorization: ${plan.authorization}`,
    `Validation: ${plan.validation}; consumer tests have not run.`,
    'Consumer files modified: no. Consumer code executed: no.',
  ];
  for (const decision of plan.decisions) lines.push(`- ${escapeTerminal(decision.question)} ${escapeTerminal(decision.answer?.trim() || '(pending)')}`);
  for (const requirement of plan.requirements) lines.push(`- Decision ${escapeTerminal(requirement.id)}: ${escapeTerminal(requirement.question)}`);
  for (const file of plan.files) lines.push(`- Proposed file: ${escapeTerminal(file.path)} (${file.beforeSha256} -> ${file.afterSha256})`);
  lines.push('Use --json for the exact local before/after previews. They contain source code and must remain local.');
  return `${lines.join('\n')}\n`;
}

function renderValidation(request: MigrationValidationRequest, includeSource = false): string {
  const lines = [renderPlan(request.plan).trimEnd(), `Validation request: ${request.id}`,
    `Profile: ${escapeTerminal(JSON.stringify(request.spec.profile))}`,
    'Actions: baseline tests, then candidate tests in separate captured copies.',
    'No dependency installation, live checkout writes, network access, or Git publication.',
    'Only captured JS/TS source and package manifests are available; other data/dependencies are omitted.',
    `Command in each copy: node ${request.spec.profile.command.join(' ')} ${request.spec.testPaths.map(path => escapeTerminal(JSON.stringify(`/workspace/${path}`))).join(' ')}`,
    'Local approval expires after 15 minutes and permits one attempt, including failures.',
  ];
  if (includeSource) {
    for (const file of request.plan.files) {
      lines.push(`Before: ${escapeTerminal(file.path)}`, ...file.before.split('\n').map(line => `- ${escapeTerminal(line)}`));
      lines.push(`After: ${escapeTerminal(file.path)}`, ...file.after.split('\n').map(line => `+ ${escapeTerminal(line)}`));
    }
  }
  return `${lines.join('\n')}\n`;
}

async function confirmLocalRequest(requestId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new PlumberError('INVALID_INPUT', 'Approval requires an interactive terminal; there is no implicit or piped confirmation.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Type the exact validation request ID to authorize one attempt (anything else cancels):\n${requestId}\n> `);
    return answer.trim() === requestId;
  } finally { terminal.close(); }
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        engine: { type: 'string' },
        consumer: { type: 'string' },
        'provider-base-url': { type: 'string' },
        recipe: { type: 'string' },
        test: { type: 'string', multiple: true },
        state: { type: 'string' },
        approval: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    stderr(jsonLine({ error: {
      code: 'INVALID_INPUT',
      message: error instanceof Error ? error.message : 'Invalid command arguments.',
    } }));
    return 2;
  }

  if (parsed.values.help) {
    stdout(help);
    return 0;
  }

  const [command, basePath, revisionPath] = parsed.positionals;
  const enginePath = parsed.values.engine;
  const consumerRoot = parsed.values.consumer;
  const providerBaseUrl = parsed.values['provider-base-url'];
  const recipePath = parsed.values.recipe;
  const testPaths = parsed.values.test;
  const statePath = parsed.values.state;
  const receiptId = parsed.values.approval;
  const isValidation = command === 'validation-plan' || command === 'approve' || command === 'validate';
  const validationOnlyOptions = testPaths || statePath || receiptId;
  const validCompare = command === 'compare' && parsed.positionals.length === 3 && basePath && revisionPath && enginePath && !consumerRoot && !providerBaseUrl && !recipePath;
  const validScan = command === 'scan' && parsed.positionals.length === 2 && basePath && !enginePath && !consumerRoot && !providerBaseUrl && !recipePath;
  const validImpact = command === 'impact' && parsed.positionals.length === 3 && basePath && revisionPath && enginePath && consumerRoot && providerBaseUrl && !recipePath;
  const validPlan = command === 'plan' && parsed.positionals.length === 3 && basePath && revisionPath && enginePath && consumerRoot && providerBaseUrl && recipePath;
  const validValidation = isValidation && parsed.positionals.length === 3 && basePath && revisionPath && enginePath && consumerRoot && providerBaseUrl && recipePath && testPaths?.length
    && (command === 'validation-plan' ? !statePath && !receiptId
      : command === 'approve' ? statePath && !receiptId && !parsed.values.json : statePath && receiptId);
  if ((!validCompare && !validScan && !validImpact && !validPlan && !validValidation) || (!isValidation && validationOnlyOptions)) {
    stderr(jsonLine({ error: {
      code: 'INVALID_INPUT',
      message: 'Invalid command arguments. Use --help for the required options.',
    } }));
    return 2;
  }

  try {
    if (validValidation) {
      const recipe = await loadLocalJson(recipePath!, 1024 * 1024);
      const validationOptions = { basePath: basePath!, revisionPath: revisionPath!, enginePath: enginePath!, consumerRoot: consumerRoot!, providerBaseUrl: providerBaseUrl!, recipe, testPaths: testPaths! };
      if (command === 'validate') {
        const result = await (options.executeValidation ?? executeMigrationValidation)({ options: validationOptions, statePath: statePath!, receiptId: receiptId! });
        stdout(parsed.values.json ? jsonLine(result)
          : `Validation: ${result.status}\nBaseline: ${result.baseline.status}\nCandidate: ${result.candidate?.status ?? 'not-run'}\nConsumer modified: no. Publication: not authorized.\n`);
        return result.status === 'passed' ? 0 : result.status === 'blocked' ? 2 : 1;
      }
      const request = await (options.prepareValidation ?? prepareMigrationValidation)(validationOptions);
      stdout(parsed.values.json ? jsonLine(request) : renderValidation(request, command === 'approve'));
      if (command === 'validation-plan') return 0;
      if (!await (options.confirm ?? confirmLocalRequest)(request.id)) {
        stdout('Approval cancelled; no execution authorized.\n');
        return 1;
      }
      const receipt = await (options.approveValidation ?? approveMigrationValidation)({ options: validationOptions, expectedRequestId: request.id, statePath: statePath!, origin: 'local-cli' });
      stdout(`Approval receipt: ${receipt.id}\nExpires: ${receipt.expiresAt}\nValidation has not started.\n`);
      return 0;
    }
    if (validPlan) {
      const recipe = await loadLocalJson(recipePath!, 1024 * 1024);
      const plan = await (options.plan ?? createMigrationPlan)({ basePath: basePath!, revisionPath: revisionPath!, enginePath: enginePath!, consumerRoot: consumerRoot!, providerBaseUrl: providerBaseUrl!, recipe });
      stdout(parsed.values.json ? jsonLine(plan) : renderPlan(plan));
      return plan.status === 'ready-for-review' ? 0 : 1;
    }
    if (validScan) {
      const inventory = await (options.scan ?? scanConsumer)(basePath!);
      stdout(parsed.values.json ? jsonLine(inventory) : renderInventory(inventory));
      return inventory.issues.length || inventory.calls.some(call => call.resolution === 'unresolved') ? 1 : 0;
    }
    if (validImpact) {
      const report = await (options.impact ?? analyzeImpact)({ basePath: basePath!, revisionPath: revisionPath!, enginePath: enginePath!, consumerRoot: consumerRoot!, providerBaseUrl: providerBaseUrl! });
      stdout(parsed.values.json ? jsonLine(report) : renderImpact(report));
      return report.comparison.status === 'breaking-changes' ? 1 : 0;
    }
    const report = await (options.compare ?? compareOpenApi)({ basePath: basePath!, revisionPath: revisionPath!, enginePath: enginePath! });
    stdout(parsed.values.json ? jsonLine(report) : renderReport(report));
    return report.status === 'breaking-changes' ? 1 : 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError
      ? { code: error.code, message: error.message }
      : { code: 'ENGINE_FAILED', message: 'Comparison failed unexpectedly.' },
    }));
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
