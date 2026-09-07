import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { Sandbox } from '../../sdk/typescript/dist/index.js';

/**
 * Spec-Version: 1.2.0 (Unreleased, RFC 0007 design accepted)
 *
 * CPU hard quota compliance (Q1-Q6): rate caps that throttle, never kill.
 * Transcribed from the RFC 0007 compliance test plan; enforcement is NOT
 * implemented yet, so every enforcement group gates on the backend reporting
 * cpuQuotaLimits === true and skips until per-backend promotion. When a
 * backend promotes the flag, its group runs without further changes.
 *
 * Only the macOS honesty test runs today (macOS stays false permanently per
 * the RFC): it asserts the flag and unthrottled completion.
 *
 * Deterministic rate readback (cpu.max contents, job query, inspect format)
 * is backend-coupled and belongs in SDK unit tests at implementation time;
 * this suite asserts portable behavior (wall-clock contrast with wide
 * margins, override scoping, inheritance, budget interplay, validation).
 * Exception: the native Linux group reads back cpu.max through the
 * workload-reported cgroup path (same host view, no backend API needed),
 * which deterministically proves both the applied value and that the move
 * actually happened.
 */
function dockerLinuxAvailable() {
  try {
    const ostype = execSync('docker info --format {{.OSType}}', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    })
      .toString()
      .trim()
      .toLowerCase();
    return ostype === 'linux';
  } catch {
    return false;
  }
}

// CPU-bound burn of roughly burnMs milliseconds of CPU time. Pure arithmetic
// (no I/O, no sleep) so wall time tracks CPU time 1:1 unthrottled.
const CPU_BURN = (burnMs) =>
  `node -e "const end = Date.now() + (${burnMs}); let x = 0; while (Date.now() < end) { x += Math.sqrt(x + 1); } console.log('burned ${burnMs}');"`;

