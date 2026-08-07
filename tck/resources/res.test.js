import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';

/**
 * Spec-Version: 0.1.0
 */
test('TCK: Resources Module [Spec-Version: 0.1.0]', async (t) => {
  const engine = new NativeBackend();
  await engine.init({ cpu: 1, memory: '512MB' });

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Resource capability query', async () => {
    assert.equal(typeof engine.capabilities.cpuLimits, 'boolean');
    assert.equal(typeof engine.capabilities.memoryLimits, 'boolean');
  });
});
