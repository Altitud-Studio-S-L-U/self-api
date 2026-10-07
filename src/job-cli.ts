import { parseArgs } from 'node:util';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';
import { confirmLocalRequest, escapeTerminal, jsonLine, renderValidation } from './cli-presentation.js';
import { approveJobValidation, listJobExecutions, prepareJobValidation, queueJobValidation, recoverApprovedJobs, runApprovedJobsOnce } from './job-validation.js';
import type { JobExecutionCycle } from './job-validation.js';

export interface JobCliOptions {
  readonly prepare?: typeof prepareJobValidation;
  readonly approve?: typeof approveJobValidation;
  readonly queue?: typeof queueJobValidation;
  readonly run?: typeof runApprovedJobsOnce;
  readonly recover?: typeof recoverApprovedJobs;
  readonly list?: typeof listJobExecutions;
  readonly confirm?: (requestId: string) => Promise<boolean>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const proposalOptions = ['state', 'engine', 'recipe', 'test'];
const commands = new Map([
  ['job-plan', new Set([...proposalOptions, 'json'])],
  ['job-approve', new Set(proposalOptions)],
  ['job-queue', new Set([...proposalOptions, 'approval', 'json'])],
  ['run-approved', new Set(['state', 'engine', 'once', 'limit', 'intent', 'json'])],
  ['recover-approved', new Set(['state', 'limit', 'json'])],
  ['executions', new Set(['state', 'json'])],
]);

function invalid(): never { throw new PlumberError('INVALID_INPUT', 'Invalid job command arguments. Use --help; run-approved requires --once.'); }

function renderCycle(cycle: JobExecutionCycle): string {
  return `${cycle.results.length} intent(s) processed.\n${cycle.results.map(result =>
    `- ${escapeTerminal(result.intentId)}: ${escapeTerminal(result.status)}; ${escapeTerminal(result.outcome?.status ?? result.reason ?? '')}\n`).join('')}Live consumer unchanged. Adoption and deployment remain unknown.\n`;
}

function cycleExit(cycle: JobExecutionCycle): number {
  if (cycle.results.some(result => result.status !== 'completed' || result.outcome?.status === 'blocked')) return 2;
  return cycle.results.some(result => result.outcome?.status !== 'passed') ? 1 : 0;
}

export async function runJobCli(args: string[], options: JobCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
        state: { type: 'string' }, engine: { type: 'string' }, recipe: { type: 'string' },
        test: { type: 'string', multiple: true }, approval: { type: 'string' },
        once: { type: 'boolean' }, limit: { type: 'string' }, intent: { type: 'string' }, json: { type: 'boolean' },
      } });
    } catch { invalid(); }
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue;
      if (token.name !== 'test' && seen.has(token.name)) invalid();
      seen.add(token.name);
    }
    const [command, jobId] = parsed.positionals;
    const allowed = commands.get(command ?? '');
    const statePath = parsed.values.state;
    const proposal = command?.startsWith('job-');
    if (!allowed || Object.keys(parsed.values).some(option => !allowed.has(option)) || !statePath?.trim()
      || parsed.positionals.length !== (proposal ? 2 : 1)) invalid();
    if (proposal) {
      const { engine: enginePath, recipe: recipePath, test: testPaths } = parsed.values;
      if (!jobId?.trim() || !enginePath?.trim() || !recipePath?.trim() || !testPaths?.length) invalid();
      const recipe = await loadLocalJson(recipePath, 1024 * 1024);
      const input = { statePath, jobId, enginePath, recipe, testPaths };
      if (command === 'job-queue') {
        const receiptId = parsed.values.approval;
        if (!receiptId?.trim()) invalid();
        const queued = await (options.queue ?? queueJobValidation)({ ...input, receiptId });
        stdout(parsed.values.json ? jsonLine(queued) : `Intent: ${escapeTerminal(queued.intent.id)} (${queued.created ? 'queued' : queued.intent.status})\nApproval has not been consumed; validation has not started.\n`);
        return 0;
      }
      const request = await (options.prepare ?? prepareJobValidation)(input);
      stdout(parsed.values.json ? jsonLine(request) : renderValidation(request, command === 'job-approve'));
      if (command === 'job-plan') return 0;
      if (!await (options.confirm ?? confirmLocalRequest)(request.id)) {
        stdout('Approval cancelled; no execution authorized.\n');
        return 1;
      }
      const receipt = await (options.approve ?? approveJobValidation)({ ...input, expectedRequestId: request.id, origin: 'local-cli' });
      stdout(`Approval receipt: ${receipt.id}\nExpires: ${receipt.expiresAt}\nQueue and execution are separate explicit actions.\n`);
      return 0;
    }
    if (command === 'executions') {
      const intents = await (options.list ?? listJobExecutions)({ statePath });
      stdout(parsed.values.json ? jsonLine(intents) : `${intents.length} execution intent(s).\n${intents.map(intent =>
        `- ${escapeTerminal(intent.id)}: ${escapeTerminal(intent.status)}; ${escapeTerminal(intent.outcome?.status ?? intent.reason ?? 'awaiting execution')}\n`).join('')}Validation status does not establish adoption or deployment.\n`);
      return 0;
    }
    const limitText = parsed.values.limit;
    if (limitText !== undefined && !/^(?:[1-9]|10)$/u.test(limitText)) invalid();
    const limit = limitText === undefined ? {} : { limit: Number(limitText) };
    let cycle: JobExecutionCycle;
    if (command === 'run-approved') {
      const { engine: enginePath, intent: intentId } = parsed.values;
      if (parsed.values.once !== true || !enginePath?.trim() || (intentId !== undefined && !intentId.trim())) invalid();
      cycle = await (options.run ?? runApprovedJobsOnce)({ statePath, enginePath, ...limit, ...(intentId !== undefined ? { intentId } : {}) });
    } else {
      cycle = await (options.recover ?? recoverApprovedJobs)({ statePath, ...limit });
    }
    stdout(parsed.values.json ? jsonLine(cycle) : renderCycle(cycle));
    return cycleExit(cycle);
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'ENGINE_FAILED', message: 'Job command failed unexpectedly.' } }));
    return 2;
  }
}
