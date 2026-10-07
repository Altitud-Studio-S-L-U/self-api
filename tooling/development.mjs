import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deliveryFile = new URL('./delivery.json', import.meta.url);
const statuses = new Set(['planned', 'in-progress', 'in-review', 'completed']);
const usage = 'Usage: pnpm dev | pnpm dev:check\n';

async function readDelivery() {
  const delivery = JSON.parse(await readFile(deliveryFile, 'utf8'));
  if (delivery.schemaVersion !== 1 || !Array.isArray(delivery.items) || delivery.items.length === 0) {
    throw new Error('Unsupported delivery manifest.');
  }
  const identifiers = new Set();
  let active = 0;
  for (const item of delivery.items) {
    if (!item || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(item.id) ||
      identifiers.has(item.id) || typeof item.title !== 'string' || item.title.trim() === '' ||
      !statuses.has(item.status) || !Array.isArray(item.acceptance) || item.acceptance.length === 0 ||
      item.acceptance.some(criterion => typeof criterion !== 'string' || criterion.trim() === '') ||
      (item.pullRequest !== undefined && (typeof item.pullRequest !== 'string' || !item.pullRequest.startsWith('https://github.com/')))) {
      throw new Error('Invalid delivery item.');
    }
    identifiers.add(item.id);
    if (item.status === 'in-progress') active += 1;
  }
  if (active > 1) throw new Error('Choose one active implementation milestone.');
  return delivery;
}

function renderStatus(delivery) {
  const lines = ['Plumber development', ''];
  for (const [index, item] of delivery.items.entries()) {
    lines.push(`${index + 1}. [${item.status}] ${item.title}`);
  }
  const pendingReviews = delivery.items.filter(item => item.status === 'in-review');
  if (pendingReviews.length > 0) {
    lines.push('', 'Pending review:');
    for (const item of pendingReviews) lines.push(`- ${item.id}${item.pullRequest ? `: ${item.pullRequest}` : ''}`);
  }
  const next = delivery.items.find(item => item.status === 'in-progress') ??
    delivery.items.find(item => item.status === 'planned');
  lines.push('');
  if (next) {
    lines.push(`Next implementation: ${next.id}`, next.title, 'Acceptance:');
    for (const criterion of next.acceptance) lines.push(`- ${criterion}`);
  } else {
    lines.push('No implementation milestone is pending. Review any open pull requests separately.');
  }
  lines.push('', 'Validation: pnpm dev:check',
    'Resume: review the current branch and diff, then continue this milestone using docs/implementation-plan.md section 12.',
    'Delivery status is reviewed manually; passing checks does not complete a milestone.');
  return `${lines.join('\n')}\n`;
}

function runProjectChecks() {
  return new Promise((resolveExit, reject) => {
    // Only this fixed, repository-owned command reaches the shell; CLI input is never interpolated.
    const child = spawn('pnpm run check', {
      cwd: projectRoot,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code ?? 1));
  });
}

export async function runDevelopment(args, options = {}) {
  const stdout = options.stdout ?? (text => { process.stdout.write(text); });
  const stderr = options.stderr ?? (text => { process.stderr.write(text); });
  const command = args[0] ?? 'status';
  if (args.length > 1 || !['status', 'check', '--help', '-h'].includes(command)) {
    stderr(usage);
    return 2;
  }
  if (command === '--help' || command === '-h') {
    stdout(usage);
    return 0;
  }
  if (command === 'status') {
    try {
      stdout(renderStatus(await readDelivery()));
      return 0;
    } catch {
      stderr('Cannot read the delivery plan. Check tooling/delivery.json before continuing.\n');
      return 2;
    }
  }
  try {
    const code = await (options.runCheck ?? runProjectChecks)();
    if (code === 0) stdout('Checks passed. Delivery statuses were not changed.\n');
    else stderr(`Checks failed (exit ${code}). Delivery statuses were not changed.\n`);
    return code;
  } catch {
    stderr('Could not run the development checks. Delivery statuses were not changed.\n');
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runDevelopment(process.argv.slice(2));
