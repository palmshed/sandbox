/**
 * production/scenarios/code-evaluator.mjs
 *
 * Code execution platform workflow: many sandboxes evaluate untrusted
 * submissions concurrently, mixing success, failure, timeout, and a
 * CPU-budget kill, then everything is destroyed and residue is verified.
 *
 * The important assertion is not "this submission failed": it is that each
 * outcome was reported with the correct state, resource-limited sandboxes
 * stayed reusable, and destroying every sandbox returned the host to its
 * prior state with no leaked processes or directories.
 */

const SUBMISSIONS = {
  pass: [
    `const sum = [1,2,3,4,5].reduce((a,b) => a + b, 0); console.log(JSON.stringify({ sum, ok: true }));`,
    `for (let i = 1; i <= 5; i++) console.log('line ' + i);`,
    `const fs = require('fs'); fs.writeFileSync('out.txt', 'eval-done'); console.log('wrote');`,
    `console.log(2 ** 20);`,
    `const a = [3,1,4,1,5,9]; console.log(Math.max(...a));`,
    `let n = 0; for (let i = 0; i < 10000; i++) n += i; console.log(n);`,
    `console.log('ok' === 'ok');`,
    `const obj = { a: 1, b: 2 }; console.log(Object.keys(obj).join(','));`,
    `console.log('hello from submission');`,
    `const arr = Array.from({ length: 1000 }, (_, i) => i).reduce((a, b) => a + b, 0); console.log(arr);`,
  ],
  fail: [
    `process.exit(2);`,
    `console.error('boom'); process.exit(1);`,
    `throw new Error('unhandled crash');`,
    `process.exit(7);`,
  ],
  timeout: [
    `while (true) {}`,
    `setInterval(() => {}, 10);`,
    `for (;;) { Math.random(); }`,
  ],
  cpu: [
    `for (;;) { Math.sqrt(Math.random()); }`,
    `while (true) { Date.now(); }`,
    `let i = 0; while (true) { i = (i + 1) % 100000; }`,
  ],
};

export default {
  id: 'code-evaluator',
  title: 'Code evaluator: 20 sandboxes, mixed outcomes, concurrency, residue',
  timeoutMs: 180000,
  run: async (ctx) => {
    const baseline = ctx.scanResidue();
    const submissions = [
      ...SUBMISSIONS.pass.map((code) => ({ code, expect: 'pass' })),
      ...SUBMISSIONS.fail.map((code) => ({ code, expect: 'fail' })),
      ...SUBMISSIONS.timeout.map((code) => ({ code, expect: 'timeout' })),
      ...SUBMISSIONS.cpu.map((code) => ({ code, expect: 'cpu' })),
    ];
    ctx.assert.equal(submissions.length, 20, 'exactly 20 submissions');

    // Track workload roots recorded in the registry during the run so we can
    // assert none survive after every sandbox is destroyed.
    const pgidsBefore = new Set(ctx.snapshotPgids());

    const results = [];
    const poolSize = 8;
    const queue = [...submissions];
    const workers = [];

    const st = ctx.step('evaluate-20');
    for (let w = 0; w < poolSize; w++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const submission = queue.shift();
            const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 15000 });
            let outcome;
            try {
              await sandbox.writeFile('solution.js', submission.code);
              const execution = await sandbox.exec('node solution.js', {
                timeout: submission.expect === 'timeout' ? 300 : 5000,
                cpuTimeLimit: submission.expect === 'cpu' ? 250 : undefined,
              });
              let rejection = null;
              try {
                await execution.wait();
              } catch (err) {
                rejection = err;
              }
              outcome = {
                expect: submission.expect,
                status: execution.status(),
                exitCode: execution.exitCode,
                timedOut: execution.timedOut,
                rejectionCode: rejection ? rejection.code : null,
              };

              // A resource-limited sandbox must stay reusable (recoverable: true).
              if (outcome.expect === 'cpu') {
                ctx.assert.equal(outcome.rejectionCode, 'ERR_CPU_EXCEEDED', 'cpu-limit submission must report ERR_CPU_EXCEEDED');
                const reuse = await sandbox.exec('node -e "console.log(\'reuse-after-cpu\')"', { timeout: 5000 });
                await reuse.wait();
                ctx.assert.equal(reuse.exitCode, 0, 'sandbox must be reusable after a CPU-budget kill');
              }
            } finally {
              await sandbox.destroy();
              ctx.untrack(sandbox);
            }
            results.push(outcome);
          }
        })()
      );
    }
    await Promise.all(workers);
    st.end();

    // Outcome classification: every submission must be reported exactly as the
    // platform intends, not merely "the command failed".
    const counts = { pass: 0, fail: 0, timeout: 0, cpu: 0 };
    for (const r of results) {
      if (r.expect === 'pass') {
        ctx.assert.equal(r.status, 'completed', 'pass submission must complete');
        ctx.assert.equal(r.exitCode, 0, 'pass submission must exit 0');
        counts.pass++;
      } else if (r.expect === 'fail') {
        ctx.assert.equal(r.status, 'failed', 'fail submission must be reported failed');
        ctx.assert.notEqual(r.exitCode, 0, 'fail submission must exit non-zero');
        counts.fail++;
      } else if (r.expect === 'timeout') {
        ctx.assert.equal(r.status, 'timedout', 'timeout submission must be reported timedout');
        ctx.assert.ok(r.timedOut, 'timeout submission must set timedOut');
        counts.timeout++;
      } else {
        ctx.assert.equal(r.rejectionCode, 'ERR_CPU_EXCEEDED', 'cpu submission must reject with ERR_CPU_EXCEEDED');
        counts.cpu++;
      }
    }
    ctx.assert.equal(counts.pass, 10, '10 submissions must pass');
    ctx.assert.equal(counts.fail, 4, '4 submissions must fail');
    ctx.assert.equal(counts.timeout, 3, '3 submissions must time out');
    ctx.assert.equal(counts.cpu, 3, '3 submissions must hit the CPU budget');

    // Post-run health: a fresh sandbox works and all recorded workloads are dead.
    const probe = await ctx.sandbox({ network: 'disabled', timeout: 10000 });
    const probeExec = await probe.exec('node -e "console.log(\'platform-alive\')"', { timeout: 5000 });
    await probeExec.wait();
    ctx.assert.equal(probeExec.exitCode, 0, 'platform must stay healthy after the batch');
    await probe.destroy();
    ctx.untrack(probe);

    const pgidsAfter = ctx.snapshotPgids();
    const allPgids = [...new Set([...pgidsBefore, ...pgidsAfter])];
    ctx.assertPgidsDead(allPgids, 'code-evaluator');
    ctx.assertNoResidue(baseline, 'code-evaluator');
  },
};
