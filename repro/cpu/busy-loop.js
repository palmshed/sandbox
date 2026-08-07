/**
 * Demonstrates: CPU time budget enforcement on a direct busy loop.
 *
 * A workload that spins forever must be terminated once it exceeds the
 * configured CPU time budget (cpuTimeLimit, in ms of user+system CPU time),
 * and wait() must reject with SandboxResourceError code ERR_CPU_EXCEEDED.
 *
 * Expected: the busy loop is killed; exit code 0 (guarantee holds).
 * Violated: the loop completes, or wait() does not reject; exit code 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
  try {
    const execution = await sandbox.exec('node -e "let x=0; while(true){x++}"', {
      cpuTimeLimit: 300,
      timeout: 5000,
    });
    await execution.wait();
    // If we get here, the workload was NOT killed => guarantee violated.
    console.error('VIOLATED: busy loop finished despite exceeding cpuTimeLimit');
    process.exit(1);
  } catch (err) {
    if (err.code === 'ERR_CPU_EXCEEDED') {
      console.log('PASS: busy loop terminated with ERR_CPU_EXCEEDED');
      console.log(`      resource=${err.resource} recoverable=${err.recoverable}`);
      process.exit(0);
    }
    console.error('VIOLATED: unexpected error instead of ERR_CPU_EXCEEDED');
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
