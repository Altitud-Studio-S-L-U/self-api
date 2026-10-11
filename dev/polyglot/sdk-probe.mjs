import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanConsumer, compareOpenApi, analyzeImpact, createMigrationPlan, prepareMigrationValidation, prepareModelProposal,
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
  assert.equal(inventory.files.length, 0); assert.equal(inventory.calls.length, 0);
  assert.equal(inventory.issues.length, 2);
  assert.ok(inventory.issues.every(issue => issue.code === 'unsupported-language'));
  let stdout = '';
  assert.equal(await runCli(['scan', consumerRoot, '--json'], { stdout: text => { stdout += text; }, stderr: () => {} }), 1);
  assert.equal(JSON.parse(stdout).issues.length, 2);
  const impact = await analyzeImpact(common);
  assert.equal(impact.conclusion, 'review-required'); assert.equal(impact.matches.length, 0);
  assert.equal(impact.unmappedChangeIndexes.length, comparison.changes.length);
  const subscription = await registerLocalSubscription({ ...common, statePath, sourcePath: revisionPath, baselinePath: basePath, label: `Synthetic ${language} acceptance boundary` });
  const observed = await observeOnce({ statePath, enginePath, subscriptionId: subscription.id });
  assert.equal(observed.results[0].status, 'observed');
  const [job] = await listMaintenanceJobs({ statePath });
  assert.equal(job.status, 'review-required'); assert.equal(job.report.inventory.issues.length, 2);
  const text = await readFile(join(consumerRoot, file), 'utf8'), sha256 = createHash('sha256').update(text).digest('hex');
  const recipe = { schemaVersion: 1, summary: `Boundary check for ${language}`, decisions: [], files: [{ path: file, sha256, edits: [{ before: 'amount_minor', after: 'money' }] }] };
  await assert.rejects(createMigrationPlan({ ...common, recipe }), error => error.code === 'INVALID_INPUT' && /JavaScript or TypeScript/u.test(error.message));
  await assert.rejects(prepareMigrationValidation({ ...common, recipe, testPaths: [testPath] }), { code: 'INVALID_INPUT' });
  assert.throws(() => prepareModelProposal({ adapter: { id: 'synthetic-local-model', location: 'local', destination: 'local://fixture', policyId: 'fixture-no-disclosure' },
    files: [{ path: file, sha256, text, role: 'source' }], evidence: [] }), { code: 'INVALID_INPUT' });
  result.consumers.push({ language, scan: 'unsupported-language', cliExit: 1, impact: 'unmapped-review-required', worker: job.status,
    recipe: 'rejected-unsupported-language', selectedTests: 'rejected-unsupported-profile', modelContext: 'rejected-unsupported-language' });
}
await writeFile(join(directory, 'sdk-observation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
