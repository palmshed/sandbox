/**
 * Demonstrates: nested process-tree cleanup on timeout.
 *
 * sh → node → node grandchild. When the wall-clock timeout fires, the entire
 * process group must be killed (not just the top-level shell). wait() must
 * resolve with status 'timedout', and no descendant workload processes may
 * remain on the host.
 *
 * Expected: nested tree killed; status 'timedout'; no leaked processes.
 * Violated: a descendant survives, or wait() never settles; exit 1.
 */
'use strict';

const { execSync } = require('child_process');
const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
  try {
    const script = `
      const { spawn } = require('child_process');
      const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)']);
      setInterval(() => {}, 1000);
    `.replace(/\n/g, ' ');

    const execution = await sandbox.exec(`node -e "${script}"`, { timeout: 300 });
    await execution.wait();

    if (execution.status() !== 'timedout') {
      console.error(`VIOLATED: expected 'timedout', got '${execution.status()}'`);
      process.exit(1);
    }

    // Verify no descendant survived. The grandchild runs setInterval with no
    // output, so use pgrep on the marker string in the -e payload.
    let leaked = '';
    try {
      leaked = execSync('pgrep -f "setInterval(() => {}, 1000)" || true', { encoding: 'utf-8' }).trim();
    } catch {
      leaked = '';
    }
    if (leaked) {
      console.error('VIOLATED: leaked descendant processes:', leaked.split('\n').join(', '));
      process.exit(1);
    }

    console.log('PASS: nested process tree killed on timeout, no leaks');
    process.exit(0);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
