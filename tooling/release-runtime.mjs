import assert from 'node:assert/strict';

export function assertReleaseRuntime(version) {
  const match = typeof version === 'string' && /^24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  assert(match && Number.isSafeInteger(Number(match[1])) && Number.isSafeInteger(Number(match[2])) && Number(match[1]) >= 21,
    'Release runtime requires stable Node.js >=24.21.0 <25.');
}
