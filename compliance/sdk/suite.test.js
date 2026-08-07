import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '../../sdk/typescript/dist/index.js';

/**
 * Spec-Version: 0.1.0
 */
test('Conformance Suite: Core Spec Verification (TypeScript SDK) [Spec-Version: 0.1.0]', async (t) => {
  const sandbox = await Sandbox.create({
    backend: 'native',
    timeout: 3000,
    network: 'disabled',
  });

  t.after(async () => {
    await sandbox.destroy();
  });

  await t.test('Spec: Command Execution & Exit Code [Spec-Version: 0.1.0]', async () => {
    const res = await sandbox.exec('echo "Compliance Test"');
    assert.equal(res.exitCode, 0);
    assert.equal(typeof res.stdout, 'string');
    assert.equal(typeof res.stderr, 'string');
    assert.equal(typeof res.durationMs, 'number');
    assert.equal(res.timedOut, false);
  });

  await t.test('Spec: Real-time stdout streaming [Spec-Version: 0.1.0]', async () => {
    let captured = '';
    const res = await sandbox.exec('echo "Stream Chunk"', {
      onStdout: (data) => {
        captured += data;
      },
    });
    assert.equal(res.exitCode, 0);
    assert.match(captured, /Stream Chunk/);
  });

  await t.test('Spec: Timeout Enforcement [Spec-Version: 0.1.0]', async () => {
    const res = await sandbox.exec('node -e "setTimeout(() => {}, 5000)"', {
      timeout: 150,
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.exitCode, -1);
  });
});
