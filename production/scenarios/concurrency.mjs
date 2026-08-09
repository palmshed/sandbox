/**
 * production/scenarios/concurrency.mjs
 *
 * Sustained concurrency: 50 sandboxes alive at once plus 20 concurrent
 * executions inside a single sandbox. Every workload must complete with the
 * correct output, every sandbox must destroy, and the host must show no
 * residue and no live workload processes afterward.
 */
const BUDGET_MS = 240000;

export default {
  id: 'concurrency',
  title: 'Concurrency: 50 sandboxes + 20 parallel execs in one sandbox',
  timeoutMs: BUDGET_MS,
  run: async (ctx) => {
    const baseline = ctx.scanResidue();
    const allPgids = new Set(ctx.snapshotPgids());

    // ── 50 concurrent sandboxes ──────────────────────────────────────────
    {
      const st = ctx.step('50-sandboxes');
      const sandboxes = [];
      try {
        const created = await Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            ctx.sandbox({ network: 'disabled', timeout: 15000 }).then((s) => ({ s, i }))
          )
        );
        ctx.assert.equal(created.length, 50, 'all 50 sandboxes must be created');

        const outcomes = await Promise.all(
          created.map(async ({ s, i }) => {
            const e = await s.exec(`node -e "console.log('sandbox-' + ${i} + '-done')"`, { timeout: 10000 });
            await e.wait();
            return { i, exitCode: e.exitCode, stdout: e.stdout() };
          })
        );

        for (const o of outcomes) {
          ctx.assert.equal(o.exitCode, 0, `sandbox ${o.i} workload must exit 0`);
          ctx.assert.ok(o.stdout.includes(`sandbox-${o.i}-done`), `sandbox ${o.i} output must be correct`);
        }
        sandboxes.push(...created.map((c) => c.s));
      } finally {
        await Promise.all(sandboxes.map((s) => s.destroy().catch(() => undefined)));
        for (const s of sandboxes) ctx.untrack(s);
      }
      st.end();
    }

    // ── 20 concurrent executions in a single sandbox ─────────────────────
    {
      const st = ctx.step('20-execs');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 15000 });
      const execs = Array.from({ length: 20 }, (_, i) =>
        (async () => {
          const e = await sandbox.exec(`node -e "console.log('exec-' + ${i})"`, { timeout: 10000 });
          await e.wait();
          return { i, e };
        })()
      );
      const settled = await Promise.all(execs);
      for (const { i, e } of settled) {
        ctx.assert.equal(e.exitCode, 0, `parallel exec ${i} must exit 0`);
        ctx.assert.ok(e.stdout().includes(`exec-${i}`), `parallel exec ${i} output must be correct`);
      }
      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    const pgidsAfter = ctx.snapshotPgids();
    ctx.assertPgidsDead([...new Set([...allPgids, ...pgidsAfter])], 'concurrency');
    ctx.assertNoResidue(baseline, 'concurrency');
  },
};
