import { createInterface } from 'node:readline/promises';
import { PlumberError } from './errors.js';
import type { MigrationPlan } from './migration-plan.js';
import type { MigrationValidationRequest } from './migration-validation.js';

export function escapeTerminal(text: string): string {
  // Contract and engine text must not control the terminal or reorder its output.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function jsonLine(value: unknown): string {
  return `${escapeTerminal(JSON.stringify(value))}\n`;
}

export function renderPlan(plan: MigrationPlan): string {
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

export function renderValidation(request: MigrationValidationRequest, includeSource = false): string {
  const lines = [renderPlan(request.plan).trimEnd(), `Validation request: ${request.id}`,
    `Profile: ${escapeTerminal(JSON.stringify(request.spec.profile))}`,
    'Actions: baseline tests, then candidate tests in separate captured copies.',
    'No dependency installation, live checkout writes, network access, or Git publication.',
    'Only captured JS/TS, Python and Java source and package manifests are available; other data/dependencies are omitted.',
    `Command in each copy: ${escapeTerminal(JSON.stringify([request.spec.profile.entrypoint, ...request.spec.profile.command, ...request.spec.testPaths.map(path => `/workspace/${path}`)]))}`,
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

export async function confirmLocalRequest(requestId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new PlumberError('INVALID_INPUT', 'Approval requires an interactive terminal; there is no implicit or piped confirmation.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Type the exact request ID to authorize one attempt (anything else cancels):\n${requestId}\n> `);
    return answer.trim() === requestId;
  } finally { terminal.close(); }
}
