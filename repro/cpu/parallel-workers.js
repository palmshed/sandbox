/**
 * Demonstrates: CPU time budget enforcement with multiple parallel workers.
 *
 * Several busy loops running concurrently consume CPU time far faster than a
 * single worker. The process group must still be measured as one unit: once
 * the cumulative group CPU time exceeds cpuTimeLimit, all workers are killed
 * and wait() rejects with ERR_CPU_EXCEEDED.
 *
 * Expected: parallel workers killed; exit code 0.
 * Violated: workers survive, or only some are counted; exit 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
  try {
    const execution = await sandbox.exec(
      'for i in 1 2 3; do node -e "let x=0; while(true){x++}" & done; wait',
      { cpuTimeLimit: 300, timeout: 5000 }
    );
    await execution.wait();
    console.error('VIOLATED: parallel workers survived despite exceeding cpuTimeLimit');
    process.exit(1);
  } catch (err) {
    if (err.code === 'ERR_CPU_EXCEEDED') {
      console.log('PASS: parallel workers terminated with ERR_CPU_EXCEEDED');
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
