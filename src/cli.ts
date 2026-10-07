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
import { loadLocalJson } from './local-file.js';
import { prepareMigrationValidation, approveMigrationValidation, executeMigrationValidation } from './migration-validation.js';
import { runWorkerCli } from './worker-cli.js';
import { escapeTerminal, jsonLine, renderPlan, renderValidation, confirmLocalRequest } from './cli-presentation.js';
import { runJobCli } from './job-cli.js';
import { runPublicationCli } from './publication-cli.js';
import { runSourceCli } from './source-cli.js';
import { runWorkerLoopCli } from './worker-loop-cli.js';
import { runSourceObserverCli } from './source-observer-cli.js';
import { runDependencyCli } from './dependency-cli.js';
import { runPublicationCommandCli } from './publication-command-cli.js';

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
       plumber mcp-compare <base.json> <revision.json> [--json]
       plumber mcp-snapshot <catalog.json> [--json]
       plumber integration-check <manifest.json> [--json]
       plumber schema-compare <base.json> <revision.json> --direction input|output [--json]
       plumber example-compare <base.json> <revision.json> [--json]
       plumber source-subscribe <source-file> --kind mcp|json-schema|json-example|documentation --baseline <file> --state <directory> [--consumer <directory>] [--direction input|output] [--normalize-line-endings] [--json]
       plumber source-observe --once --state <directory> [--subscription <id>] [--json]
       plumber source-subscriptions --state <directory> [--json]
       plumber source-history --state <directory> [--subscription <id>] [--json]
       plumber deps-scan <package-lock.json> [--json]
       plumber deps-audit <package-lock.json> --advisories <local-file> [--json]
       plumber scan <consumer-directory> [--json]
       plumber impact <base.json> <revision.json> --consumer <directory> --provider-base-url <url> --engine <path> [--json]
       plumber plan <base.json> <revision.json> --consumer <directory> --provider-base-url <url> --engine <path> --recipe <recipe.json> [--json]
       plumber validation-plan <base.json> <revision.json> <plan-options> --test <relative-test-file> [--json]
       plumber approve <base.json> <revision.json> <plan-options> --test <relative-test-file> --state <outside-directory>
       plumber validate <base.json> <revision.json> <plan-options> --test <relative-test-file> --state <outside-directory> --approval <receipt-id> [--json]
       plumber subscribe <source.json> --baseline <base.json> --consumer <directory> --provider-base-url <url> --engine <path> --state <outside-directory> [--label <text>] [--json]
       plumber worker --once --state <directory> --engine <path> [--subscription <id>] [--json]
       plumber worker-loop --state <directory> --engine <path> [--cycles <1-1000>] [--interval-ms <1000-3600000>] [--run-approved] [--json]
       plumber subscriptions --state <directory> [--json]
       plumber jobs --state <directory> [--json]
       plumber job-plan <job-id> --state <directory> --engine <path> --recipe <path> --test <file> [--json]
       plumber job-approve <job-id> --state <directory> --engine <path> --recipe <path> --test <file>
       plumber job-queue <job-id> --state <directory> --engine <path> --recipe <path> --test <file> --approval <receipt-id> [--json]
       plumber run-approved --once --state <directory> --engine <path> [--intent <id>] [--limit <1-10>] [--json]
       plumber recover-approved --state <directory> [--limit <1-10>] [--json]
       plumber executions --state <directory> [--json]
       plumber publication-plan <intent-id> --state <directory> --git <absolute-executable> --engine <path> --repository OWNER/REPO --base <branch> [--json]
       plumber publication-review --candidate <local-json> --author-name <name> --author-email <email> --github [--json]
       plumber publication-approve --request <local-json> --state <directory> --consumer <directory>
       plumber publication-publish --request <local-json> --state <directory> --consumer <directory> --approval <receipt-id> --github [--json]
       plumber publication-reconcile --request <local-json> --state <directory> --consumer <directory> --approval <receipt-id> --github [--json]

Compare local OpenAPI JSON contracts using an explicitly selected oasdiff executable.

Options:
  --engine <path>  Path to the local oasdiff executable (required).
  --consumer <directory>  Consumer repository to inspect without executing code.
  --provider-base-url <url>  Explicit HTTP(S) provider origin and optional base path.
  --recipe <path>  Explicit local migration decisions and exact edits.
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
job-approve requires the same explicit terminal review; job-queue only persists existing authorization.
run-approved defaults to one queued intent and never retries an interrupted attempt.
recover-approved reconciles expired/interrupted intents; it cannot execute tests or grant approval.
Execution passes exit 0 for no work or all passing outcomes, 1 for completed failures/improvement,
and 2 for blocked, interrupted, or unavailable execution. JSON artifacts are private local data.
publication-plan exits 0 for a local Git-bound candidate or 2 for unavailable/invalid evidence.
It does not access GitHub, verify the remote base, grant publication approval, or create a branch/PR.
publication-review/publish/reconcile require --github and a locally configured GH_TOKEN.
publication-approve requires terminal confirmation and cannot publish. Its permission is separate from validation.
Publication exits 0 for verified publication, 1 for conflicts, and 2 for uncertainty or errors. Reconciliation does not retry writes.
MCP/schema comparison exits 1 for breaking changes or inconclusive evidence. Examples always leave compatibility unestablished.
Source observation exits 1 for a new evidence transition and 2 for failed/busy observations; it never approves work.
worker-loop is finite (one cycle by default), stops on execution failures, and exits 130 after cancellation.
Dependency commands exit 1 for affected or unresolved evidence; no result proves absence of all vulnerabilities.
`;

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

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    (options.stdout ?? ((text: string) => { process.stdout.write(text); }))(help);
    return 0;
  }
  if (['subscribe', 'worker', 'subscriptions', 'jobs'].includes(args[0] ?? '')) {
    return runWorkerCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (['job-plan', 'job-approve', 'job-queue', 'run-approved', 'recover-approved', 'executions'].includes(args[0] ?? '')) {
    return runJobCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (args[0] === 'publication-plan') {
    return runPublicationCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (['mcp-compare', 'mcp-snapshot', 'integration-check', 'schema-compare', 'example-compare'].includes(args[0] ?? '')) {
    return runSourceCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (args[0] === 'worker-loop') {
    return runWorkerLoopCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (['source-subscribe', 'source-observe', 'source-subscriptions', 'source-history'].includes(args[0] ?? '')) {
    return runSourceObserverCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (['deps-scan', 'deps-audit'].includes(args[0] ?? '')) {
    return runDependencyCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (['publication-review', 'publication-approve', 'publication-publish', 'publication-reconcile'].includes(args[0] ?? '')) {
    return runPublicationCommandCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}), ...(options.confirm ? { confirm: options.confirm } : {}) });
  }
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
