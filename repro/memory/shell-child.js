/**
 * Demonstrates: memory limit enforcement on a shell background child.
 *
 * `node alloc & wait $!` keeps a tiny shell parent while the real workload
 * runs as a descendant. Only process-group accounting can see the child's
 * RSS; a top-level-PID sampler misses it. The child must be killed and wait()
 * must reject with ERR_OOM_EXCEEDED.
 *
 * Expected: child killed; exit code 0.
 * Violated: child survives, or escapes accounting; exit 1.
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
    const execution = await sandbox.exec(`node -e "${allocScript}" & wait $!`, {
      memory: '8MB',
      timeout: 5000,
    });
    await execution.wait();
    console.error('VIOLATED: shell child finished despite exceeding memory limit');
    process.exit(1);
  } catch (err) {
    if (err.code === 'ERR_OOM_EXCEEDED') {
      console.log('PASS: shell child terminated with ERR_OOM_EXCEEDED');
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
