import { parseArgs } from 'node:util';
import { jsonLine, escapeTerminal } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { registerSourceSubscription, registerHttpSourceSubscription, observeSourcesOnce, listSourceSubscriptions, listSourceObservations } from './source-observer.js';
import type { ObservableSourceKind } from './source-observer.js';
import { loadLocalJson } from './local-file.js';
import { prepareHttpSource } from './http-source.js';

const allowed: Record<string, readonly string[]> = {
  'source-subscribe': ['state', 'kind', 'baseline', 'consumer', 'direction', 'normalize-line-endings', 'label', 'json'],
  'source-http-subscribe': ['state', 'kind', 'baseline', 'consumer', 'direction', 'normalize-line-endings', 'label', 'json'],
  'source-observe': ['state', 'subscription', 'once', 'http', 'json'],
  'source-subscriptions': ['state', 'json'],
  'source-history': ['state', 'subscription', 'json'],
};
export async function runSourceObserverCli(args: string[], options: {
  readonly stdout?: (text: string) => void; readonly stderr?: (text: string) => void;
  readonly observe?: typeof observeSourcesOnce;
} = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  function invalid(): never { throw new PlumberError('INVALID_INPUT', 'Invalid source observation arguments. Use --help for the selected command.'); }
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      state: { type: 'string' }, kind: { type: 'string' }, baseline: { type: 'string' }, consumer: { type: 'string' },
      direction: { type: 'string' }, 'normalize-line-endings': { type: 'boolean' }, label: { type: 'string' }, subscription: { type: 'string' },
      once: { type: 'boolean' }, http: { type: 'boolean' }, json: { type: 'boolean' },
    } });
    const seen = new Set<string>();
    for (const token of parsed.tokens) if (token.kind === 'option') { if (seen.has(token.name)) invalid(); seen.add(token.name); }
    const [command, sourcePath] = parsed.positionals;
    const validOptions = allowed[command ?? ''];
    const statePath = parsed.values.state;
    if (!validOptions || Object.keys(parsed.values).some(key => !validOptions.includes(key)) || !statePath?.trim()
      || parsed.positionals.length !== (command === 'source-subscribe' || command === 'source-http-subscribe' ? 2 : 1)) invalid();
    if (command === 'source-subscribe' || command === 'source-http-subscribe') {
      const kind = parsed.values.kind;
      const baselinePath = parsed.values.baseline;
      const direction = parsed.values.direction;
      if (!sourcePath?.trim() || !baselinePath?.trim() || !kind || !['mcp', 'json-schema', 'json-example', 'documentation'].includes(kind)
        || (direction !== undefined && direction !== 'input' && direction !== 'output')) invalid();
      const configuration = { statePath, kind: kind as ObservableSourceKind, baselinePath,
        ...(parsed.values.consumer === undefined ? {} : { consumerRoot: parsed.values.consumer }),
        ...(direction === undefined ? {} : { direction: direction as 'input' | 'output' }),
        ...(parsed.values['normalize-line-endings'] === undefined ? {} : { normalizeLineEndings: parsed.values['normalize-line-endings'] }),
        ...(parsed.values.label === undefined ? {} : { label: parsed.values.label }) };
      const subscription = command === 'source-http-subscribe'
        ? await registerHttpSourceSubscription({ ...configuration, source: prepareHttpSource(await loadLocalJson(sourcePath, 16 * 1024)) })
        : await registerSourceSubscription({ ...configuration, sourcePath });
      stdout(parsed.values.json ? jsonLine(subscription) : `Source subscription: ${subscription.id}\nKind: ${subscription.kind}\nConfigured baseline: ${subscription.configuredBaselineSha}\nConsumer impact, adoption and deployment remain unverified.\n`);
      return 0;
    }
    const subscriptionId = parsed.values.subscription;
    if (command === 'source-observe') {
      if (parsed.values.once !== true) invalid();
      const cycle = await (options.observe ?? observeSourcesOnce)({ statePath, ...(subscriptionId === undefined ? {} : { subscriptionId }),
        ...(parsed.values.http === undefined ? {} : { allowHttp: parsed.values.http }) });
      stdout(parsed.values.json ? jsonLine(cycle) : `Source observations: ${cycle.results.length}\n${cycle.results.map(item => `- ${item.subscriptionId}: ${item.status}`).join('\n')}\nNo consumer execution or changes were authorized.\n`);
      if (cycle.aborted) return 130;
      return cycle.results.some(item => item.status === 'failed' || item.status === 'busy') ? 2 : cycle.results.some(item => item.status === 'observed') ? 1 : 0;
    }
    if (command === 'source-subscriptions') {
      const subscriptions = await listSourceSubscriptions({ statePath });
      stdout(parsed.values.json ? jsonLine(subscriptions) : `${subscriptions.map(item => `${item.id}: ${escapeTerminal(item.label)} (${item.kind})`).join('\n')}\n`);
      return 0;
    }
    const history = await listSourceObservations({ statePath, ...(subscriptionId === undefined ? {} : { subscriptionId }) });
    stdout(parsed.values.json ? jsonLine(history) : `${history.map(item => `${item.subscriptionId} #${item.sequence}: ${item.report.status}`).join('\n')}\nHistory is evidence for review, not execution approval.\n`);
    return 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'INVALID_INPUT', message: 'Source observation failed. Check arguments and local state.' } }));
    return 2;
  }
}
