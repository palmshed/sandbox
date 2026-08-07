import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';

/**
 * Spec-Version: 0.1.0
 */
test('TCK: Lifecycle Module [Spec-Version: 0.1.0]', async (t) => {
  const engine = new NativeBackend();

  await t.test('Init and Destroy contract', async () => {
    await engine.init({ timeout: 1000 });
    assert.equal(engine.name, 'native');
    await engine.destroy();
  });
});
