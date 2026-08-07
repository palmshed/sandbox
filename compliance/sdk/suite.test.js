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

  await t.test('Spec: Execution handle URI and initial status [Spec-Version: 0.1.0]', async () => {
    const execution = await sandbox.exec('echo "Compliance"');
    assert.match(execution.id, /^exec_/);
    assert.match(execution.uri, /^sandbox:\/\/execution\/exec_/);
    await execution.wait();
    assert.equal(execution.status(), 'completed');
  });

  await t.test('Spec: Command Execution & Exit Code [Spec-Version: 0.1.0]', async () => {
    const execution = await sandbox.exec('echo "Compliance Test"');
    await execution.wait();
    assert.equal(execution.exitCode, 0);
    assert.equal(typeof execution.stdout(), 'string');
    assert.equal(execution.timedOut, false);
  });

  await t.test('Spec: Execution Metadata [Spec-Version: 0.1.0]', async () => {
    const execution = await sandbox.exec('echo "Metadata"');
    await execution.wait();
    const meta = execution.metadata();
    assert.ok(meta);
    assert.equal(meta.backend, 'native');
    assert.equal(meta.specVersion, '0.1.0');
    assert.equal(typeof meta.startedAt, 'string');
    assert.equal(typeof meta.finishedAt, 'string');
  });

  await t.test('Spec: Real-time stdout streaming via events [Spec-Version: 0.1.0]', async () => {
    let captured = '';
    const execution = await sandbox.exec('echo "Stream Chunk"');
    execution.on('stdout', (data) => { captured += data; });
    await execution.wait();
    assert.match(captured, /Stream Chunk/);
  });

  await t.test('Spec: Timeout Enforcement & timedout status [Spec-Version: 0.1.0]', async () => {
    const execution = await sandbox.exec('node -e "setTimeout(() => {}, 5000)"', {
      timeout: 150,
    });
    await execution.wait();
    assert.equal(execution.status(), 'timedout');
    assert.equal(execution.exitCode, -1);
    const meta = execution.metadata();
    assert.ok(meta);
    assert.equal(meta.timedOut, true);
  });
});
