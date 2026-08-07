/**
 * Demonstrates: graceful handling of a SIGTERM-ignoring child.
 *
 * A workload that installs a SIGTERM no-op handler must still be terminated
 * at the wall-clock timeout. The backend escalates SIGTERM → SIGKILL after a
 * grace period, so wait() must settle with status 'timedout' despite the
 * child refusing to exit on SIGTERM.
 *
 * Expected: status 'timedout' within the escalation window; exit code 0.
 * Violated: wait() hangs or the process never dies; exit 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
  try {
    const execution = await sandbox.exec(
      'node -e "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"',
      { timeout: 200 }
    );
    await execution.wait();

    if (execution.status() !== 'timedout') {
      console.error(`VIOLATED: expected 'timedout', got '${execution.status()}'`);
      process.exit(1);
    }

    console.log('PASS: SIGTERM-ignoring child force-killed at timeout');
    process.exit(0);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
