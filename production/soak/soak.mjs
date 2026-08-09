/**
 * production/soak/soak.mjs
 *
 * Sustained soak: N sandboxes run repeated read/write/exec cycles for a fixed
 * duration, tracking iteration counts, exec throughput, and any surfaced
 * errors. Fails (exit 1) if any operation errors or if a sandbox stalls past
 * its per-step timeout.
 *
 * Usage:
 *   node production/soak/soak.mjs [--minutes 5] [--sandboxes 25] [--verbose]
 */
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as os from 'os';
import { resolveSandboxPackage, createContext } from '../lib/harness.mjs';

function parseArgs(argv) {
  const args = { minutes: 5, sandboxes: 25, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--minutes':
        args.minutes = parseInt(argv[++i], 10);
        break;
      case '--sandboxes':
        args.sandboxes = parseInt(argv[++i], 10);
        break;
      case '--verbose':
        args.verbose = true;
        break;
      default:
        throw new Error(`unknown flag: ${argv[i]}`);
    }
  }
  if (!(args.minutes >= 1 && args.minutes <= 1440)) throw new Error('--minutes must be 1..1440');
  if (!(args.sandboxes >= 1 && args.sandboxes <= 200)) throw new Error('--sandboxes must be 1..200');
  return args;
}

const WORKLOAD_DIR = 'soakwork';

export async function main(argv, { log = console.log } = {}) {
  const args = parseArgs(argv);
  const { Sandbox } = resolveSandboxPackage();
  const { ctx } = createContext({ Sandbox, log });

  const start = Date.now();
  const deadline = start + args.minutes * 60_000;
  const STEP_TIMEOUT = 20_000;
  const counters = [];
  let globalErrors = 0;

  log(`[soak] platform=${process.platform} sandboxes=${args.sandboxes} minutes=${args.minutes}`);

  const sandboxes = [];
  try {
    for (let i = 0; i < args.sandboxes; i++) {
      sandboxes.push(await ctx.sandbox({ network: 'disabled', timeout: 120000 }));
    }
    log(`[soak] created ${sandboxes.length} sandboxes`);

    for (const [i, sandbox] of sandboxes.entries()) {
      const c = { id: i, iterations: 0, failures: 0, lastOk: 0 };
      counters.push(c);
      (async () => {
        while (Date.now() < deadline) {
          const t0 = Date.now();
          try {
            const tag = `s${i}-it${c.iterations}`;
            await sandbox.writeFile(`${WORKLOAD_DIR}/${tag}.txt`, tag);
            const back = await sandbox.readFile(`${WORKLOAD_DIR}/${tag}.txt`);
            if (back.toString('utf-8') !== tag) throw new Error('soak round-trip mismatch');
            const e = await sandbox.exec(
              `node -e "console.log('${tag}')"`,
              { timeout: STEP_TIMEOUT, workDir: WORKLOAD_DIR }
            );
            await e.wait();
            if (e.exitCode !== 0) throw new Error(`exec exited ${e.exitCode}: ${e.stderr().slice(0, 200)}`);
            c.iterations += 1;
            c.lastOk = Date.now();
          } catch (err) {
            c.failures += 1;
            globalErrors += 1;
            log(`[soak] sandbox ${i} error: ${err.message}`);
          }
          const elapsed = Date.now() - t0;
          if (elapsed > STEP_TIMEOUT * 1.5) {
            c.failures += 1;
            globalErrors += 1;
            log(`[soak] sandbox ${i} slow step: ${elapsed}ms`);
          }
        }
      })();
    }

    // Watchdog: a sandbox whose last successful iteration is stale is stalled.
    const checkInterval = setInterval(() => {
      const now = Date.now();
      for (const c of counters) {
        const staleFor = now - c.lastOk;
        if (staleFor > 60_000 && now < deadline) {
          c.failures += 1;
          globalErrors += 1;
          log(`[soak] sandbox ${c.id} stalled (no success for ${(staleFor / 1000).toFixed(0)}s)`);
          c.lastOk = now; // only report once per stall window
        }
      }
    }, 15_000);

    // Wait for the deadline, then give stragglers a moment to finish.
    const remaining = Math.max(0, deadline - Date.now());
    await new Promise((r) => setTimeout(r, remaining + 15_000));
    clearInterval(checkInterval);
  } finally {
    await ctx.cleanup();
  }

  const totalMs = Date.now() - start;
  const totalIters = counters.reduce((s, c) => s + c.iterations, 0);
  const totalFailures = counters.reduce((s, c) => s + c.failures, 0);
  const rate = totalMs > 0 ? ((totalIters * 1000) / totalMs).toFixed(1) : '0';

  log('\n[soak] summary');
  log(`  sandboxes     : ${sandboxes.length}`);
  log(`  duration      : ${(totalMs / 1000).toFixed(1)}s`);
  log(`  iterations    : ${totalIters}`);
  log(`  iterations/s  : ${rate}`);
  log(`  failures      : ${totalFailures}`);
  if (args.verbose) {
    for (const c of counters) {
      log(`  sandbox ${c.id}: iterations=${c.iterations} failures=${c.failures}`);
    }
  }

  return totalFailures + globalErrors === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[soak] fatal: ${err.message}`);
      process.exit(2);
    });
}
