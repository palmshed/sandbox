import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { DockerBackend, isDaemonConnectionError } from '../../sdk/typescript/dist/backends/docker.js';

/**
 * Spec-Version: 1.0.0
 *
 * Docker capability contract test. This suite intentionally does NOT require a
 * Docker daemon (no CI runner installs one), so it asserts the capability
 * matrix and pre-init failure states only. The explicit matrix is the contract:
 * Docker claims filesystem/streaming plus the work-item-#4 trio (cpuLimits,
 * memoryLimits, networkIsolation); live-container enforcement is covered by
 * docker-enforcement.test.js, which is daemon-gated and runs on CI Ubuntu.
 *
 * Disconnect contract (issue #10 closeout): daemon loss surfaces as
 * INVALID_BACKEND, never as a workload or filesystem failure. The classifier
 * is unit-tested here on every platform; the dead-endpoint init test needs
 * only the docker CLI binary (skipped where absent) because it points the
 * CLI at a port nothing listens on.
 */
function dockerCliAvailable() {
  try {
    execSync('docker --version', { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}
test('Compliance Suite: Backend Engine Contract (DockerBackend) [Spec-Version: 1.0.0]', async (t) => {
  const engine = new DockerBackend();

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Capability matrix is explicit and honest [Spec-Version: 1.0.0]', async () => {
    assert.deepEqual(engine.capabilities, {
      filesystem: true,
      networkIsolation: true,
      cpuLimits: true,
      memoryLimits: true,
      streaming: true,
      osFilesystemIsolation: 'unsupported',
      remoteExecution: false,
      cpuQuotaLimits: false,
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

  await t.test('daemon-connection classifier matches only daemon-loss text', () => {
    assert.equal(
      isDaemonConnectionError(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
      ),
      true
    );
    assert.equal(isDaemonConnectionError('ERROR: CANNOT CONNECT TO THE DOCKER DAEMON'), true);
    assert.equal(isDaemonConnectionError('Is the docker daemon running?'), true);
    assert.equal(isDaemonConnectionError(''), false);
    assert.equal(isDaemonConnectionError('node: command not found'), false);
    // A bare "connection refused" is deliberately NOT matched: workloads
    // connecting to closed ports print that routinely.
    assert.equal(
      isDaemonConnectionError('curl: (7) Failed to connect to 127.0.0.1 port 3000: Connection refused'),
      false
    );
    // An error response FROM the daemon proves it is reachable: not a loss.
    assert.equal(isDaemonConnectionError('Error response from daemon: No such container'), false);
  });

  await t.test('init against an unreachable daemon rejects INVALID_BACKEND', async (t) => {
    if (!dockerCliAvailable()) {
      return t.skip('no docker CLI on this host');
    }
    const previous = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:1';
    try {
      const doomed = new DockerBackend();
      try {
        await assert.rejects(() => doomed.init({}), (err) => err && err.code === 'INVALID_BACKEND');
      } finally {
        await doomed.destroy();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.DOCKER_HOST;
      } else {
        process.env.DOCKER_HOST = previous;
      }
    }
  });
});
