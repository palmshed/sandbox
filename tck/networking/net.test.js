import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';

/**
 * Spec-Version: 1.0.0
 */
test('TCK: Networking Module [Spec-Version: 1.0.0]', async (t) => {
  const engine = new NativeBackend();
  await engine.init({ network: 'disabled' });

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Network capability query', async () => {
    assert.equal(typeof engine.capabilities.networkIsolation, 'boolean');
  });
});
