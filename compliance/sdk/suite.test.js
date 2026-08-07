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
    const execution = await sandbox.exec('echo "Compliance Test"');
    assert.equal(execution.exitCode, 0);
    assert.equal(typeof execution.stdout, 'string');
    assert.equal(typeof execution.stderr, 'string');
    assert.equal(typeof execution.durationMs, 'number');
    assert.equal(execution.timedOut, false);
  });

  await t.test('Spec: Execution Metadata [Spec-Version: 0.1.0]', async () => {
    const execution = await sandbox.exec('echo "Metadata"');
    assert.match(execution.id, /^exec_/);
    assert.equal(execution.metadata.backend, 'native');
    assert.equal(execution.metadata.specVersion, '0.1.0');
    assert.equal(typeof execution.metadata.startedAt, 'string');
    assert.equal(typeof execution.metadata.finishedAt, 'string');
  });

  await t.test('Spec: Real-time stdout streaming [Spec-Version: 0.1.0]', async () => {
    let captured = '';
    const execution = await sandbox.exec('echo "Stream Chunk"', {
      onStdout: (data) => {
        captured += data;
      },
    });
    assert.equal(execution.exitCode, 0);
    assert.match(captured, /Stream Chunk/);
  });

  await t.test('Spec: Timeout Enforcement [Spec-Version: 0.1.0]', async () => {
    const execution = await sandbox.exec('node -e "setTimeout(() => {}, 5000)"', {
      timeout: 150,
    });
    assert.equal(execution.timedOut, true);
    assert.equal(execution.exitCode, -1);
    assert.equal(execution.metadata.timedOut, true);
  });
});
