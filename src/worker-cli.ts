import { parseArgs } from 'node:util';
import { PlumberError } from './errors.js';
import { listLocalSubscriptions, listMaintenanceJobs, observeOnce, registerLocalSubscription } from './worker.js';

export interface WorkerCliOptions {
  readonly register?: typeof registerLocalSubscription;
  readonly observe?: typeof observeOnce;
  readonly subscriptions?: typeof listLocalSubscriptions;
  readonly jobs?: typeof listMaintenanceJobs;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

type Subscription = Awaited<ReturnType<typeof listLocalSubscriptions>>[number];
type Job = Awaited<ReturnType<typeof listMaintenanceJobs>>[number];
type Observation = Awaited<ReturnType<typeof observeOnce>>;

const commandOptions = new Map<string, ReadonlySet<string>>([
  ['subscribe', new Set(['baseline', 'consumer', 'provider-base-url', 'engine', 'state', 'label', 'json'])],
  ['worker', new Set(['once', 'engine', 'state', 'subscription', 'json'])],
  ['subscriptions', new Set(['state', 'json'])],
  ['jobs', new Set(['state', 'json'])],
]);

function escapeTerminal(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function jsonLine(value: unknown): string {
  return `${escapeTerminal(JSON.stringify(value))}\n`;
}

function invalid(): never {
  throw new PlumberError('INVALID_INPUT', 'Invalid worker command arguments. Use --help for the required options; worker requires --once.');
}

function renderSubscriptions(subscriptions: readonly Subscription[], registered = false): string {
  const lines = [registered ? 'Subscription registered.' : `Subscriptions: ${subscriptions.length}`];
  for (const subscription of subscriptions) {
    lines.push(`- ${escapeTerminal(subscription.id)}: ${escapeTerminal(subscription.label)}`,
      `  Configured baseline: ${escapeTerminal(subscription.configuredBaselineSha)}`,
      `  Last observed: ${escapeTerminal(subscription.lastObservedSha ?? '(not observed)')}`);
  }
  lines.push('Adoption: unknown. Deployment: unknown.');
  return `${lines.join('\n')}\n`;
}

function renderJobs(jobs: readonly Job[]): string {
  const lines = [`Maintenance jobs: ${jobs.length}`];
  for (const job of jobs) {
    lines.push(`- ${escapeTerminal(job.id)}: ${escapeTerminal(job.status)}; subscription ${escapeTerminal(job.subscriptionId)}`,
      `  Baseline: ${escapeTerminal(job.baselineSha)} -> revision: ${escapeTerminal(job.revisionSha)}`,
      `  Consumer digest: ${escapeTerminal(job.consumerDigest)}`);
  }
  lines.push('Jobs require review. No migration or execution is authorized by observation.');
  return `${lines.join('\n')}\n`;
}

function renderObservation(observation: Observation): string {
  const lines = [`Observation pass: ${observation.results.length} subscription(s)`];
  for (const result of observation.results) {
    lines.push(`- ${escapeTerminal(result.subscriptionId)}: ${escapeTerminal(result.status)}${result.jobId ? `; job ${escapeTerminal(result.jobId)}` : ''}`);
  }
  lines.push('Observation only. No approval, consumer execution, or publication.');
  return `${lines.join('\n')}\n`;
}

export async function runWorkerCli(args: string[], options: WorkerCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        tokens: true,
        options: {
          baseline: { type: 'string' },
          consumer: { type: 'string' },
          'provider-base-url': { type: 'string' },
          engine: { type: 'string' },
          state: { type: 'string' },
          label: { type: 'string' },
          once: { type: 'boolean' },
          subscription: { type: 'string' },
          json: { type: 'boolean' },
        },
      });
    } catch (error) {
      throw new PlumberError('INVALID_INPUT', error instanceof Error ? error.message : 'Invalid worker command arguments.');
    }
    const seenOptions = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue;
      if (seenOptions.has(token.name)) invalid();
      seenOptions.add(token.name);
    }
    const [command, sourcePath] = parsed.positionals;
    const allowed = commandOptions.get(command ?? '');
    const statePath = parsed.values.state;
    if (!allowed || Object.keys(parsed.values).some(option => !allowed.has(option)) || !statePath?.trim()
      || parsed.positionals.length !== (command === 'subscribe' ? 2 : 1)) invalid();

    if (command === 'subscribe') {
      const baselinePath = parsed.values.baseline;
      const consumerRoot = parsed.values.consumer;
      const providerBaseUrl = parsed.values['provider-base-url'];
      const enginePath = parsed.values.engine;
      const label = parsed.values.label;
      if (!sourcePath?.trim() || !baselinePath?.trim() || !consumerRoot?.trim() || !providerBaseUrl?.trim()
        || !enginePath?.trim() || (label !== undefined && !label.trim())) invalid();
      const subscription = await (options.register ?? registerLocalSubscription)({
        statePath, sourcePath, baselinePath, consumerRoot, providerBaseUrl, enginePath,
        ...(label !== undefined ? { label } : {}),
      });
      stdout(parsed.values.json ? jsonLine(subscription) : renderSubscriptions([subscription], true));
      return 0;
    }
    if (command === 'worker') {
      const enginePath = parsed.values.engine;
      const subscriptionId = parsed.values.subscription;
      if (parsed.values.once !== true || !enginePath?.trim() || (subscriptionId !== undefined && !subscriptionId.trim())) invalid();
      const observation = await (options.observe ?? observeOnce)({
        statePath, enginePath, ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      });
      stdout(parsed.values.json ? jsonLine(observation) : renderObservation(observation));
      if (observation.results.some(result => result.status === 'failed' || result.status === 'busy')) return 2;
      return observation.results.some(result => result.jobId) ? 1 : 0;
    }
    if (command === 'subscriptions') {
      const subscriptions = await (options.subscriptions ?? listLocalSubscriptions)({ statePath });
      stdout(parsed.values.json ? jsonLine(subscriptions) : renderSubscriptions(subscriptions));
      return 0;
    }
    const jobs = await (options.jobs ?? listMaintenanceJobs)({ statePath });
    stdout(parsed.values.json ? jsonLine(jobs) : renderJobs(jobs));
    return 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError
      ? { code: error.code, message: error.message }
      : { code: 'ENGINE_FAILED', message: 'Worker command failed unexpectedly.' },
    }));
    return 2;
  }
}
