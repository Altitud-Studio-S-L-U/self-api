import test from 'node:test';

test('controlled stalled test reaches the validation time limit', async () => {
  await new Promise(() => { setInterval(() => {}, 1000); });
});
