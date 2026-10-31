import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerLocalSubscription, observeOnce, runWorkerLoop, listMaintenanceJobs, prepareJobValidation,
  approveJobValidation, queueJobValidation, runApprovedJobsOnce, listJobExecutions } from 'self-managed-api';
import { seedDevelopment, selectProviderVersion, fixtureRoot, repositoryRoot } from './environment.mjs';

const [command, argument, requestId, ...extra] = process.argv.slice(2);
const usage = `Local development (fictional payments only):
  pnpm dev:local seed
  pnpm dev:local version <v1|v2>
  pnpm dev:local observe
  pnpm dev:local worker
  pnpm dev:local jobs
  pnpm dev:local plan <job-id>
  pnpm dev:local validate <job-id> <reviewed-request-id>
  pnpm dev:local executions

Run seed before docker compose up -d --wait. State persists in work/local-dev.
Plan grants no approval. validate explicitly authorizes only the exact reviewed
fictional request and executes its tests on the supported Linux Docker host.
The live consumer stays unchanged. No GitHub, AI or real payments are used.
`;
const output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
if (!command || command === '--help') { process.stdout.write(usage); process.exit(0); }
try {
  const arity = { seed: 0, version: 1, observe: 0, worker: 0, jobs: 0, plan: 1, validate: 2, executions: 0 }[command];
  if (arity === undefined || extra.length || [argument, requestId].filter(value => value !== undefined).length !== arity) throw new Error(usage);
  const paths = await seedDevelopment();
  if (command === 'seed') output({ directory: paths.root, preservedExistingState: true, next: 'docker compose up -d --wait' });
  else if (command === 'version') output(await selectProviderVersion(argument));
  else {
    const enginePath = join(repositoryRoot, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
    const subscription = await registerLocalSubscription({ statePath: paths.state, consumerRoot: paths.consumer,
      sourcePath: join(paths.provider, 'current.json'), baselinePath: join(fixtureRoot, 'payments-v1.json'),
      providerBaseUrl: 'http://127.0.0.1:43127', enginePath, label: 'Fictional local payments' });
    const options = { statePath: paths.state, enginePath, subscriptionId: subscription.id };
    if (command === 'observe') output(await observeOnce(options));
    else if (command === 'worker') {
      const controller = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
      process.stdout.write('Observing fictional local contracts every 3 seconds. No execution or approval is enabled. Ctrl+C drains the current cycle.\n');
      while (!controller.signal.aborted) {
        const cycle = await runWorkerLoop({ ...options, signal: controller.signal, intervalMs: 3_000, maxCycles: 10 });
        output(cycle);
        if (!['max-cycles', 'aborted'].includes(cycle.stopReason)) { process.exitCode = 2; break; }
      }
    } else if (command === 'jobs') {
      output((await listMaintenanceJobs({ statePath: paths.state })).map(job => ({ id: job.id, status: job.status,
        createdAt: job.createdAt, version: job.report.comparison.revision.apiVersion, comparison: job.report.comparison.status,
        changes: job.report.comparison.changes.length })));
    } else if (command === 'executions') output(await listJobExecutions({ statePath: paths.state }));
    else {
      if (!/^[a-f0-9]{64}$/u.test(argument)) throw new Error('Use a job identifier from dev:local jobs.');
      const recipe = JSON.parse(await readFile(join(fixtureRoot, 'payment-recipe.json'), 'utf8'));
      const input = { statePath: paths.state, enginePath, jobId: argument, recipe, testPaths: ['payments-v2.test.mjs'] };
      const request = await prepareJobValidation(input);
      if (command === 'plan') output(request);
      else {
        if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Validation requires Linux x64. Initialize and operate this environment entirely in WSL/Linux; do not move its state between operating systems.');
        if (requestId !== request.id) throw new Error('The reviewed request no longer matches. Inspect a fresh dev:local plan before authorizing it.');
        const receipt = await approveJobValidation({ ...input, expectedRequestId: requestId, origin: 'explicit-sdk-caller' });
        const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
        const result = await runApprovedJobsOnce({ statePath: paths.state, enginePath, intentId: queued.intent.id });
        output({ result, attemptDirectory: join(paths.state, 'attempts', receipt.id), liveConsumerModified: false });
        if (result.results.some(item => item.status !== 'completed' || !['passed', 'improved'].includes(item.outcome?.status))) process.exitCode = 2;
      }
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
