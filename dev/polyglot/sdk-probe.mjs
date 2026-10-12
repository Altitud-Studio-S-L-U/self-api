import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanConsumer, compareOpenApi, analyzeImpact, createMigrationPlan, prepareModelProposal, prepareJobValidation, approveJobValidation, queueJobValidation, runApprovedJobsOnce,
  registerLocalSubscription, observeOnce, listMaintenanceJobs } from 'keepseam-client';
import { runCli } from 'keepseam-client/cli';

const [output, enginePath, sourceRepo] = process.argv.slice(2);
const directory = resolve(output), installed = await realpath(join(import.meta.dirname, 'node_modules'));
const entry = await realpath(fileURLToPath(import.meta.resolve('keepseam-client')));
const relativeEntry = relative(installed, entry), relativeRepo = relative(resolve(sourceRepo), entry);
assert.ok(relativeEntry && !isAbsolute(relativeEntry) && !relativeEntry.startsWith(`..${sep}`));
assert.ok(relativeRepo === '..' || relativeRepo.startsWith(`..${sep}`) || isAbsolute(relativeRepo), 'SDK must be installed outside the source checkout');
const basePath = join(directory, 'contracts/A.json'), revisionPath = join(directory, 'contracts/B.json');
const comparison = await compareOpenApi({ basePath, revisionPath, enginePath });
assert.equal(comparison.status, 'breaking-changes');
assert.ok(comparison.changes.some(change => /amount_minor/u.test(change.text)));
const result = { sdkEntry: entry, installedOutsideCheckout: true, structuralChanges: comparison.changes.length, consumers: [] };
for (const [language, file, testPath] of [['python', 'payment_client.py', 'test_payment.py'], ['java', 'PaymentClient.java', 'PaymentTest.java']]) {
  const consumerRoot = join(directory, `${language}-baseline`), statePath = join(directory, `${language}-worker`);
  const common = { basePath, revisionPath, enginePath, consumerRoot, providerBaseUrl: 'http://127.0.0.1:1' };
  const inventory = await scanConsumer(consumerRoot);
  assert.equal(inventory.files.length, 2); assert.equal(inventory.calls.length, 0);
  assert.equal(inventory.issues.length, 2);
  assert.ok(inventory.issues.every(issue => issue.code === 'unsupported-language'));
  let stdout = '';
  assert.equal(await runCli(['scan', consumerRoot, '--json'], { stdout: text => { stdout += text; }, stderr: () => {} }), 1);
  assert.equal(JSON.parse(stdout).issues.length, 2);
  const impact = await analyzeImpact(common);
  assert.equal(impact.conclusion, 'review-required'); assert.equal(impact.matches.length, 0);
  assert.equal(impact.unmappedChangeIndexes.length, comparison.changes.length);
  assert.equal(process.platform, 'linux', 'Actual SDK isolated validation requires a Linux x64 host.');
  const entrypoint = language === 'python' ? 'payment_contract_test.py' : 'PaymentContractTest.java';
  const wrapper = language === 'python'
    ? 'import subprocess, sys, unittest\nfrom pathlib import Path\nclass PaymentContractTests(unittest.TestCase):\n    def test_unchanged_contract(self):\n        result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("test_payment.py")), "B"], capture_output=True, text=True, timeout=10)\n        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)\n'
    : 'public class PaymentContractTest { public static void main(String[] args) throws Exception { PaymentTest.main(new String[] {"B"}); } }\n';
  await writeFile(join(consumerRoot, entrypoint), wrapper, { flag: 'wx' });
  const subscription = await registerLocalSubscription({ ...common, statePath, sourcePath: revisionPath, baselinePath: basePath, label: `Synthetic ${language} acceptance boundary` });
  const observed = await observeOnce({ statePath, enginePath, subscriptionId: subscription.id });
  assert.equal(observed.results[0].status, 'observed');
  const [job] = await listMaintenanceJobs({ statePath });
  assert.equal(job.status, 'review-required'); assert.equal(job.report.inventory.issues.length, 3);
  const text = await readFile(join(consumerRoot, file), 'utf8'), sha256 = createHash('sha256').update(text).digest('hex');
  const after = await readFile(join(directory, `${language}-candidate`, file), 'utf8');
  const recipe = { schemaVersion: 1, summary: `Operator-reviewed synthetic ${language} fixture; not a model-generated recipe.`, decisions: [],
    files: [{ path: file, sha256, edits: [{ before: text, after }] }] };
  assert.equal((await createMigrationPlan({ ...common, recipe })).validation, 'not-run');
  const testBytes = await readFile(join(consumerRoot, testPath), 'utf8');
  const modelRequest = prepareModelProposal({ adapter: { id: 'synthetic-local-model', location: 'local', destination: 'local:fixture', policyId: 'fixture-no-disclosure' },
    files: [{ path: file, sha256, text, role: 'source' }, { path: testPath, sha256: createHash('sha256').update(testBytes).digest('hex'), text: testBytes, role: 'test' }], evidence: [] });
  assert.equal(modelRequest.authorization, 'not-granted');
  const input = { statePath, jobId: job.id, enginePath, recipe, testPaths: [entrypoint] };
  const request = await prepareJobValidation(input);
  assert.equal(request.spec.profile.id, language === 'python' ? 'python313-linux-amd64-v1' : 'java25-linux-amd64-v1');
  const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
  const cycle = await runApprovedJobsOnce({ statePath, enginePath, intentId: queued.intent.id });
  assert.equal(cycle.results[0].status, 'completed', JSON.stringify(cycle));
  const outcome = cycle.results[0].outcome;
  assert.equal(outcome.status, 'improved', JSON.stringify(outcome));
  assert.equal(outcome.baseline.status, 'failed'); assert.equal(outcome.candidate.status, 'passed');
  assert.equal(outcome.baseline.cleanup, 'removed'); assert.equal(outcome.candidate.cleanup, 'removed');
  assert.equal(outcome.publication, 'not-authorized');
  assert.equal(await readFile(join(consumerRoot, file), 'utf8'), text);
  const attempt = join(statePath, 'attempts', receipt.id);
  for (const phase of ['baseline', 'candidate']) {
    assert.equal(await readFile(join(attempt, phase, testPath), 'utf8'), testBytes);
    assert.equal(await readFile(join(attempt, phase, entrypoint), 'utf8'), wrapper);
  }
  result.consumers.push({ language, scan: 'unsupported-language', cliExit: 1, impact: 'unmapped-review-required', worker: job.status,
    recipe: 'explicit-reviewed-source', selectedTests: 'same-bytes-baseline-and-candidate', modelContext: 'explicit-source-and-readonly-test-no-inference',
    profile: request.spec.profile.id, requestId: request.id, receiptId: receipt.id, intentId: queued.intent.id, validation: outcome.status,
    baselineExit: outcome.baseline.exitCode, candidateExit: outcome.candidate.exitCode, consumerModified: false, publication: 'not-authorized' });
}
await writeFile(join(directory, 'sdk-observation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
