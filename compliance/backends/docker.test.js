import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerBackend } from '../../sdk/typescript/dist/backends/docker.js';

/**
 * Spec-Version: 1.0.0
 *
 * Docker capability contract test. This suite intentionally does NOT require a
 * Docker daemon (no CI runner installs one), so it asserts the capability
 * matrix and pre-init failure states only. The explicit matrix is the contract:
 * Docker currently claims only filesystem/streaming; cpuLimits, memoryLimits
 * and networkIsolation are `false` until backend-parity work item #4 lands
 * implementation + integration tests.
 */
test('Compliance Suite: Backend Engine Contract (DockerBackend) [Spec-Version: 1.0.0]', async (t) => {
  const engine = new DockerBackend();

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Capability matrix is explicit and honest [Spec-Version: 1.0.0]', async () => {
    assert.deepEqual(engine.capabilities, {
      filesystem: true,
      networkIsolation: false,
      cpuLimits: false,
      memoryLimits: false,
      streaming: true,
      remoteExecution: false,
    });
  });

  await t.test('exec() before init fails cleanly (EXEC_FAILED) [Spec-Version: 1.0.0]', async () => {
    await assert.rejects(
      () => engine.exec('echo never runs'),
      (err) => {
        assert.equal(typeof err, 'object');
        return err && err.code === 'EXEC_FAILED';
      }
    );
  });

  await t.test('destroy() on an uninitialized backend is a safe no-op [Spec-Version: 1.0.0]', async () => {
    await assert.doesNotReject(() => engine.destroy());
  });
});
