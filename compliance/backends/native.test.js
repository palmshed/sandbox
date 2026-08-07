import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';

/**
 * Spec-Version: 0.1.0
 */
test('Compliance Suite: Backend Engine Contract (NativeBackend) [Spec-Version: 0.1.0]', async (t) => {
  const engine = new NativeBackend();

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Backend exposes valid capability negotiation flags [Spec-Version: 0.1.0]', async () => {
    assert.equal(typeof engine.capabilities.filesystem, 'boolean');
    assert.equal(typeof engine.capabilities.streaming, 'boolean');
    assert.equal(typeof engine.capabilities.remoteExecution, 'boolean');
  });

  await t.test('Backend lifecycle init and execution contract [Spec-Version: 0.1.0]', async () => {
    await engine.init({ timeout: 5000 });
    const res = await engine.exec('echo "Backend Conformance"');
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /Backend Conformance/);
  });
});
