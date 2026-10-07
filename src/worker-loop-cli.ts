import { parseArgs } from 'node:util';
import { jsonLine } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { runWorkerLoop } from './worker-loop.js';

export async function runWorkerLoopCli(args: string[], options: {
  readonly loop?: typeof runWorkerLoop;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
} = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); };
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      state: { type: 'string' }, engine: { type: 'string' }, subscription: { type: 'string' },
      cycles: { type: 'string' }, 'interval-ms': { type: 'string' }, 'run-approved': { type: 'boolean' }, json: { type: 'boolean' },
    } });
    const seen = new Set<string>();
    for (const token of parsed.tokens) if (token.kind === 'option') {
      if (seen.has(token.name)) throw new PlumberError('INVALID_INPUT', 'Repeated worker-loop options are not supported.');
      seen.add(token.name);
    }
    if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'worker-loop' || !parsed.values.state?.trim() || !parsed.values.engine?.trim()
      || [parsed.values.cycles, parsed.values['interval-ms']].some(value => value !== undefined && !/^\d+$/u.test(value))) {
      throw new PlumberError('INVALID_INPUT', 'worker-loop requires --state and --engine, with optional bounded --cycles and --interval-ms.');
    }
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const result = await (options.loop ?? runWorkerLoop)({ statePath: parsed.values.state, enginePath: parsed.values.engine, signal: controller.signal,
      ...(parsed.values.subscription === undefined ? {} : { subscriptionId: parsed.values.subscription }),
      ...(parsed.values.cycles === undefined ? {} : { maxCycles: Number(parsed.values.cycles) }),
      ...(parsed.values['interval-ms'] === undefined ? {} : { intervalMs: Number(parsed.values['interval-ms']) }),
      processApprovedJobs: parsed.values['run-approved'] ?? false });
    stdout(parsed.values.json ? jsonLine(result) : `Worker stopped: ${result.stopReason}\nCompleted cycles: ${result.cycles.length}\nNo new approval was granted.\n`);
    if (result.stopReason === 'aborted') return 130;
    if (result.stopReason !== 'max-cycles') return 2;
    if (result.cycles.some(cycle => cycle.observation.status !== 'completed' || cycle.observation.counts.busy > 0 || cycle.observation.counts.failed > 0)) return 2;
    return result.cycles.some(cycle => cycle.observation.counts.observed > 0) ? 1 : 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'INVALID_INPUT', message: 'Worker loop could not start with the supplied arguments.' } }));
    return 2;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
