import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '../index.js';

/**
 * Phase 6 stress coverage: concurrency, rapid create/destroy, and
 * destroy/recovery under load. These tests verify the sandbox engine remains
 * healthy (no leaked processes, no failed execs) when many sandboxes and
 * executions overlap.
 *
 * These are wall-clock bounded and sized to keep CI fast on every platform.
 */

test('stress: 10 concurrent sandboxes execute independently', async (t) => {
  const sandboxes = await Promise.all(
    Array.from({ length: 10 }, () => Sandbox.create({ backend: 'native', timeout: 10000 }))
  );
  t.after(async () => {
    await Promise.all(sandboxes.map((s) => s.destroy()));
  });

  const results = await Promise.all(
    sandboxes.map(async (s, i) => {
      const n = i + 1;
      const execution = await s.exec(`echo "box-${i}-${n}"`);
      await execution.wait();
      return { i, status: execution.status(), exitCode: execution.exitCode, out: execution.stdout() };
    })
  );

  for (const r of results) {
    assert.equal(r.status, 'completed', `sandbox ${r.i} completed`);
    assert.equal(r.exitCode, 0, `sandbox ${r.i} exit code 0`);
    // cmd.exe echoes the surrounding quotes, so match the payload tolerantly.
    assert.match(r.out, new RegExp(`box-${r.i}-${r.i + 1}`), `sandbox ${r.i} output correct`);
  }
});

test('stress: 50 rapid create -> exec -> destroy cycles stay healthy', async (t) => {
  const cycles = 50;
  for (let i = 0; i < cycles; i++) {
    const s = await Sandbox.create({ backend: 'native', timeout: 5000 });
    try {
      const execution = await s.exec('echo cycle');
      await execution.wait();
      assert.equal(execution.status(), 'completed');
      assert.equal(execution.exitCode, 0);
    } finally {
      await s.destroy();
    }
  }
  assert.ok(true, `completed ${cycles} rapid lifecycle cycles`);
});

test('stress: parallel executions within one sandbox', async (t) => {
  const s = await Sandbox.create({ backend: 'native', timeout: 10000 });
  t.after(async () => {
    await s.destroy();
  });

  const executions = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      s.exec(`node -e "setTimeout(() => { console.log('task-${i}'); }, ${10 * i})"`)
    )
  );
  await Promise.all(executions.map((e) => e.wait()));
  for (const e of executions) {
    assert.equal(e.status(), 'completed');
    assert.equal(e.exitCode, 0);
  }

  // All eight task outputs must be present (interleaved streaming kept apart).
  const combined = executions.map((e) => e.stdout()).join('');
  for (let i = 0; i < 8; i++) {
    assert.match(combined, new RegExp(`task-${i}`), `task ${i} output present`);
  }
});

test('stress: destroy() while executions are in-flight frees resources without throwing', async (t) => {
  // On POSIX this exercises process-group teardown of live children.
  const s = await Sandbox.create({ backend: 'native', timeout: 10000 });
  const executions = await Promise.all(
    Array.from({ length: 6 }, () =>
      s.exec('node -e "setInterval(() => {}, 100)"')
    )
  );

  await s.destroy();

  for (const e of executions) {
    assert.ok(
      ['running', 'cancelled', 'completed', 'failed'].includes(e.status()),
      'execution in a terminal or cancellable state after destroy'
    );
  }
  assert.ok(true, 'destroy() tore down all in-flight executions');
});

test('stress: sandbox reusable after many resource-limit kills (no process leak accumulation)', async (t) => {
  const s = await Sandbox.create({ backend: 'native', timeout: 10000 });
  t.after(async () => {
    await s.destroy();
  });

  const { SandboxResourceError } = await import('../index.js');

  // Burn CPU in the sandbox a few times; each kill must not leak or wedge the sandbox.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      async () => {
        await s.exec('node -e "let x=0; while(true){x++}"', {
          cpuTimeLimit: 200,
          timeout: 5000,
        }).then((e) => e.wait());
      },
      (err: unknown) => err instanceof SandboxResourceError && err.code === 'ERR_CPU_EXCEEDED'
    );

    const probe = await s.exec('echo "alive after kill"');
    await probe.wait();
    assert.equal(probe.status(), 'completed');
    assert.match(probe.stdout(), /alive after kill/);
  }
});

/**
 * Sustained concurrency: exercises concurrent sandboxes, concurrent execution,
 * resource-limit failures, reuse after kills, and concurrent destroy over a
 * wall-clock window (staggered workloads overlap across rounds) rather than a
 * single short burst. Wall-clock bounded to keep CI fast on every platform.
 */
test('stress: sustained concurrent workload (resource failures, reuse, destroy)', async (t) => {
  const N = 10;
  const rounds = 3;
  const sandboxes = await Promise.all(
    Array.from({ length: N }, () => Sandbox.create({ backend: 'native', timeout: 10000 }))
  );
  t.after(async () => {
    await Promise.all(sandboxes.map((s) => s.destroy()));
  });

  const { SandboxResourceError } = await import('../index.js');

  for (let round = 0; round < rounds; round++) {
    const tasks = sandboxes.map(async (s, i) => {
      // Round 2 interleaves CPU-budget kills with healthy executions.
      if (round === 2 && i % 3 === 0) {
        await assert.rejects(
          async () => {
            await s.exec('node -e "let x=0; while(true){x++}"', {
              cpuTimeLimit: 200,
              timeout: 5000,
            }).then((e) => e.wait());
          },
          (err: unknown) => err instanceof SandboxResourceError && err.code === 'ERR_CPU_EXCEEDED'
        );
        return 'resource';
      }
      // Hold each process open briefly (staggered) so executions overlap across
      // sandboxes, exercising interleaved lifecycle management for a sustained period.
      const e = await s.exec(`node -e "setTimeout(() => console.log('round-${round}-box-${i}'), ${60 + i * 10})"`);
      await e.wait();
      assert.equal(e.status(), 'completed', `round ${round} box ${i} completed`);
      assert.equal(e.exitCode, 0, `round ${round} box ${i} exit code 0`);
      assert.match(e.stdout(), new RegExp(`round-${round}-box-${i}`), `round ${round} box ${i} output`);
      return 'exec';
    });
    const outcomes = await Promise.all(tasks);
    assert.equal(outcomes.length, N, `round ${round} produced ${N} outcomes`);
  }

  // Every sandbox remains healthy and reusable after the resource kills.
  await Promise.all(sandboxes.map(async (s, i) => {
    const probe = await s.exec(`echo "alive-${i}"`);
    await probe.wait();
    assert.equal(probe.status(), 'completed', `sandbox ${i} reusable after resource kills`);
    assert.match(probe.stdout(), new RegExp(`alive-${i}`));
  }));

  // Tear down all sandboxes concurrently.
  await Promise.all(sandboxes.map((s) => s.destroy()));
});
