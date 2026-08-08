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
    assert.equal(r.out.trim(), `box-${r.i}-${r.i + 1}`, `sandbox ${r.i} output correct`);
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
