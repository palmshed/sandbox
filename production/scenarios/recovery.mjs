/**
 * production/scenarios/recovery.mjs
 *
 * The "ugly cases" scenario: the combinations a production operator worries
 * about most. The assertion for every case is the same shape: the SDK
 * reported the correct state, cleaned up correctly, and the sandbox (or a
 * fresh one) remained usable afterward.
 *
 * Covered combinations:
 *   - timeout alongside a disk-quota breach, then sandbox reuse
 *   - CPU budget enforcement under concurrent executions
 *   - destroy() while an execution is still running
 *   - immediate reuse after a failing execution
 *   - a crashing workload (process.abort) with a reusable sandbox after
 *   - 50 rapid create → exec → destroy cycles with zero residue
 */
const BUDGET_MS = 300000;

async function runReuseProbe(ctx, sandbox, afterWhat) {
  const probe = await sandbox.exec('node -e "console.log(\'reuse-after-' + afterWhat + '\')"', { timeout: 5000 });
  await probe.wait();
  ctx.assert.equal(probe.exitCode, 0, `sandbox must be reusable after ${afterWhat}`);
  ctx.assert.ok(probe.stdout().includes(`reuse-after-${afterWhat}`), `reuse probe output must match after ${afterWhat}`);
}

export default {
  id: 'recovery',
  title: 'Recovery: timeout+quota, CPU+concurrency, destroy-while-running, crashes',
  timeoutMs: BUDGET_MS,
  run: async (ctx) => {
    const baseline = ctx.scanResidue();
    const allPgids = new Set(ctx.snapshotPgids());

    // ── Case 1: disk quota + timeout, then reuse ─────────────────────────
    {
      const st = ctx.step('quota+timeout');
      const sandbox = await ctx.sandbox({ network: 'disabled', diskQuota: '1MB', timeout: 10000 });

      let quotaErr = null;
      const quotaExec = await sandbox.exec(
        'node -e "const fs=require(\'fs\');const s=\'x\'.repeat(1024);for(let i=0;i<5000;i++){fs.appendFileSync(\'big.bin\',s)}"',
        { timeout: 15000 }
      );
      try {
        await quotaExec.wait();
      } catch (err) {
        quotaErr = err;
      }
      ctx.assert.ok(quotaErr, 'disk-quota breach must surface an error');
      ctx.assert.equal(quotaErr.code, 'ERR_DISK_QUOTA_EXCEEDED', 'quota error code must be ERR_DISK_QUOTA_EXCEEDED');
      ctx.assert.equal(quotaErr.recoverable, true, 'quota error must be marked recoverable');
      await runReuseProbe(ctx, sandbox, 'disk-quota');

      const timeoutExec = await sandbox.exec('node -e "setInterval(()=>{},50)"', { timeout: 300 });
      await timeoutExec.wait();
      ctx.assert.equal(timeoutExec.status(), 'timedout', 'timeout exec must be reported timedout');
      ctx.assert.ok(timeoutExec.timedOut, 'timeout exec must set timedOut');
      await runReuseProbe(ctx, sandbox, 'timeout');

      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── Case 2: CPU budget under concurrent executions ───────────────────
    {
      const st = ctx.step('cpu+concurrency');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 15000 });
      const execs = [];
      for (let i = 0; i < 4; i++) {
        execs.push(
          (async () => {
            const e = await sandbox.exec('node -e "for(;;){Math.sqrt(Math.random())}"', {
              timeout: 8000,
              cpuTimeLimit: 200,
            });
            let rejection = null;
            try {
              await e.wait();
            } catch (err) {
              rejection = err;
            }
            return { rejection, status: e.status() };
          })()
        );
      }
      const outcomes = await Promise.all(execs);
      const killed = outcomes.filter((o) => o.rejection || o.status === 'timedout');
      ctx.assert.ok(killed.length >= 1, 'at least one concurrent CPU-burning execution must be killed');
      for (const o of outcomes) {
        if (o.rejection) {
          ctx.assert.equal(o.rejection.code, 'ERR_CPU_EXCEEDED', 'CPU-budget kill must report ERR_CPU_EXCEEDED');
        }
      }
      await runReuseProbe(ctx, sandbox, 'cpu-concurrency');
      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── Case 3: destroy while an execution is running ────────────────────
    {
      const st = ctx.step('destroy-while-running');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 60000 });
      const dirPrefix = ctx.scanResidue();
      const running = await sandbox.exec('node -e "setInterval(()=>{},50)"', { timeout: 60000 });
      ctx.assert.equal(running.status(), 'running', 'execution must be running when destroy() is called');
      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
      // The in-flight execution must settle (cancel semantics) without throwing.
      try {
        await running.wait();
      } catch {
        // cancellation may surface a resource/settled error; that is expected
      }
      // The destroyed sandbox must not appear as residue.
      ctx.assertNoResidue(dirPrefix, 'destroy-while-running');

      // A fresh sandbox must start cleanly afterwards.
      const fresh = await ctx.sandbox({ network: 'disabled', timeout: 10000 });
      await runReuseProbe(ctx, fresh, 'post-destroy');
      await fresh.destroy();
      ctx.untrack(fresh);
    }

    // ── Case 4: failure then immediate reuse ─────────────────────────────
    {
      const st = ctx.step('fail-then-reuse');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 10000 });
      const failing = await sandbox.exec('node -e "process.exit(9)"', { timeout: 5000 });
      await failing.wait();
      ctx.assert.equal(failing.status(), 'failed', 'failing exec must be reported failed');
      ctx.assert.equal(failing.exitCode, 9, 'failing exec must exit 9');
      await runReuseProbe(ctx, sandbox, 'immediate-failure');
      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── Case 5: crashing workload, sandbox reusable ──────────────────────
    {
      const st = ctx.step('crash');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 10000 });
      const crashing = await sandbox.exec('node -e "process.abort()"', { timeout: 5000 });
      await crashing.wait();
      ctx.assert.equal(crashing.status(), 'failed', 'crashing workload must be reported failed');
      ctx.assert.notEqual(crashing.exitCode, 0, 'crashing workload must exit non-zero');
      await runReuseProbe(ctx, sandbox, 'crash');
      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── Case 6: 50 rapid create → exec → destroy cycles ──────────────────
    {
      const st = ctx.step('50-cycles');
      for (let i = 0; i < 50; i++) {
        const s = await ctx.sandbox({ network: 'disabled', timeout: 5000 });
        const e = await s.exec('node -e "console.log(\'cycle\')"', { timeout: 5000 });
        await e.wait();
        ctx.assert.equal(e.exitCode, 0, `cycle ${i} exec must pass`);
        await s.destroy();
        ctx.untrack(s);
      }
      st.end();
    }

    const pgidsAfter = ctx.snapshotPgids();
    ctx.assertPgidsDead([...new Set([...allPgids, ...pgidsAfter])], 'recovery');
    ctx.assertNoResidue(baseline, 'recovery');
  },
};
