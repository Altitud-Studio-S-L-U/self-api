import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { confirmLocalRequest, escapeTerminal, jsonLine, renderValidation } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { prepareJobProposal, proposeJobMigration, type JobMigrationProposal, type JobProposalRequest } from './job-proposal.js';
import { prepareJobValidation } from './job-validation.js';
import { loadLocalJson, parseLocalJson, readLocalBytes } from './local-file.js';
import { approveModelRoute, ModelConnections, normalizeModelRoutingConfiguration, prepareModelRoute, runModelRoute } from './model-connections.js';
import { ModelConnectionStore, readModelConnectionStatus } from './model-connections-store.js';
import { ModelConnectionError } from './model-failure.js';
import { createHttpModelAdapter, probeHttpModelConnection } from './model-http-adapter.js';
import { serializeMigrationRecipe, type MigrationRecipe } from './migration-recipe.js';
import { checkWindowsPermissions } from './windows-permissions.js';
import { validateRuntime } from './validation-runtime.js';

export interface JobProposalCliOptions {
  readonly confirm?: (requestId: string) => Promise<boolean>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly prepare?: typeof prepareJobProposal;
  readonly propose?: typeof proposeJobMigration;
  readonly adapter?: typeof createHttpModelAdapter;
  readonly probe?: typeof probeHttpModelConnection;
}
function invalid(message = 'Invalid proposal command arguments. Use --help.'): never { throw new PlumberError('INVALID_INPUT', message); }
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function artifactName(name: string | undefined): string {
  const selected = name ?? `${randomUUID()}.json`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/u.test(selected)) invalid('--output selects a JSON filename inside the private state/proposals directory.');
  return selected;
}
async function saveArtifact(statePath: string, requestedName: string | undefined, value: unknown): Promise<string> {
  const name = artifactName(requestedName);
  const parent = join(resolve(statePath), 'proposals');
  let created = false;
  try { await mkdir(parent, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077) !== 0) invalid('Proposal storage must be a private regular directory.');
  checkWindowsPermissions([parent], true, created ? parent : undefined);
  const output = join(parent, name), text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) invalid('Proposal artifact exceeds its bounded storage size.');
  await writeFile(output, text, { flag: 'wx', mode: 0o600 });
  return output;
}

