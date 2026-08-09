/**
 * production/scenarios/crash-recovery.mjs
 *
 * End-to-end crash recovery (RFC 0005): a separate host process creates a
 * live sandbox and starts a long-running workload, then is hard-killed
 * (SIGKILL). Its sandbox dir, registry entry, and orphaned workload must all
 * survive the crash, and the next fresh create must reap them. The fresh
 * sandbox must be fully usable afterward, with zero residue.
 *
 * This is the only production scenario that exercises recovery across process
 * boundaries against the packed artifact: the host fixture resolves
 * @palmshed/sandbox from the same installed package the suite validates.
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { fileURLToPath } from 'url';

const BUDGET_MS = 120000;
const FIXTURE = fileURLToPath(new URL('./fixtures/crash-host.cjs', import.meta.url));

async function waitUntil(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export default {
  id: 'crash-recovery',
  title: 'Crash recovery: hard-killed host, orphan reaped on next create',
  timeoutMs: BUDGET_MS,
  run: async (ctx) => {
    const baseline = ctx.scanResidue();
    const allPgids = new Set(ctx.snapshotPgids());
    const stateFile = path.join(os.tmpdir(), `crash-rec-${process.pid}-${Date.now()}.json`);

    let host;
    let stderr = '';
    try {
      const st = ctx.step('host-crash');
      host = spawn(process.execPath, [FIXTURE, stateFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      host.stderr.on('data', (d) => (stderr += d.toString()));

      // ── host must bring up a sandbox and a running workload ─────────────
      let state = null;
      await waitUntil(
        () => {
          if (fs.existsSync(stateFile)) {
            try {
              state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
              return true;
            } catch {
              return false;
            }
          }
          return false;
        },
        30000
      );
      ctx.assert.ok(state && state.dir, 'host must report its sandbox dir before crash');
      ctx.assert.ok(fs.existsSync(state.dir), 'host sandbox dir must exist before crash');
      ctx.assert.ok(pidAlive(state.workloadPid), 'host workload must be running before crash');

      // ── hard-kill the host: nothing may run cleanup hooks ───────────────
      host.kill('SIGKILL');
      await once(host, 'exit');

      ctx.assert.ok(fs.existsSync(state.dir), 'crashed sandbox dir must survive the host crash');
      ctx.assert.ok(pidAlive(state.workloadPid), 'orphaned workload must survive the host crash');
      allPgids.add(state.workloadPid);
      st.end();

      // ── the next create reaps the orphan ────────────────────────────────
      const s = await ctx.sandbox({ network: 'disabled', timeout: 15000 });
      await waitUntil(
        () => !fs.existsSync(state.dir) && !pidAlive(state.workloadPid),
        30000
      );
      ctx.assert.ok(!fs.existsSync(state.dir), 'crashed sandbox dir must be reaped on next create');
      ctx.assert.ok(!pidAlive(state.workloadPid), 'orphaned workload must be killed by the reaper');

      // ── fresh sandbox must be usable ─────────────────────────────────────
      const probe = await s.exec('node -e "console.log(\'crash-recovery-reuse\')"', { timeout: 5000 });
      await probe.wait();
      ctx.assert.equal(probe.exitCode, 0, 'fresh sandbox must be usable after the crash-recovery reap');
      ctx.assert.ok(probe.stdout().includes('crash-recovery-reuse'), 'reuse probe output must match');

      await s.destroy();
      ctx.untrack(s);
    } finally {
      if (host && host.exitCode === null) host.kill('SIGKILL');
      fs.rmSync(stateFile, { force: true });
    }

    const pgidsAfter = ctx.snapshotPgids();
    ctx.assertPgidsDead([...new Set([...allPgids, ...pgidsAfter])], 'crash-recovery');
    ctx.assertNoResidue(baseline, 'crash-recovery');
  },
};