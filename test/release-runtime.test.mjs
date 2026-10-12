import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReleaseRuntime } from '../tooling/release-runtime.mjs';

for (const version of ['24.21.0', '24.21.1', '24.22.0', '24.99.9']) {
  test(`release permits stable supported Node ${version}`, () => {
    assert.doesNotThrow(() => assertReleaseRuntime(version));
  });
}

for (const version of ['24.11.1', '24.20.0', '24.20.9', '23.99.0', '25.0.0', '24.21.0-rc.1', '24.22.0-nightly.1', '24.021.0', '24.21', 'v24.21.0']) {
  test(`release rejects unsupported Node ${version}`, () => {
    assert.throws(() => assertReleaseRuntime(version), /Release runtime requires stable Node\.js >=24\.21\.0 <25\./u);
  });
}