export async function runJobProposalCli(args: string[], options: JobProposalCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const controller = new AbortController(), stop = (): void => { controller.abort(); };
  let connectionStore: ModelConnectionStore | undefined;
  try {
    let parsed;
    try { parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      state: { type: 'string' }, engine: { type: 'string' }, model: { type: 'string' },
      test: { type: 'string', multiple: true }, source: { type: 'string', multiple: true },
      evidence: { type: 'string' }, proposal: { type: 'string' }, answers: { type: 'string' }, output: { type: 'string' },
      'timeout-ms': { type: 'string' }, runtime: { type: 'string' },
      'allow-remote': { type: 'boolean' }, json: { type: 'boolean' },
    } }); } catch { invalid(); }
    const repeated = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue;
      if (!['test', 'source'].includes(token.name) && repeated.has(token.name)) invalid();
      repeated.add(token.name);
    }
    const [command, jobId] = parsed.positionals, values = parsed.values;
    const review = command === 'job-review';
    const allowed = review ? ['state', 'engine', 'proposal', 'answers', 'output', 'json', 'runtime']
      : ['state', 'engine', 'model', 'test', 'source', 'evidence', 'output', 'allow-remote', 'json', 'timeout-ms'];
    if (!['job-proposal-plan', 'job-propose', 'job-review'].includes(command ?? '')
      || Object.keys(values).some(key => !allowed.includes(key)) || parsed.positionals.length !== (review ? 1 : 2)
      || !values.state?.trim() || !values.engine?.trim()) invalid();
    if (values.output !== undefined) artifactName(values.output);
    const timeoutMs = values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']);
    if (timeoutMs !== undefined && (!/^\d+$/u.test(values['timeout-ms']!) || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1000 || timeoutMs > 120000)) invalid('Model timeout must be an integer from 1000 to 120000 milliseconds.');
    if (review) {
      if (!values.proposal?.trim() || !values.answers?.trim()) invalid();
      const proposalBytes = await readLocalBytes(values.proposal, 4 * 1024 * 1024);
      const proposal = parseLocalJson(proposalBytes) as JobMigrationProposal;
      if (!proposal || proposal.status !== 'proposal-ready' || proposal.authorization !== 'not-granted'
        || proposal.publication !== 'not-authorized' || !proposal.binding || !Array.isArray(proposal.testPaths)) {
        invalid('Only a saved unapproved proposal can be reviewed; a refusal has no substitute recipe.');
      }
      const recipe = JSON.parse(serializeMigrationRecipe(proposal.recipe)) as MigrationRecipe;
      if (!recipe.decisions.some(decision => decision.id === 'model-semantics') || recipe.decisions.some(decision => decision.answer !== undefined)) {
        invalid('Saved model proposals must retain their unanswered semantic decisions.');
      }
      const reviewInput = await loadLocalJson(values.answers, 64 * 1024) as { proposalSha256?: unknown; answers?: Record<string, unknown> };
      if (!reviewInput || reviewInput.proposalSha256 !== hash(proposalBytes) || !reviewInput.answers
        || typeof reviewInput.answers !== 'object' || Array.isArray(reviewInput.answers)
        || Object.keys(reviewInput).some(key => !['proposalSha256', 'answers'].includes(key))
        || Object.keys(reviewInput.answers).length !== recipe.decisions.length) invalid('Review answers must identify the exact proposal digest and every pending question.');
      const answers = reviewInput.answers;
      const reviewedRecipe = { ...recipe, decisions: recipe.decisions.map(decision => {
        const answer = answers[decision.id];
        if (typeof answer !== 'string' || !answer.trim() || Buffer.byteLength(answer) > 4096) invalid('Every semantic question needs an explicit bounded reviewer answer.');
        return { ...decision, answer };
      }) };
      const request = await prepareJobValidation({ statePath: values.state, jobId: proposal.binding.jobId,
        enginePath: values.engine, recipe: reviewedRecipe, testPaths: proposal.testPaths,
        ...(values.runtime ? { runtime: validateRuntime(await loadLocalJson(values.runtime, 16 * 1024)) } : {}) });
      if (request.plan.evidence.consumerDigest !== proposal.binding.consumerDigest
        || request.plan.evidence.baseSha256 !== proposal.binding.baselineSha256
        || request.plan.evidence.revisionSha256 !== proposal.binding.revisionSha256
        || request.plan.impact.comparison.engine.version !== proposal.binding.engineVersion) invalid('Proposal binding changed; prepare from current evidence again.');
      const artifactPath = await saveArtifact(values.state, values.output, reviewedRecipe);
      stdout(values.json ? jsonLine({ artifactPath, recipeSha256: hash(serializeMigrationRecipe(reviewedRecipe)), request, authorization: 'not-granted' })
        : `${renderValidation(request)}Reviewed recipe: ${escapeTerminal(artifactPath)}\nValidation approval, queueing and publication remain separate commands.\n`);
      return 0;
    }
    if (!jobId?.trim() || !values.model?.trim() || !values.test?.length) invalid('Select an observed job, model configuration and read-only tests.');
    if (command === 'job-proposal-plan' && (values.output !== undefined || values['allow-remote'] !== undefined)) invalid();
    const configuration = normalizeModelRoutingConfiguration(await loadLocalJson(values.model, 16_384));
    if (command === 'job-propose') connectionStore = await ModelConnectionStore.open(values.state);
    const diagnosticStates = connectionStore ? [] : readModelConnectionStatus(values.state);
    const runtime = new ModelConnections({ ...configuration,
      ...(timeoutMs === undefined ? {} : { limits: { ...configuration.limits, timeoutMs } }) }, {
      ...(options.adapter ? { adapter: options.adapter } : {}), ...(options.probe ? { probe: options.probe } : {}),
      persistence: connectionStore ?? { read: id => diagnosticStates.find(state => state.id === id), write: () => { throw new Error('Planning is read-only.'); } },
    });
    const evidence = values.evidence === undefined ? undefined : [{ id: 'local-reviewed-evidence', text: (await readLocalBytes(values.evidence, 256 * 1024)).toString('utf8') }];
    const requests: JobProposalRequest[] = [];
    const { maximumTotalOutputTokens: _maximumTotalOutputTokens, ...limits } = runtime.configuration.limits;
    for (const id of runtime.selectedIds()) {
      const { propose: _propose, ...identity } = runtime.adapter(id);
      requests.push(await (options.prepare ?? prepareJobProposal)({ statePath: values.state, jobId, enginePath: values.engine,
        adapter: identity, testPaths: values.test, limits,
        ...(values.source ? { sourcePaths: values.source } : {}), ...(evidence ? { evidence } : {}) }));
    }
    const route = prepareModelRoute(runtime, requests.map(request => request.modelRequest));
    stdout(jsonLine({ route, jobs: requests }));
    if (command === 'job-proposal-plan') return 0;
    const remote = route.attempts.some(attempt => attempt.request.adapter.location === 'remote');
    if (remote && values['allow-remote'] !== true) invalid('Remote model disclosure requires --allow-remote and terminal confirmation of every destination, functional check and limit in this exact request.');
    if (!await (options.confirm ?? confirmLocalRequest)(route.id)) {
      stdout('Model consent cancelled; no provider call or execution authorized.\n'); return 1;
    }
    const consent = approveModelRoute({ request: route, expectedRequestId: route.id, ...(remote ? { allowRemote: true } : {}) });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const routed = await runModelRoute({ request: route, consent, signal: controller.signal, onAlert: alert => { stderr(jsonLine({ modelAlert: alert })); },
      execute: async (modelRequest, consent, adapter, signal) => {
        const request = requests.find(request => request.modelRequest === modelRequest);
        if (!request) invalid('The approved route is not bound to this observed job.');
        return (options.propose ?? proposeJobMigration)({ request, expectedRequestId: request.id, consent, adapter, signal });
      } });
    const { outcome: proposal, ...routing } = routed;
    const artifactPath = await saveArtifact(values.state, values.output, proposal);
    const proposalSha256 = hash(JSON.stringify(proposal, null, 2) + '\n');
    const questions = proposal.status === 'proposal-ready' ? proposal.recipe.decisions : proposal.decisions;
    stdout(jsonLine({ artifactPath, proposalSha256, proposal, routing, reviewTemplate: {
      proposalSha256, answers: Object.fromEntries(questions.map(decision => [decision.id, ''])),
    }, authorization: 'not-granted', publication: 'not-authorized' }));
    return proposal.status === 'decision-required' ? 1 : 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message,
      ...(error instanceof ModelConnectionError ? { failure: error.kind } : {}) }
      : { code: 'INVALID_INPUT', message: 'Proposal command could not complete; no execution or publication was authorized.' } }));
    return 2;
  } finally { controller.abort(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); connectionStore?.close(); }
}
