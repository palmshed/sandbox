/**
 * Demonstrates: CPU time budget enforcement across a shell pipeline.
 *
 * The shell parent stays idle while a backgrounded producer burns CPU
 * (`node busy | cat`). Only process-group accounting can see the producer's
 * consumption; a top-level-PID sampler would miss it. The workload must be
 * killed once the group exceeds cpuTimeLimit, and wait() must reject with
 * ERR_CPU_EXCEEDED.
 *
 * Expected: pipeline killed; exit code 0.
 * Violated: pipeline completes, or the producer escapes accounting; exit 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
  try {
    const execution = await sandbox.exec('node -e "let x=0; while(true){x++}" | cat', {
      cpuTimeLimit: 300,
      timeout: 5000,
    });
    await execution.wait();
    console.error('VIOLATED: pipeline finished despite exceeding cpuTimeLimit');
    process.exit(1);
  } catch (err) {
    if (err.code === 'ERR_CPU_EXCEEDED') {
      console.log('PASS: pipeline producer terminated with ERR_CPU_EXCEEDED');
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
