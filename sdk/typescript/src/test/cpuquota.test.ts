import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaCoresToRate, hostCpuCores } from '../winjob/quota-job.js';
import { NativeBackend } from '../backends/native.js';

/**
 * RFC 0007 Windows Job Object rate math (platform independent) plus the live
 * readback where the mechanism exists. The math tests run everywhere; the
 * live query runs only on Windows when the backend promotes cpuQuotaLimits
 * (needs a real Job Object), mirroring the compliance gate.
 */
test('RFC 0007 Windows job rate calculation', async (t) => {
  await t.test('host core count is sane', () => {
    assert.ok(hostCpuCores() >= 1);
  });

  await t.test('quota cores map to percent-times-100 rates', () => {
    assert.equal(quotaCoresToRate(0.5, 4), 1250);
    assert.equal(quotaCoresToRate(2, 4), 5000);
    assert.equal(quotaCoresToRate(1, 1), 10000);
  });

  await t.test('above-capacity clamps to full system, tiny quotas clamp to 1', () => {
    assert.equal(quotaCoresToRate(8, 4), 10000);
    assert.equal(quotaCoresToRate(0.001, 64), 1);
    assert.equal(quotaCoresToRate(0.5, 0), 5000);
  });

  await t.test('live job reports the applied rate', async (t) => {
    if (process.platform !== 'win32') {
      return t.skip('Job Objects are Windows-only');
    }
    const backend = new NativeBackend();
    await backend.init({ cpuQuota: 0.5, timeout: 60000 });
    t.after(async () => {
      await backend.destroy();
    });
    if (backend.capabilities.cpuQuotaLimits !== true) {
      return t.skip('cpuQuotaLimits not enforced here yet; skipping until promotion');
    }
    // Any execution triggers job creation; the applied rate must read back
    // exactly as the math predicts (catches marshalling bugs: wrong struct
    // layout, wrong info class, clamp errors).
    const result = await backend.exec('echo rate-check');
    assert.equal(result.exitCode, 0);
    const internals = backend as unknown as {
      quotaHelper: { request: (req: unknown) => Promise<{ ok: boolean; rate?: number }> } | null;
      quotaJobId: string | null;
    };
    assert.ok(internals.quotaHelper !== null && internals.quotaJobId !== null);
    const queried = await internals.quotaHelper.request({ cmd: 'query', job: internals.quotaJobId });
    assert.equal(queried.ok, true);
    assert.equal(queried.rate, quotaCoresToRate(0.5, hostCpuCores()));
  });
});
