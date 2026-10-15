import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { confirmLocalRequest, jsonLine } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';
import { ModelConnections, type ModelConnectionDependencies } from './model-connections.js';
import { ModelConnectionStore, readModelConnectionStatus } from './model-connections-store.js';
import { MODEL_PROBE_OUTPUT_TOKENS } from './model-http-adapter.js';
import { ModelConnectionError } from './model-failure.js';

export async function runModelConnectionsCli(args: string[], options: {
  readonly confirm?: (requestId: string) => Promise<boolean>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly dependencies?: Omit<ModelConnectionDependencies, 'persistence'>;
} = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const controller = new AbortController(), stop = (): void => { controller.abort(); };
  let store: ModelConnectionStore | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checkingLocalConnection = false;
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      state: { type: 'string' }, model: { type: 'string' }, connection: { type: 'string' },
      'allow-remote': { type: 'boolean' }, 'startup-checks': { type: 'boolean' },
    } });
    const seen = new Set<string>();
    for (const token of parsed.tokens) if (token.kind === 'option') {
      if (seen.has(token.name)) throw new PlumberError('INVALID_INPUT', 'Repeated model connection options are not supported.');
      seen.add(token.name);
    }
    const [command, action] = parsed.positionals, values = parsed.values;
    if (command !== 'model-connections' || parsed.positionals.length !== 2 || !['status', 'verify'].includes(action ?? '')
      || !values.state || !values.model || action === 'status' && [...seen].some(value => !['state', 'model'].includes(value))) {
      throw new PlumberError('INVALID_INPUT', 'Use model-connections status|verify --state <private-directory> --model <configuration.json>.');
    }
    const configuration = await loadLocalJson(values.model, 16_384);
    if (action === 'status') {
      const persisted = readModelConnectionStatus(values.state);
      const runtime = new ModelConnections(configuration, { ...options.dependencies, persistence: {
        read: id => persisted.find(state => state.id === id), write: () => { throw new Error('Read-only model status.'); },
      } });
      stdout(jsonLine({ configurationDigest: runtime.configurationDigest, mode: runtime.configuration.mode, connections: runtime.states(),
        inferencePerformed: false, freshness: 'requires-check-in-active-process' }));
      return 0;
    }
    store = await ModelConnectionStore.open(values.state);
    const runtime = new ModelConnections(configuration, { ...options.dependencies, persistence: store });
    const ids = values.connection ? [values.connection] : runtime.selectedIds();
    if (values['startup-checks'] && (ids.length !== runtime.selectedIds().length || ids.some(id => !runtime.selectedIds().includes(id)))) {
      throw new PlumberError('INVALID_INPUT', 'Startup checks must authorize every selected route together.');
    }
    const destinations = ids.map(id => {
      const { propose: _propose, ...identity } = runtime.adapter(id);
      const config = runtime.connection(id);
      return { connectionId: id, revision: config.revision, credentialRevision: config.credentialRevision,
        model: config.model, identity, maximumOutputTokens: MODEL_PROBE_OUTPUT_TOKENS };
    });
    const request = { schemaVersion: 1, scope: 'model-functional-check', configurationDigest: runtime.configurationDigest, destinations,
      privateCode: false, maximumChecks: ids.length, timeoutMs: runtime.configuration.limits.timeoutMs,
      startupChecks: values['startup-checks'] === true, idlePolling: false };
    const id = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    stdout(jsonLine({ ...request, id, authorization: 'not-granted' }));
    if (destinations.some(destination => destination.identity.location === 'remote') && values['allow-remote'] !== true) {
      throw new PlumberError('INVALID_INPUT', 'A remote functional check can incur provider charges and requires --allow-remote plus confirmation of the exact destinations.');
    }
    if (!await (options.confirm ?? confirmLocalRequest)(id)) { stdout('Connection check cancelled; no inference performed.\n'); return 1; }
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    timer = setTimeout(stop, runtime.configuration.limits.timeoutMs);
    for (const connectionId of ids) {
      checkingLocalConnection = runtime.connection(connectionId).provider === 'local-openai-compatible';
      await runtime.verify(connectionId, controller.signal, true);
    }
    if (values['startup-checks']) store.authorizeStartupProbe(runtime.configurationDigest);
    stdout(jsonLine({ connections: runtime.states(), startupChecksAuthorized: values['startup-checks'] === true, privateCodeSent: false }));
    return 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message,
      ...(error instanceof ModelConnectionError ? { failure: error.kind,
        ...(checkingLocalConnection && error.kind === 'transient' ? {
          action: 'check-local-model-service',
          hint: 'Check that the local model service is reachable and its configured model has finished loading, then verify again. Functional checks remain limited to 30 seconds.',
        } : {}),
      } : {}) }
      : { code: 'INVALID_INPUT', message: 'The local model connection command failed; no private code was sent.' } }));
    return 2;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); store?.close();
  }
}
