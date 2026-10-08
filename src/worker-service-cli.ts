import { parseArgs } from 'node:util';
import { jsonLine } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';
import { renderWorkerServiceManifest, type WorkerServiceTarget } from './worker-service-config.js';
import { loadWorkerServiceConfig, readWorkerServiceStatus, requestWorkerServiceStop, runWorkerService } from './worker-service.js';

export async function runWorkerServiceCli(args: string[], options: { readonly stdout?: (text: string) => void; readonly stderr?: (text: string) => void } = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); };
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      config: { type: 'string' }, target: { type: 'string' }, node: { type: 'string' }, cli: { type: 'string' }, user: { type: 'string' }, name: { type: 'string' }, scope: { type: 'string' },
    } });
    const seen = new Set<string>();
    for (const token of parsed.tokens) if (token.kind === 'option') {
      if (seen.has(token.name)) throw new PlumberError('INVALID_INPUT', 'Repeated service options are not supported.');
      seen.add(token.name);
    }
    const action = parsed.positionals[1];
    if (parsed.positionals.length !== 2 || parsed.positionals[0] !== 'worker-service' || !action
      || !['run', 'render', 'status', 'stop'].includes(action) || !parsed.values.config) {
      throw new PlumberError('INVALID_INPUT', 'worker-service requires run, render, status or stop and --config.');
    }
    if (action === 'render') {
      const value = await loadLocalJson(parsed.values.config, 64 * 1024);
      stdout(renderWorkerServiceManifest({ config: value, configPath: parsed.values.config, target: parsed.values.target as WorkerServiceTarget,
        nodePath: parsed.values.node!, cliPath: parsed.values.cli!, ...(parsed.values.user !== undefined ? { user: parsed.values.user } : {}),
        ...(parsed.values.scope !== undefined ? { scope: parsed.values.scope as 'system' | 'user' } : {}),
        ...(parsed.values.name ? { name: parsed.values.name } : {}) }));
      return 0;
    }
    if ([...seen].some(key => key !== 'config')) throw new PlumberError('INVALID_INPUT', 'Runtime service commands accept only --config.');
    if (action === 'run') { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
    const config = await loadWorkerServiceConfig(parsed.values.config);
    if (action === 'status') {
      const status = readWorkerServiceStatus(config);
      stdout(jsonLine({ status: status ?? null, liveness: 'consult-native-service-manager' }));
      return status ? 0 : 2;
    }
    if (action === 'stop') { stdout(jsonLine(requestWorkerServiceStop(config))); return 0; }
    await runWorkerService(config, { signal: controller.signal });
    return 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'SERVICE_FAILED', message: 'Worker service could not complete its local operation. Inspect the native manager and private status log.' } }));
    return 2;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
