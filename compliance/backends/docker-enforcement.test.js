import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { Sandbox, SandboxResourceError } from '../../sdk/typescript/dist/index.js';

/**
 * Spec-Version: 1.1.0
 *
 * Docker backend-parity suite (work item #4): CPU time-budget enforcement,
 * per-execution memory overrides, and network policies beyond `disabled`,
 * exercised end-to-end through the real `Sandbox` API against a live
 * container. Gated on a Docker daemon: when `docker info` fails (macOS and
 * Windows CI runners have no daemon), the suite skips rather than asserting.
 * In practice this runs on CI Ubuntu, where the daemon is native Linux.
 *
 * Each enforcement attempt asserts the attempt FAILS with the documented
 * SandboxResourceError while the sandbox stays healthy and reusable.
 */
function dockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// Node allocation bomb: ~200MB of touched pages so the OS actually commits
// memory instead of leaving it virtual. Deterministic under both cgroup OOM
// (docker update path) and sampler observation.
const ALLOC_BOMB = `node -e "
  const chunks = [];
  for (let i = 0; i < 200; i++) {
    const b = Buffer.alloc(1024 * 1024);
    b.fill(i % 256);
    chunks.push(b);
  }
  console.log('allocated');
"`;

test('Docker backend parity: resource and network enforcement (item #4)', async (t) => {
  if (!dockerAvailable()) {
    return t.skip('no Docker daemon on this host; parity assertions need a live container');
  }

  await t.test('CPU time budget breach rejects ERR_CPU_EXCEEDED', async () => {
    const sandbox = await Sandbox.create({ backend: 'docker', timeout: 60000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    const start = Date.now();
    await assert.rejects(
      (async () => {
        const execution = await sandbox.exec(`node -e 'while(true){}'`, {
          cpuTimeLimit: 2000,
          timeout: 60000,
        });
        await execution.wait();
      })(),
      (err) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        const resErr = err;
        assert.equal(resErr.code, 'ERR_CPU_EXCEEDED');
        assert.equal(resErr.resource, 'cpu');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );
    // Killed on the budget, not left to the wall timeout (generous CI margin).
    assert.ok(Date.now() - start < 45000, 'breach enforced well before the wall timeout');

    // Sandbox stays healthy: a normal execution succeeds afterwards.
    const recovery = await sandbox.exec('echo "docker alive"');
    await recovery.wait();
    assert.equal(recovery.status(), 'completed');
    assert.match(recovery.stdout(), /docker alive/);
  });

  await t.test('CPU budget does not break normal executions', async () => {
    const sandbox = await Sandbox.create({ backend: 'docker', timeout: 60000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    const execution = await sandbox.exec(`node -p '40 + 2'`, { cpuTimeLimit: 30000 });
    await execution.wait();
    assert.equal(execution.status(), 'completed');
    assert.equal(execution.stdout().trim(), '42');
  });

  await t.test('per-execution memory override breach rejects ERR_OOM_EXCEEDED', async () => {
    const sandbox = await Sandbox.create({ backend: 'docker', timeout: 90000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    await assert.rejects(
      (async () => {
        const execution = await sandbox.exec(ALLOC_BOMB, { memory: '64MB', timeout: 90000 });
        await execution.wait();
      })(),
      (err) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        assert.equal(err.code, 'ERR_OOM_EXCEEDED');
        assert.equal(err.resource, 'memory');
        assert.equal(err.recoverable, true);
        return true;
      }
    );

    // Control: the same bomb without the override passes, proving the
    // container limit was restored after the breaching execution.
    const control = await sandbox.exec(ALLOC_BOMB, { timeout: 90000 });
    await control.wait();
    assert.equal(control.status(), 'completed');
    assert.match(control.stdout(), /allocated/);
  });

  await t.test('sandbox stays healthy after OOM kill', async () => {
    const sandbox = await Sandbox.create({ backend: 'docker', timeout: 90000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    await assert.rejects(
      (async () => {
        const execution = await sandbox.exec(ALLOC_BOMB, { memory: '64MB', timeout: 90000 });
        await execution.wait();
      })(),
      (err) => err instanceof SandboxResourceError && err.code === 'ERR_OOM_EXCEEDED'
    );
    const recovery = await sandbox.exec('echo "docker alive"');
    await recovery.wait();
    assert.equal(recovery.status(), 'completed');
    assert.match(recovery.stdout(), /docker alive/);
  });

  await t.test("network 'disabled' exposes only loopback", async () => {
    const sandbox = await Sandbox.create({ backend: 'docker', network: 'disabled', timeout: 60000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    const execution = await sandbox.exec('ls /sys/class/net');
    await execution.wait();
    assert.equal(execution.status(), 'completed');
    assert.deepEqual(
      execution.stdout().trim().split('\n').map((s) => s.trim()).filter(Boolean),
      ['lo']
    );
  });

  await t.test("network 'allow' exposes a container interface", async () => {
    const sandbox = await Sandbox.create({ backend: 'docker', network: 'allow', timeout: 60000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    const execution = await sandbox.exec('ls /sys/class/net');
    await execution.wait();
    assert.equal(execution.status(), 'completed');
    const ifaces = execution.stdout().trim().split('\n').map((s) => s.trim()).filter(Boolean);
    assert.ok(ifaces.includes('eth0'), `expected eth0, got ${ifaces.join(',')}`);
  });

  await t.test("network 'proxy' passes host proxy env into the container", async () => {
    const previous = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://proxy.test:8080';
    try {
      const sandbox = await Sandbox.create({ backend: 'docker', network: 'proxy', timeout: 60000 });
      try {
        const execution = await sandbox.exec('printenv HTTP_PROXY');
        await execution.wait();
        assert.equal(execution.status(), 'completed');
        assert.equal(execution.stdout().trim(), 'http://proxy.test:8080');
      } finally {
        await sandbox.destroy();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = previous;
      }
    }
  });
});
