import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '../index.js';

/**
 * Peak memory reporting (issue #8, narrowed scope).
 *
 * Contract: `peakMemoryBytes` is an optional best-effort lower bound on
 * process-group RSS in bytes, present on both `ExecResult` and
 * `ExecutionMetadata`, absent when no sample succeeded. A sustained
 * allocation held past the sample interval must be reflected; a trivial
 * exec may legitimately report undefined.
 */
test('Peak memory reporting (native backend)', async (t) => {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 30000 });

  t.after(async () => {
    await sandbox.destroy();
  });

  await t.test('reports a peak covering a sustained allocation without any limit configured', async () => {
    const allocBytes = 40 * 1024 * 1024;
    const execution = await sandbox.exec(
      `node -e "const a = Buffer.alloc(${allocBytes}, 1); setTimeout(() => {}, 1500);"`
    );
    await execution.wait();

    assert.equal(execution.status(), 'completed');
    const meta = execution.metadata()!;
    const result = execution.result()!;
    assert.ok(
      meta.peakMemoryBytes !== undefined,
      'expected a peak sample for a 1.5s execution'
    );
    assert.equal(result.peakMemoryBytes, meta.peakMemoryBytes);
    assert.ok(
      meta.peakMemoryBytes >= allocBytes * 0.75,
      `peak ${meta.peakMemoryBytes} should cover most of the ${allocBytes} allocation`
    );
  });

  await t.test('peak is a lower bound that never exceeds a sane multiple of the footprint', async () => {
    const allocBytes = 20 * 1024 * 1024;
    const execution = await sandbox.exec(
      `node -e "const a = Buffer.alloc(${allocBytes}, 1); setTimeout(() => {}, 1200);"`
    );
    await execution.wait();

    const peak = execution.metadata()!.peakMemoryBytes;
    assert.ok(peak !== undefined);
    // Group RSS includes the node runtime itself; anything wildly above the
    // allocation plus runtime headroom indicates double counting.
    assert.ok(peak < allocBytes + 512 * 1024 * 1024, `peak ${peak} is implausibly large`);
  });
});
