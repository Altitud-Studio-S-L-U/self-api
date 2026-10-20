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
import { validateRuntime } from './validation-runtime.js';
import { prepareValidationRuntime } from './validation-runtime-prepare.js';
import { prepareMigrationValidation, approveMigrationValidation, executeMigrationValidation } from './migration-validation.js';
import { runWorkerCli } from './worker-cli.js';
import { escapeTerminal, jsonLine, renderPlan, renderValidation, confirmLocalRequest } from './cli-presentation.js';
import { runJobCli } from './job-cli.js';
import { runPublicationCli } from './publication-cli.js';
import { runSourceCli } from './source-cli.js';
import { runWorkerLoopCli } from './worker-loop-cli.js';
import { runWorkerServiceCli } from './worker-service-cli.js';
import { runSourceObserverCli } from './source-observer-cli.js';
import { runDependencyCli } from './dependency-cli.js';
import { runPublicationCommandCli } from './publication-command-cli.js';
import { runClientUpdateCli } from './client-update-cli.js';
import { runJobProposalCli } from './job-proposal-cli.js';
import { runModelConnectionsCli } from './model-connections-cli.js';
import { runWorkerSetupCli } from './worker-setup-cli.js';

interface CliOptions {
  readonly compare?: typeof compareOpenApi;
  readonly scan?: typeof scanConsumer;
  readonly impact?: typeof analyzeImpact;
  readonly plan?: typeof createMigrationPlan;
  readonly prepareValidation?: typeof prepareMigrationValidation;
  readonly approveValidation?: typeof approveMigrationValidation;
  readonly executeValidation?: typeof executeMigrationValidation;
  readonly prepareRuntime?: typeof prepareValidationRuntime;
  readonly confirm?: (requestId: string) => Promise<boolean>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const help = `Usage: keepseam compare <base.json> <revision.json> --engine <path> [--json]
       keepseam runtime prepare pytest|maven-junit --output <new-manifest.json>
       keepseam mcp-compare <base.json> <revision.json> [--json]
       keepseam mcp-impact <base.json> <revision.json> --consumer <directory> [--bindings <local-json>] [--json]
       keepseam mcp-snapshot <catalog.json> [--json]
       keepseam integration-check <manifest.json> [--json]
       keepseam schema-compare <base.json> <revision.json> --direction input|output [--json]
       keepseam example-compare <base.json> <revision.json> [--json]
       keepseam source-subscribe <source-file> --kind mcp|json-schema|json-example|documentation --baseline <file> --state <directory> [--consumer <directory>] [--direction input|output] [--normalize-line-endings] [--json]
       keepseam source-http-subscribe <policy.json> --kind mcp|json-schema|json-example|documentation --baseline <file> --state <directory> [--consumer <directory>] [--direction input|output] [--normalize-line-endings] [--json]
       keepseam source-observe --once --state <directory> [--subscription <id>] [--http] [--json]
       keepseam source-subscriptions --state <directory> [--json]
       keepseam source-history --state <directory> [--subscription <id>] [--json]
       keepseam deps-scan <package-lock.json> [--json]
       keepseam deps-audit <package-lock.json> --advisories <local-file> [--json]
       keepseam scan <consumer-directory> [--json]
       keepseam impact <base.json> <revision.json> --consumer <directory> --provider-base-url <url> --engine <path> [--json]
       keepseam plan <base.json> <revision.json> --consumer <directory> --provider-base-url <url> --engine <path> --recipe <recipe.json> [--json]
       keepseam validation-plan <base.json> <revision.json> <plan-options> --test <relative-test-file> [--json]
       keepseam approve <base.json> <revision.json> <plan-options> --test <relative-test-file> --state <outside-directory>
       keepseam validate <base.json> <revision.json> <plan-options> --test <relative-test-file> --state <outside-directory> --approval <receipt-id> [--json]
       keepseam subscribe <source.json> --baseline <base.json> --consumer <directory> --provider-base-url <url> --engine <path> --state <outside-directory> [--label <text>] [--json]
       keepseam http-subscribe <policy.json> --baseline <base.json> --consumer <directory> --provider-base-url <url> --engine <path> --state <outside-directory> [--label <text>] [--json]
       keepseam worker --once --state <directory> --engine <path> [--subscription <id>] [--http] [--json]
       keepseam worker-loop --state <directory> --engine <path> [--cycles <1-1000>] [--interval-ms <1000-3600000>] [--run-approved] [--http] [--json]
       keepseam setup init --dir <absolute-private-directory> [--state <absolute-directory>] [--cloud <https-origin>]
       keepseam setup identity --dir <absolute-private-directory>
       keepseam setup complete --dir <absolute-private-directory> [--interval-ms <1000-3600000>] < enrollment.json
       keepseam setup trust --dir <absolute-private-directory> --trust <public-trust.json> --key <kid>=<sha256> [--key ...]
       keepseam setup config --dir <absolute-private-directory> --license --expect <config-sha256>
       keepseam doctor --dir <absolute-private-directory> [--online] [--json]
       keepseam worker-service run|status|stop --config <absolute-json>
       keepseam client-update check|stage|status --config <absolute-json>
       keepseam worker-service render --config <absolute-json> --target systemd|launchd|windows --node <absolute-path> --cli <absolute-path> [--scope system|user] [--user <unix-account>] [--name <service-name>]
       keepseam worker-service render --config <absolute-json> --target systemd --executable <absolute-path-to-packaged-keepseam> [--scope system|user] [--user <unix-account>] [--name <service-name>]
       keepseam subscriptions --state <directory> [--json]
       keepseam jobs --state <directory> [--json]
       keepseam model-connections status|verify --state <private-directory> --model <connections.json> [--connection <id>] [--allow-remote] [--startup-checks]
       keepseam job-proposal-plan <job-id> --state <directory> --engine <path> --model <local-config.json> --test <file> [--source <file>] [--evidence <local-file>] [--timeout-ms <1000-120000>]
       keepseam job-propose <job-id> --state <directory> --engine <path> --model <local-config.json> --test <file> [--source <file>] [--evidence <local-file>] [--timeout-ms <1000-120000>] [--allow-remote] [--output <name.json>]
       keepseam job-review --state <directory> --engine <path> --proposal <local-json> --answers <local-json> [--runtime <manifest.json>] [--output <name.json>] [--json]
       keepseam job-plan <job-id> --state <directory> --engine <path> --recipe <path> --test <file> [--json]
       keepseam job-approve <job-id> --state <directory> --engine <path> --recipe <path> --test <file>
       keepseam job-queue <job-id> --state <directory> --engine <path> --recipe <path> --test <file> --approval <receipt-id> [--json]
       keepseam run-approved --once --state <directory> --engine <path> [--intent <id>] [--limit <1-10>] [--json]
       keepseam recover-approved --state <directory> [--limit <1-10>] [--json]
       keepseam executions --state <directory> [--json]
       keepseam publication-plan <intent-id> --state <directory> --git <absolute-executable> --engine <path> --repository OWNER/REPO --base <branch> [--json]
       keepseam publication-review --candidate <local-json> --author-name <name> --author-email <email> --github [--json]
       keepseam publication-approve --request <local-json> --state <directory> --consumer <directory>
       keepseam publication-publish --request <local-json> --state <directory> --consumer <directory> --approval <receipt-id> --github [--json]
       keepseam publication-reconcile --request <local-json> --state <directory> --consumer <directory> --approval <receipt-id> --github [--json]

Compare local OpenAPI JSON contracts using an explicitly selected oasdiff executable.

Options:
  --engine <path>  Path to the local oasdiff executable (required).
  --consumer <directory>  Consumer repository to inspect without executing code.
  --provider-base-url <url>  Explicit HTTP(S) provider origin and optional base path.
  --recipe <path>  Explicit local migration decisions and exact edits.
  --test <path>    Captured JS/TS, Python or Java test entrypoint; one runtime per request.
  --runtime <file> Prepared immutable pytest or Maven/JUnit runtime manifest (validation commands).
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
  job-propose confirms exact destinations and limits; manual is default, Auto permits one approved fallback. Remote disclosure also needs --allow-remote.
  model-connections verify performs a bounded synthetic inference; --startup-checks separately authorizes checks after restart, never idle polling.
job-review records explicit answers bound to the saved proposal digest; it neither approves tests nor publishes.
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
MCP impact also exits 1 for unresolved calls or inspection issues; bindings are explicit file/receiver/server/auth-context records.
Source observation exits 1 for a new evidence transition and 2 for failed/busy observations; it never approves work.
HTTP registration reads a local policy without network access. Observation requires --http; private credentials are configured through the SDK.
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
  for (const issue of inventory.issues) {
    lines.push(`- Inspection issue: ${escapeTerminal(issue.code)} at ${escapeTerminal(issue.location.file)}:${issue.location.line}:${issue.location.column}`);
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
  if (args[0] === 'runtime') {
    const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
    const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
    const usage = 'Usage: keepseam runtime prepare pytest|maven-junit --output <new-manifest.json>\nPreparation downloads verified official dependencies; validation executes offline. Linux x64 and local Docker required.\n';
    if (args.length === 2 && args[1] === '--help') { stdout(usage); return 0; }
    const [, command, kind, flag, output] = args;
    if (args.length !== 5 || command !== 'prepare' || (kind !== 'pytest' && kind !== 'maven-junit') || flag !== '--output' || !output?.trim()) {
      stderr(usage); return 2;
    }
    try { stdout(jsonLine(await (options.prepareRuntime ?? prepareValidationRuntime)(kind, output))); return 0; }
    catch (error) {
      stderr(jsonLine({ error: { code: 'INVALID_INPUT', message: error instanceof Error ? error.message.slice(0, 1200) : 'Could not prepare the isolated runtime.' } }));
      return 2;
    }
  }
  if (args.includes('--help') || args.includes('-h')) {
    (options.stdout ?? ((text: string) => { process.stdout.write(text); }))(help);
    return 0;
  }
  if (args[0] === 'setup' || args[0] === 'doctor') {
    return runWorkerSetupCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (args[0] === 'client-update') {
    return runClientUpdateCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (args[0] === 'model-connections') {
    return runModelConnectionsCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}), ...(options.confirm ? { confirm: options.confirm } : {}) });
  }
  if (['job-proposal-plan', 'job-propose', 'job-review'].includes(args[0] ?? '')) {
    return runJobProposalCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}), ...(options.confirm ? { confirm: options.confirm } : {}) });
  }
  if (['subscribe', 'http-subscribe', 'worker', 'subscriptions', 'jobs'].includes(args[0] ?? '')) {
    return runWorkerCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (['job-plan', 'job-approve', 'job-queue', 'run-approved', 'recover-approved', 'executions'].includes(args[0] ?? '')) {
    return runJobCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (args[0] === 'publication-plan') {
    return runPublicationCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (['mcp-compare', 'mcp-impact', 'mcp-snapshot', 'integration-check', 'schema-compare', 'example-compare'].includes(args[0] ?? '')) {
    return runSourceCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (args[0] === 'worker-loop') {
    return runWorkerLoopCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (args[0] === 'worker-service') {
    return runWorkerServiceCli(args, { ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}) });
  }
  if (['source-subscribe', 'source-http-subscribe', 'source-observe', 'source-subscriptions', 'source-history'].includes(args[0] ?? '')) {
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
        runtime: { type: 'string' },
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
  const validationOnlyOptions = testPaths || statePath || receiptId || parsed.values.runtime;
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
      const runtime = parsed.values.runtime === undefined ? undefined : validateRuntime(await loadLocalJson(parsed.values.runtime, 16 * 1024));
      const validationOptions = { basePath: basePath!, revisionPath: revisionPath!, enginePath: enginePath!, consumerRoot: consumerRoot!, providerBaseUrl: providerBaseUrl!, recipe, testPaths: testPaths!, ...(runtime ? { runtime } : {}) };
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
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
