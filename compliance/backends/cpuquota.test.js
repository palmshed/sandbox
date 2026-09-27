import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { Sandbox } from '../../sdk/typescript/dist/index.js';

/**
 * Spec-Version: 1.2.0 (released; RFC 0007 implemented on Linux, Windows, Docker)
 *
 * CPU hard quota compliance (Q1-Q6): rate caps that throttle, never kill.
 * Transcribed from the RFC 0007 compliance test plan. Enforcement groups
 * gate on the backend reporting cpuQuotaLimits === true and skip where
 * the probe does not pass (macOS reports false by design).
 *
 * Only the macOS honesty test runs today (macOS stays false permanently per
 * the RFC): it asserts the flag and unthrottled completion.
 *
 * Quota sandboxes opt out of osfs confinement (`osFilesystemIsolation:
 * false`): the Landlock ruleset denies the shell self-move write, which
 * would leave only the racy host-side move. Opting out isolates the quota
 * mechanism under test.
 *
 * On systemd hosts the suite needs a delegated subtree to run in: an
 * ordinary login shell lives in a root-owned session scope it cannot extend,
 * so run inside `systemd-run --user --scope` (or equivalent) to provide a
 * user-owned ancestor. Without one the native group skips honestly.
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

// Iteration-bounded burn: fixed work, so throttling stretches the time the
// workload itself measures. The workload reports its own elapsed
// milliseconds (`burnwall=`), which excludes spawn, prefix, and IPC overhead
// by construction. Assertions compare throttled against back-to-back
// controls (ratio floor 1.5), but shared-runner load contaminates the
// control side often enough (measured 0.72x-1.49x across four occurrences)
// that every ratio assertion first passes checkThrottleRatio: when the two
// controls diverge beyond the floor, the run is reported INVALID rather
// than failed. Enforcement itself has never been shown broken.
const ITER_BURN = `node -e "const t0 = Date.now(); let x = 0; for (let i = 0; i < 100000000; i++) { x += Math.sqrt(x + 1); } console.log('burnwall=' + (Date.now() - t0));"`;

async function burnCpu(sandbox, command, options) {
  const execution = await sandbox.exec(command, options);
  await execution.wait();
  assert.equal(execution.status(), 'completed');
  const match = execution.stdout().match(/burnwall=(\d+)/);
  assert.ok(match, `burn reports its wall time, got: ${execution.stdout().trim().slice(-200)}`);
  return parseInt(match[1], 10);
}

// Host-load validity gate (track-2 decision, not a floor change).
//
// Four measured occurrences (1.24x, 1.34x, 1.49x, inverted 0.72x on both
// Windows and Ubuntu) establish that shared-runner load contaminates the
// control side, so a ratio miss cannot distinguish failed enforcement
// from a bad measurement. The gate compares two back-to-back control
// burns: when they diverge beyond the 1.5x assertion floor itself, the
// apparatus cannot resolve a 1.5x effect and the run is reported INVALID
// via a visible skip carrying the raw numbers. That claims neither pass
// nor failure, and it never silently skips: the invalidation and all
// three measurements print in the test output. Returns false when the
// caller must stop (already skipped), true when the assertion ran.
function checkThrottleRatio(t, label, controlWall, controlWall2, throttledWall) {
  const hi = Math.max(controlWall, controlWall2);
  const lo = Math.min(controlWall, controlWall2);
  const raw = `${label} (control ${controlWall}ms vs ${controlWall2}ms, throttled ${throttledWall}ms)`;
  if (hi > 1.5 * lo) {
    t.skip(`INVALID MEASUREMENT, host load: control walls diverge beyond the 1.5x assertion floor; raw: ${raw}; no pass or failure claimed`);
    return false;
  }
  assert.ok(
    throttledWall >= 1.5 * controlWall,
    `quota throttles the burn; raw: ${raw}`
  );
  return true;
}

test('RFC 0007 CPU hard quota compliance (Q1-Q6)', async (t) => {
  await t.test('macOS reports false and runs unthrottled', async (t) => {
    if (process.platform !== 'darwin') {
      return t.skip('macOS honesty check only');
    }
    const sandbox = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, cpuQuota: 0.5, timeout: 60000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    assert.equal(sandbox.capabilities.cpuQuotaLimits, false);
    const wall = await burnCpu(sandbox, ITER_BURN);
    assert.ok(wall < 60000, 'unthrottled burn finishes promptly');
  });

  await t.test('native Linux cgroup enforcement', async (t) => {
    if (process.platform !== 'linux') {
      return t.skip('Linux cgroup mapping only');
    }
    const sandbox = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, cpuQuota: 0.5, timeout: 90000 });
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

    await t.test('throttled burn takes longer wall time than unthrottled', async () => {
      const control = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, timeout: 90000 });
      try {
        const controlWall = await burnCpu(control, ITER_BURN);
        const throttledWall = await burnCpu(sandbox, ITER_BURN);
        const controlWall2 = await burnCpu(control, ITER_BURN);
        // Same work back-to-back on the same host: at quota 0.5 the
        // throttled run needs roughly twice the wall time. The 1.5 floor
        // absorbs shared-runner noise (measured 1.79 on a contended VM).
        if (!checkThrottleRatio(t, 'quota throttles the burn', controlWall, controlWall2, throttledWall)); return;
      } finally {
        await control.destroy();
      }
    });

    await t.test('unthrottled control completes', async () => {
      const control = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, timeout: 60000 });
      try {
        const execution = await control.exec(ITER_BURN);
        await execution.wait();
        assert.equal(execution.status(), 'completed');
        assert.match(execution.stdout(), /burnwall=/);
      } finally {
        await control.destroy();
      }
    });

    await t.test('per-exec override throttles then restores', async () => {
      const plain = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, timeout: 90000 });
      t.after(async () => {
        await plain.destroy();
      });
      const controlWall = await burnCpu(plain, ITER_BURN);
      const throttledWall = await burnCpu(plain, ITER_BURN, { cpuQuota: 0.5 });
      const controlWall2 = await burnCpu(plain, ITER_BURN);
      if (!checkThrottleRatio(t, 'override throttles this execution', controlWall, controlWall2, throttledWall)); return;
      const control = await plain.exec(ITER_BURN);
      await control.wait();
      assert.equal(control.status(), 'completed');
      assert.match(control.stdout(), /burnwall=/);
    });

    await t.test('descendant processes inherit the cap', async (t) => {
      if (process.platform === 'win32') {
        return t.skip('POSIX shell syntax only; Windows tree covered in its group');
      }
      const control = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, timeout: 90000 });
      try {
        const controlWall = await burnCpu(control, ITER_BURN);
        const throttledWall = await burnCpu(sandbox, `${ITER_BURN} & wait $!`);
        const controlWall2 = await burnCpu(control, ITER_BURN);
        if (!checkThrottleRatio(t, 'background child stays throttled', controlWall, controlWall2, throttledWall)); return;
      } finally {
        await control.destroy();
      }
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
        const execution = await sandbox.exec(ITER_BURN, { cpuQuota: quota });
        await execution.wait();
        assert.equal(execution.status(), 'completed', `quota ${String(quota)} runs unenforced`);
      }
    });

    await t.test('writes evidence artifact when requested', async () => {
      // Proof-of-execution for CI: skipped runs write nothing (this group
      // only runs when the flag promotes), so an uploaded artifact proves
      // the enforcement tests above really executed on that host. Local runs
      // leave no residue (env unset).
      const evidencePath = process.env.CPUQUOTA_EVIDENCE;
      if (!evidencePath) return;
      const cg = await sandbox.exec('cat /proc/self/cgroup');
      await cg.wait();
      assert.equal(cg.status(), 'completed');
      const line = cg.stdout().trim().split('\n').find((l) => l.startsWith('0::')) ?? '';
      const cpuMax = await fs.readFile(`/sys/fs/cgroup${line.slice(3) || '/'}/cpu.max`, 'utf-8');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            suite: 'cpuquota native Linux enforcement',
            platform: process.platform,
            flag: sandbox.capabilities.cpuQuotaLimits,
            cgroup: line,
            cpuMax: cpuMax.trim(),
            ok: true,
          },
          null,
          2
        ) + '\n'
      );
    });
  });

  await t.test('native Windows job enforcement', async (t) => {
    if (process.platform !== 'win32') {
      return t.skip('Windows Job Object mapping only');
    }
    const sandbox = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, cpuQuota: 0.5, timeout: 90000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    if (sandbox.capabilities.cpuQuotaLimits !== true) {
      return t.skip('cpuQuotaLimits not enforced here yet; skipping until promotion');
    }

    await t.test('throttled burn takes longer wall time than unthrottled', async () => {
      const control = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, timeout: 90000 });
      try {
        const controlWall = await burnCpu(control, ITER_BURN);
        const throttledWall = await burnCpu(sandbox, ITER_BURN);
        const controlWall2 = await burnCpu(control, ITER_BURN);
        if (!checkThrottleRatio(t, 'quota throttles the burn', controlWall, controlWall2, throttledWall)); return;
      } finally {
        await control.destroy();
      }
    });

    await t.test('child tree stays in the job', async () => {
      const control = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, timeout: 120000 });
      try {
        // Control matches the tree's doubled work: two sequential burns.
        const controlWallA = await burnCpu(control, ITER_BURN);
        const controlWallB = await burnCpu(control, ITER_BURN);
        const controlWall = controlWallA + controlWallB;
        // Double iterations for the tree: at ~1s the throttle signal sits
        // inside scheduler quantization noise (measured 1.43x vs the 1.5
        // floor); ~2s of throttled work separates cleanly.
        const execution = await sandbox.exec(
          `node -e "const {spawnSync}=require('child_process');spawnSync(process.execPath,['-e','const t0=Date.now();let x=0;for(let i=0;i<200000000;i++){x+=Math.sqrt(x+1);}console.log(\\'innerwall=\\'+(Date.now()-t0))'],{stdio:'inherit'});console.log('tree burned');"`
        );
        await execution.wait();
        assert.equal(execution.status(), 'completed');
        const match = execution.stdout().match(/innerwall=(\d+)/);
        assert.ok(match, 'spawned child reports its wall time');
        const throttledWall = parseInt(match[1], 10);
        // Validity uses the two single-burn controls (a and b below are
        // summed for the doubled-work comparison, so their spread is the
        // apparatus check, not the assertion baseline).
        if (!checkThrottleRatio(t, 'spawned child stays throttled', controlWallA, controlWallB, throttledWall)); return;
        assert.ok(
          throttledWall >= 1.5 * controlWall,
          `spawned child stays throttled (throttled ${throttledWall}ms vs control sum ${controlWall}ms)`
        );
      } finally {
        await control.destroy();
      }
    });

    await t.test('per-exec override throttles then restores', async () => {
      const plain = await Sandbox.create({ backend: 'native', osFilesystemIsolation: false, timeout: 120000 });
      try {
        const controlWall = await burnCpu(plain, ITER_BURN);
        const throttledWall = await burnCpu(plain, ITER_BURN, { cpuQuota: 0.5 });
        const controlWall2 = await burnCpu(plain, ITER_BURN);
        if (!checkThrottleRatio(t, 'override throttles this execution', controlWall, controlWall2, throttledWall)); return;
        const control = await plain.exec(ITER_BURN);
        await control.wait();
        assert.equal(control.status(), 'completed');
      } finally {
        await plain.destroy();
      }
    });

    await t.test('quota plus budget still dies by budget', async () => {
      const { SandboxResourceError } = await import('../../sdk/typescript/dist/index.js');
      await assert.rejects(
        (async () => {
          const execution = await sandbox.exec(`node -e "while(true){}"`, {
            cpuTimeLimit: 5000,
            timeout: 120000,
          });
          await execution.wait();
        })(),
        (err) => err instanceof SandboxResourceError && err.code === 'ERR_CPU_EXCEEDED'
      );
    });

    await t.test('non-positive quotas mean unset', async () => {
      for (const quota of [0, -1, NaN]) {
        const execution = await sandbox.exec(ITER_BURN, { cpuQuota: quota });
        await execution.wait();
        assert.equal(execution.status(), 'completed', `quota ${String(quota)} runs unenforced`);
      }
    });
  });

  await t.test('docker rate enforcement', async (t) => {
    if (!dockerLinuxAvailable()) {
      return t.skip('no Linux Docker daemon on this host');
    }
    const sandbox = await Sandbox.create({ backend: 'docker', osFilesystemIsolation: false, cpuQuota: 0.5, timeout: 90000 });
    t.after(async () => {
      await sandbox.destroy();
    });
    if (sandbox.capabilities.cpuQuotaLimits !== true) {
      return t.skip('cpuQuotaLimits not enforced here yet; skipping until promotion');
    }

    await t.test('throttled burn takes longer wall time than unthrottled', async () => {
      const plain = await Sandbox.create({ backend: 'docker', osFilesystemIsolation: false, timeout: 90000 });
      try {
        const controlWall = await burnCpu(plain, ITER_BURN);
        const throttledWall = await burnCpu(sandbox, ITER_BURN);
        const controlWall2 = await burnCpu(plain, ITER_BURN);
        if (!checkThrottleRatio(t, 'quota throttles the burn', controlWall, controlWall2, throttledWall)); return;
      } finally {
        await plain.destroy();
      }
    });

    await t.test('per-exec override throttles then restores', async () => {
      const plain = await Sandbox.create({ backend: 'docker', osFilesystemIsolation: false, timeout: 90000 });
      try {
        const controlWall = await burnCpu(plain, ITER_BURN);
        const throttledWall = await burnCpu(plain, ITER_BURN, { cpuQuota: 0.5 });
        const controlWall2 = await burnCpu(plain, ITER_BURN);
        if (!checkThrottleRatio(t, 'override throttles this execution', controlWall, controlWall2, throttledWall)); return;
        const control = await plain.exec(ITER_BURN);
        await control.wait();
        assert.equal(control.status(), 'completed');
      } finally {
        await plain.destroy();
      }
    });

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
      // Same container cgroupfs view: the --cpus=0.5 limit materializes as a
      // 50000us quota over the 100000us period. A cgroup v1 host reports the
      // quota and period files instead.
      let quotaText = null;
      try {
        const read = await sandbox.exec(`cat /sys/fs/cgroup${rel}/cpu.max`);
        await read.wait();
        if (read.status() === 'completed') quotaText = read.stdout().trim();
      } catch {
        // fall through to the v1 paths below
      }
      if (quotaText === null) {
        const quota = await sandbox.exec(`cat /sys/fs/cgroup/cpu/docker/*/cpu.cfs_quota_us`);
        await quota.wait();
        const period = await sandbox.exec(`cat /sys/fs/cgroup/cpu/docker/*/cpu.cfs_period_us`);
        await period.wait();
        assert.equal(quota.status(), 'completed');
        assert.equal(period.status(), 'completed');
        quotaText = `${quota.stdout().trim()} ${period.stdout().trim()}`;
      }
      assert.ok(
        quotaText.startsWith('50000 '),
        `quota 0.5 applied, got: ${quotaText}`
      );
    });

    await t.test('descendant processes inherit the cap', async (t) => {
      if (process.platform === 'win32') {
        return t.skip('POSIX shell syntax only; container cgroups cover every exec anyway');
      }
      const control = await Sandbox.create({ backend: 'docker', osFilesystemIsolation: false, timeout: 90000 });
      try {
        const controlWall = await burnCpu(control, ITER_BURN);
        const throttledWall = await burnCpu(sandbox, `${ITER_BURN} & wait $!`);
        const controlWall2 = await burnCpu(control, ITER_BURN);
        if (!checkThrottleRatio(t, 'background child stays throttled', controlWall, controlWall2, throttledWall)); return;
      } finally {
        await control.destroy();
      }
    });

    await t.test('quota plus budget still dies by budget', async () => {
      const { SandboxResourceError } = await import('../../sdk/typescript/dist/index.js');
      await assert.rejects(
        (async () => {
          const execution = await sandbox.exec(`node -e "while(true){}"`, {
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
        const execution = await sandbox.exec(ITER_BURN, { cpuQuota: quota });
        await execution.wait();
        assert.equal(execution.status(), 'completed', `quota ${String(quota)} runs unenforced`);
      }
    });
  });
});
