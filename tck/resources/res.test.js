import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';
import { SandboxResourceError } from '../../sdk/typescript/dist/index.js';

/**
 * Spec-Version: 0.1.2
 */
test('TCK: Resources Module [Spec-Version: 0.1.2]', async (t) => {
  const engine = new NativeBackend();
  await engine.init({ cpu: 1, memory: '512MB', diskQuota: '1KB', timeout: 20000 });

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Resource capability query', async () => {
    assert.equal(typeof engine.capabilities.cpuLimits, 'boolean');
    assert.equal(typeof engine.capabilities.memoryLimits, 'boolean');
  });

  await t.test('Exec workloads writing past diskQuota are killed with ERR_DISK_QUOTA_EXCEEDED and the sandbox recovers [v0.1.2]', async () => {
    const writeScript =
      "const fs = require('fs'); const b = Buffer.alloc(1024, 120); for (let i = 0; i < 200; i++) { fs.writeFileSync('bulk-' + i + '.bin', b); }";
    await assert.rejects(
      () => engine.exec(`node -e "${writeScript}"`),
      (err) => {
        assert.ok(err instanceof SandboxResourceError);
        assert.equal(err.recoverable, true);
        return err.code === 'ERR_DISK_QUOTA_EXCEEDED';
      }
    );
    const recovery = await engine.exec('echo "recovered"');
    assert.equal(recovery.exitCode, 0);
    assert.match(recovery.stdout, /recovered/);
  });
});
