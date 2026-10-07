#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { compareOpenApi } from './compare.js';
import type { ComparisonReport } from './contracts.js';
import { PlumberError } from './errors.js';
import { scanConsumer } from './scan.js';
import { analyzeImpact } from './impact.js';
import type { ImpactReport } from './impact.js';
import type { ConsumerInventory } from './consumer-contracts.js';

interface CliOptions {
  readonly compare?: typeof compareOpenApi;
  readonly scan?: typeof scanConsumer;
  readonly impact?: typeof analyzeImpact;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const help = `Usage: plumber compare <base.json> <revision.json> --engine <path> [--json]
       plumber scan <consumer-directory> [--json]
       plumber impact <base.json> <revision.json> --consumer <directory> --provider-base-url <url> --engine <path> [--json]

Compare local OpenAPI JSON contracts using an explicitly selected oasdiff executable.

Options:
  --engine <path>  Path to the local oasdiff executable (required).
  --consumer <directory>  Consumer repository to inspect without executing code.
  --provider-base-url <url>  Explicit HTTP(S) provider origin and optional base path.
  --json           Write the comparison report as JSON to stdout.
  -h, --help       Show this help.

Exit codes: 0 = no breaking changes detected, 1 = breaking changes detected,
            2 = invalid input or comparison engine failure.
Errors are written as JSON to stderr in both output modes.
Coverage is structural only; consumer impact is not analyzed.
Use impact to associate potential native-fetch usages; every impact report requires review.
scan exits 1 for unresolved calls or inspection issues; impact exits 1 for contract breaking changes,
including changes with no observed consumer match. No command executes consumer scripts.
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
  const validCompare = command === 'compare' && parsed.positionals.length === 3 && basePath && revisionPath && enginePath && !consumerRoot && !providerBaseUrl;
  const validScan = command === 'scan' && parsed.positionals.length === 2 && basePath && !enginePath && !consumerRoot && !providerBaseUrl;
  const validImpact = command === 'impact' && parsed.positionals.length === 3 && basePath && revisionPath && enginePath && consumerRoot && providerBaseUrl;
  if (!validCompare && !validScan && !validImpact) {
    stderr(jsonLine({ error: {
      code: 'INVALID_INPUT',
      message: 'Invalid compare, scan, or impact arguments. Use --help for the required options.',
    } }));
    return 2;
  }

  try {
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
