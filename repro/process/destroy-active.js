/**
 * Demonstrates: destroy() while executions are active and streaming.
 *
 * Destroying a sandbox with live, streaming child processes must terminate
 * every active process and clean up without throwing. No workload process may
 * survive the destroy.
 *
 * Expected: destroy() resolves; no leaked processes; exit code 0.
 * Violated: destroy() throws, or a workload survives; exit 1.
 */
'use strict';

const { execSync } = require('child_process');
const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
  try {
    const exec1 = await sandbox.exec('node -e "setInterval(() => console.log(\'exec1\'), 100)"');
    const exec2 = await sandbox.exec('node -e "setInterval(() => console.log(\'exec2\'), 100)"');

    await sandbox.destroy();

    let leaked = '';
    try {
      leaked = execSync('pgrep -f "console.log(\'exec1\')" ; pgrep -f "console.log(\'exec2\')"', { encoding: 'utf-8' }).trim();
    } catch {
      leaked = '';
    }
    if (leaked) {
      console.error('VIOLATED: leaked streaming processes:', leaked.split('\n').join(', '));
      process.exit(1);
    }

    console.log('PASS: destroy() cleaned up active streaming executions');
    process.exit(0);
  } catch (e) {
    console.error('VIOLATED: destroy() threw or leaked processes:', e.message ?? e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
