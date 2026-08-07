import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';

/**
 * Spec-Version: 0.1.0
 */
test('TCK: Execution Module [Spec-Version: 0.1.0]', async (t) => {
  const engine = new NativeBackend();
  await engine.init({});

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Exec exit code and capture', async () => {
    const res = await engine.exec('echo "TCK Exec"');
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /TCK Exec/);
  });
});
