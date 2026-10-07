import test from 'node:test';

test('controlled output exceeds the validation budget', () => {
  process.stdout.write('fixture-output-'.repeat(160_000));
});
