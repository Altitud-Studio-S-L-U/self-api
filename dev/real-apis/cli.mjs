import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { observeOnce, observeSourcesOnce, listMaintenanceJobs, listSourceSubscriptions, prepareJobValidation,
  approveJobValidation, queueJobValidation, runApprovedJobsOnce, listJobExecutions, CloudConnectionError } from 'keepseam-client';
import { providers } from './catalog.mjs';
import { seed, selectVersion, registerNotion, migrationRecipe, fetchDocumentation, inventory, enginePath } from './environment.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const usage = `Keepseam real API documentation / simulated provider lab
  pnpm dev:apis catalog | seed | inventory | fetch-docs | observe | jobs | executions
  pnpm dev:apis version <2022-06-28|2025-09-03>
  pnpm dev:apis plan <job-id>
  pnpm dev:apis validate <job-id> <reviewed-request-id>
  pnpm dev:apis cloud-sync <private-credentials-file>
  pnpm dev:apis worker [private-credentials-file]
  pnpm dev:apis serve

fetch-docs explicitly downloads ten public official pages; failures remain failures.
observe contacts only registered documentation origins, analyzes local exercise contracts,
and never runs consumer code. validate authorizes the displayed exact lab request;
consumer execution requires the supported Linux Docker host. No live checkout is changed.
Cloud receives only protocol status, never source or documentation. Local observation continues
when Cloud is unavailable; a local observation failure stops this development supervisor.
`;

async function sync(paths, credentialPath) {
  const { syncWorkerToCloud } = await import('keepseam-client');
  const credentials = JSON.parse(await readFile(resolve(credentialPath), 'utf8'));
  const subscription = await registerNotion(paths);
  return syncWorkerToCloud({ statePath: paths.state, cloudStatePath: join(paths.root, 'cloud'), credentials, integrationIds: [subscription.id] });
}

try {
  if (command === 'help' || command === '--help') process.stdout.write(usage);
  else if (command === 'catalog' && args.length === 0) print(providers);
  else {
    const arities = { seed: [0], inventory: [0], 'fetch-docs': [0], observe: [0], jobs: [0], executions: [0],
      version: [1], plan: [1], validate: [2], 'cloud-sync': [1], worker: [0, 1], serve: [0] };
    if (!arities[command]?.includes(args.length)) throw new Error(usage);
    const paths = await seed();
    if (command === 'seed') print({ root: paths.root, providers: providers.length, next: 'pnpm dev:apis fetch-docs' });
    else if (command === 'inventory') print(await inventory(paths));
    else if (command === 'version') print(await selectVersion(args[0]));
    else if (command === 'fetch-docs') {
      const results = await fetchDocumentation(paths, print);
      if (results.some(value => value.status === 'failed')) process.exitCode = 2;
    } else if (command === 'serve') {
      const { serve } = await import('./server.mjs');
      await serve(paths);
    } else if (command === 'cloud-sync') print(await sync(paths, args[0]));
    else {
      const subscription = await registerNotion(paths);
      const options = { statePath: paths.state, enginePath, subscriptionId: subscription.id };
      const observe = async () => {
        const maintenance = await observeOnce(options);
        const sources = await listSourceSubscriptions({ statePath: paths.state });
        const documentation = sources.length ? await observeSourcesOnce({ statePath: paths.state, allowHttp: true }) : { results: [] };
        return { maintenance, documentation };
      };
      if (command === 'observe') print(await observe());
      else if (command === 'worker') {
        const controller = new AbortController();
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
        process.stdout.write('Lab worker active. Local contracts every 15s; documentation every 15 minutes. No automatic execution.\n');
        let docsAt = 0, cloudAt = 0;
        while (!controller.signal.aborted) {
          const cycle = await observeOnce({ ...options, signal: controller.signal });
          print(cycle);
          if (cycle.results.some(value => value.status === 'failed')) { process.exitCode = 2; break; }
          if (Date.now() >= docsAt) {
            const sources = await listSourceSubscriptions({ statePath: paths.state });
            const documentation = sources.length
              ? await observeSourcesOnce({ statePath: paths.state, allowHttp: true, signal: controller.signal })
              : { results: [] };
            print(documentation);
            if (documentation.results.some(value => value.status === 'failed')) { process.exitCode = 2; break; }
            docsAt = Date.now() + 15 * 60_000;
          }
          if (args[0] && Date.now() >= cloudAt) {
            try { print(await sync(paths, args[0])); }
            catch (error) {
              if (!(error instanceof CloudConnectionError)) throw error;
              const terminal = ['AUTHORIZATION_REJECTED', 'STATUS_REJECTED', 'INVALID_CONFIGURATION'].includes(error.code);
              cloudAt = terminal ? Infinity : Date.now() + 60_000;
              print({ cloud: terminal ? 'reconnect-required' : 'unavailable', code: error.code, localObservation: 'continues', retryAfterSeconds: terminal ? null : 60 });
            }
          }
          const { setTimeout } = await import('node:timers/promises');
          try { await setTimeout(15_000, undefined, { signal: controller.signal }); } catch { break; }
        }
      } else if (command === 'jobs') print(await listMaintenanceJobs({ statePath: paths.state }));
      else if (command === 'executions') print(await listJobExecutions({ statePath: paths.state }));
      else {
        const recipe = await migrationRecipe(paths);
        const input = { statePath: paths.state, enginePath, jobId: args[0], recipe, testPaths: ['notion.test.mjs'] };
        const request = await prepareJobValidation(input);
        if (command === 'plan') print(request);
        else {
          if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Initialize this lab in a Linux filesystem and run its validation there with the supported Docker host. Do not move Windows worker state.');
          if (args[1] !== request.id) throw new Error('The reviewed request no longer matches. Review a new plan.');
          const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
          const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
          const result = await runApprovedJobsOnce({ statePath: paths.state, enginePath, intentId: queued.intent.id });
          print({ result, attemptDirectory: join(paths.state, 'attempts', receipt.id), liveConsumerModified: false });
          if (result.results.some(value => value.status !== 'completed' || !['passed', 'improved'].includes(value.outcome?.status))) process.exitCode = 2;
        }
      }
    }
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
