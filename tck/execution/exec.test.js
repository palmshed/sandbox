import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';

/**
 * Spec-Version: 1.0.0
 */
test('TCK: Execution Module [Spec-Version: 1.0.0]', async (t) => {
  const engine = new NativeBackend();
  await engine.init({ env: { EXPLICIT_VAR: 'injected' } });

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Exec exit code and capture', async () => {
    const res = await engine.exec('echo "TCK Exec"');
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /TCK Exec/);
  });

  await t.test('Environment contract: host env not inherited wholesale, explicit env injected [v0.1.2]', async () => {
    process.env.HOST_LEAK_VAR = 'should-not-leak';
    const res = await engine.exec(
      'node -e "console.log(process.env.HOST_LEAK_VAR||\'absent\', process.env.EXPLICIT_VAR||\'absent\', process.env.PATH?\'path\':\'nopath\')"'
    );
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /absent injected path/);
    delete process.env.HOST_LEAK_VAR;
  });
});
