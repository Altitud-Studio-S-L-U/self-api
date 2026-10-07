#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { compareOpenApi } from './compare.js';
import type { ComparisonReport } from './contracts.js';
import { PlumberError } from './errors.js';

interface CliOptions {
  readonly compare?: typeof compareOpenApi;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const help = `Usage: plumber compare <base.json> <revision.json> --engine <path> [--json]

Compare local OpenAPI JSON contracts using an explicitly selected oasdiff executable.

Options:
  --engine <path>  Path to the local oasdiff executable (required).
  --json           Write the comparison report as JSON to stdout.
  -h, --help       Show this help.

Exit codes: 0 = no breaking changes detected, 1 = breaking changes detected,
            2 = invalid input or comparison engine failure.
Errors are written as JSON to stderr in both output modes.
Coverage is structural only; consumer impact is not analyzed.
`;

function escapeTerminal(text: string): string {
  // Contract and engine text must not control the terminal or reorder its output.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function jsonLine(value: unknown): string {
  return `${escapeTerminal(JSON.stringify(value))}\n`;
}

function renderReport(report: ComparisonReport): string {
  const summary = report.status === 'breaking-changes'
    ? 'Breaking changes detected.'
    : 'No breaking changes detected.';
  const lines = [
    summary,
    `Engine: ${escapeTerminal(report.engine.name)} ${escapeTerminal(report.engine.version)}`,
    `API version: ${escapeTerminal(report.base.apiVersion)} -> ${escapeTerminal(report.revision.apiVersion)}`,
    `Content changed: ${report.contentChanged ? 'yes' : 'no'}`,
    'Coverage: structural contract only. Consumer impact: not analyzed.',
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
  if (command !== 'compare' || parsed.positionals.length !== 3 || !basePath || !revisionPath || !enginePath) {
    stderr(jsonLine({ error: {
      code: 'INVALID_INPUT',
      message: 'Expected: plumber compare <base.json> <revision.json> --engine <path> [--json]. Use --help for details.',
    } }));
    return 2;
  }

  try {
    const report = await (options.compare ?? compareOpenApi)({ basePath, revisionPath, enginePath });
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