test('RFC 0007 CPU hard quota compliance (Q1-Q6)', async (t) => {
  await t.test('macOS reports false and runs unthrottled', async (t) => {
    if (process.platform !== 'darwin') {
      return t.skip('macOS honesty check only');
    }
    const sandbox = await Sandbox.create({ backend: 'native', cpuQuota: 0.5, timeout: 60000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    assert.equal(sandbox.capabilities.cpuQuotaLimits, false);
    const start = Date.now();
    const execution = await sandbox.exec(CPU_BURN(1000));
    await execution.wait();
    assert.equal(execution.status(), 'completed');
    assert.match(execution.stdout(), /burned 1000/);
    assert.ok(Date.now() - start < 30000, 'unthrottled burn finishes promptly');
  });

  await t.test('native Linux cgroup enforcement', async (t) => {
    if (process.platform !== 'linux') {
      return t.skip('Linux cgroup mapping only');
    }
    const sandbox = await Sandbox.create({ backend: 'native', cpuQuota: 0.5, timeout: 90000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    if (sandbox.capabilities.cpuQuotaLimits !== true) {
      return t.skip('cpuQuotaLimits not enforced here yet; skipping until promotion');
    }

    await t.test('rate readback via the workload cgroup', async () => {
      const cg = await sandbox.exec('cat /proc/self/cgroup');
      await cg.wait();
      assert.equal(cg.status(), 'completed');
      const line = cg
        .stdout()
        .trim()
        .split('\n')
        .find((l) => l.startsWith('0::'));
      assert.ok(line, `cgroup v2 entry present, got: ${cg.stdout().trim()}`);
      const rel = line.slice(3) || '/';
      // Same host cgroupfs view (native backend shares namespaces except
      // net/user): reading the workload's own cpu.max proves both the applied
      // value and that the spawn-time move actually happened.
      const cpuMax = await fs.readFile(`/sys/fs/cgroup${rel}/cpu.max`, 'utf-8');
      assert.ok(
        cpuMax.trim().startsWith('50000 '),
        `quota 0.5 applied, got: ${cpuMax.trim()}`
      );
    });

    await t.test('throttled burn takes longer wall time than CPU time', async () => {
      const start = Date.now();
      const execution = await sandbox.exec(CPU_BURN(2000));
      await execution.wait();
      assert.equal(execution.status(), 'completed');
      // 2000ms of CPU at 0.5 cores needs at least 4000ms wall; 3000ms
      // allows wide CI slack while staying far above unthrottled speed.
      assert.ok(Date.now() - start >= 3000, 'quota throttles the burn');
    });

    await t.test('unthrottled control completes', async () => {
      const control = await Sandbox.create({ backend: 'native', timeout: 60000 });
      try {
        const execution = await control.exec(CPU_BURN(2000));
        await execution.wait();
        assert.equal(execution.status(), 'completed');
        assert.match(execution.stdout(), /burned 2000/);
      } finally {
        await control.destroy();
      }
    });

    await t.test('per-exec override throttles then restores', async () => {
      const plain = await Sandbox.create({ backend: 'native', timeout: 90000 });
      t.after(async () => {
        await plain.destroy();
      });
      const start = Date.now();
      const throttled = await plain.exec(CPU_BURN(2000), { cpuQuota: 0.5 });
      await throttled.wait();
      assert.equal(throttled.status(), 'completed');
      assert.ok(Date.now() - start >= 3000, 'override throttles this execution');
      const control = await plain.exec(CPU_BURN(1000));
      await control.wait();
      assert.equal(control.status(), 'completed');
      assert.match(control.stdout(), /burned 1000/);
    });

    await t.test('descendant processes inherit the cap', async (t) => {
      if (process.platform === 'win32') {
        return t.skip('POSIX shell syntax only; Windows tree covered in its group');
      }
      const start = Date.now();
      const execution = await sandbox.exec(`${CPU_BURN(2000)} & wait $!`);
      await execution.wait();
      assert.equal(execution.status(), 'completed');
      assert.ok(Date.now() - start >= 3000, 'background child stays throttled');
    });

    await t.test('quota plus budget still dies by budget', async () => {
      const { SandboxResourceError } = await import('../../sdk/typescript/dist/index.js');
      await assert.rejects(
        (async () => {
          const execution = await sandbox.exec(`node -e 'while(true){}'`, {
            cpuTimeLimit: 2000,
            timeout: 90000,
          });
          await execution.wait();
        })(),
        (err) => err instanceof SandboxResourceError && err.code === 'ERR_CPU_EXCEEDED'
      );
    });

    await t.test('non-positive quotas mean unset', async () => {
      for (const quota of [0, -1, NaN]) {
        const execution = await sandbox.exec(CPU_BURN(500), { cpuQuota: quota });
        await execution.wait();
        assert.equal(execution.status(), 'completed', `quota ${String(quota)} runs unenforced`);
      }
    });
  });

  await t.test('native Windows job enforcement', async (t) => {
    if (process.platform !== 'win32') {
      return t.skip('Windows Job Object mapping only');
    }
    const sandbox = await Sandbox.create({ backend: 'native', cpuQuota: 0.5, timeout: 90000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    if (sandbox.capabilities.cpuQuotaLimits !== true) {
      return t.skip('cpuQuotaLimits not enforced here yet; skipping until promotion');
    }

    await t.test('throttled burn takes longer wall time than CPU time', async () => {
      const start = Date.now();
      const execution = await sandbox.exec(CPU_BURN(2000));
      await execution.wait();
      assert.equal(execution.status(), 'completed');
      assert.ok(Date.now() - start >= 3000, 'quota throttles the burn');
    });

    await t.test('child tree stays in the job', async () => {
      const start = Date.now();
      const execution = await sandbox.exec(
        `node -e "const {spawnSync}=require('child_process');spawnSync(process.execPath,['-e','const e=Date.now()+2000;let x=0;while(Date.now()<e){x+=Math.sqrt(x+1);}'],{stdio:'inherit'});console.log('tree burned');"`
      );
      await execution.wait();
      assert.equal(execution.status(), 'completed');
      assert.ok(Date.now() - start >= 3000, 'spawned child stays throttled');
    });
  });

  await t.test('docker rate enforcement', async (t) => {
    if (!dockerLinuxAvailable()) {
      return t.skip('no Linux Docker daemon on this host');
    }
    const sandbox = await Sandbox.create({ backend: 'docker', cpuQuota: 0.5, timeout: 90000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    if (sandbox.capabilities.cpuQuotaLimits !== true) {
      return t.skip('cpuQuotaLimits not enforced here yet; skipping until promotion');
    }

    await t.test('throttled burn takes longer wall time than CPU time', async () => {
      const start = Date.now();
      const execution = await sandbox.exec(CPU_BURN(2000));
      await execution.wait();
      assert.equal(execution.status(), 'completed');
      assert.ok(Date.now() - start >= 3000, 'quota throttles the burn');
    });

    await t.test('per-exec override throttles then restores', async () => {
      const plain = await Sandbox.create({ backend: 'docker', timeout: 90000 });
      try {
        const start = Date.now();
        const throttled = await plain.exec(CPU_BURN(2000), { cpuQuota: 0.5 });
        await throttled.wait();
        assert.equal(throttled.status(), 'completed');
        assert.ok(Date.now() - start >= 3000, 'override throttles this execution');
        const control = await plain.exec(CPU_BURN(1000));
        await control.wait();
        assert.equal(control.status(), 'completed');
      } finally {
        await plain.destroy();
      }
    });
  });
});
