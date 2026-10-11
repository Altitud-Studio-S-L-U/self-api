import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServiceFixture } from './service-fixture.mjs';
import { assertWindowsServiceFixtureAcl, provisionWindowsServiceFixture, readWindowsServiceEvidence } from './service-native-windows-fixture.mjs';
import { observeSourcesOnce } from '../dist/index.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';

if (process.platform === 'win32') {
  // ACL ownership transfer is exercised only in an elevated disposable runner.
  // This test never installs or invokes SCM, so administrator fixture checks can
  // also be run explicitly without affecting any workstation service.
  test('native fixture transfers private state to LocalService and preserves read-only evidence without trusting the seeding user', async t => {
    const parent = resolve('work/test-native-windows-fixture'); await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(await realpath(parent), 'case-'));
    t.after(async () => {
      assert.equal(dirname(await realpath(directory)), await realpath(parent));
      await rm(directory, { recursive: true });
    });
    const fixture = await createServiceFixture(directory);
    const cycle = await observeSourcesOnce({ statePath: fixture.statePath });
    assert.equal(cycle.results[0].status, 'observed');
    const database = join(fixture.statePath, 'source-observations.sqlite3');
    const sourceBytes = await readFile(database), workerBytes = await readFile(join(fixture.statePath, 'worker.sqlite3'));
    // The seeding account's ACL is valid for that account, but not LocalService.
    await assert.rejects(assertWindowsServiceFixtureAcl(fixture.statePath), /owner is not a service principal|outside its service principals/);
    await provisionWindowsServiceFixture(directory, fixture);
    await assertWindowsServiceFixtureAcl(fixture.statePath);
    checkWindowsPermissions([fixture.configPath], false);
    const evidence = await readWindowsServiceEvidence(fixture.statePath, fixture.subscriptionId);
    assert(evidence.subscription.lastSucceededAt);
    assert.equal(evidence.subscription.lastError, null);
    assert.equal(evidence.observations.length, 1);
    assert.equal(evidence.jobs, 0); assert.equal(evidence.executionIntents, 0);
    assert.deepEqual(await readFile(database), sourceBytes);
    assert.deepEqual(await readFile(join(fixture.statePath, 'worker.sqlite3')), workerBytes);
    for (const path of [fixture.statePath, database]) {
      execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
      try {
        const permissions = execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true });
        await assert.rejects(readWindowsServiceEvidence(fixture.statePath, fixture.subscriptionId), /outside its service principals/);
        assert.equal(execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true }), permissions);
        assert.deepEqual(await readFile(database), sourceBytes);
      } finally { execFileSync('icacls.exe', [path, '/remove:g', '*S-1-1-0'], { windowsHide: true, stdio: 'pipe' }); }
    }
    assert.deepEqual((await readWindowsServiceEvidence(fixture.statePath, fixture.subscriptionId)).observations, evidence.observations);
  });
}
