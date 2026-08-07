/**
 * Demonstrates: memory limit enforcement on a direct allocation workload.
 *
 * A workload that allocates memory beyond the configured limit must be killed
 * and wait() must reject with SandboxResourceError code ERR_OOM_EXCEEDED.
 *
 * Expected: workload killed at the memory boundary; exit code 0.
 * Violated: workload completes, or wait() does not reject; exit 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
  try {
    const allocScript = `
      const chunks = [];
      for (let i = 0; i < 200; i++) { chunks.push(Buffer.alloc(1024 * 1024)); }
      setInterval(() => {}, 100);
    `.replace(/\n\s*/g, ' ');
    const execution = await sandbox.exec(`node -e "${allocScript}"`, {
      memory: '8MB',
      timeout: 5000,
    });
    await execution.wait();
    console.error('VIOLATED: allocation workload finished despite exceeding memory limit');
    process.exit(1);
  } catch (err) {
    if (err.code === 'ERR_OOM_EXCEEDED') {
      console.log('PASS: allocation workload terminated with ERR_OOM_EXCEEDED');
      console.log(`      resource=${err.resource} recoverable=${err.recoverable}`);
      process.exit(0);
    }
    console.error('VIOLATED: unexpected error instead of ERR_OOM_EXCEEDED');
    console.error(err);
    process.exit(1);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
