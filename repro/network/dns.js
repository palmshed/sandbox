/**
 * Demonstrates: `network: 'disabled'` blocks DNS resolution.
 *
 * A workload inside a sandbox created with network: 'disabled' must be unable
 * to resolve hostnames (A/AAAA). RFC 0004 implements this via
 * `unshare -n --user --map-root-user` on Linux and `sandbox-exec` on macOS,
 * which isolates the network namespace and blocks all external name resolution.
 *
 * Expected (guarantee holds): resolve fails; exit code 0.
 * Violated (if isolation broken): resolve succeeds; exit code 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000, network: 'disabled' });
  try {
    const execution = await sandbox.exec(
      'node -e "require(\'dns\').resolve(\'example.com\',(e,a)=>{console.log(e?(\'BLOCKED\'+e.code):(\'RESOLVED\'+a));process.exit(e?0:1)})"',
      { timeout: 5000 }
    );
    await execution.wait();

    // Inner node exits 0 when DNS is blocked, 1 when it resolves.
    if (execution.exitCode !== 0) {
      console.error('VIOLATED: DNS resolution succeeded under network: disabled');
      process.exit(1);
    }
    console.log('PASS: DNS resolution blocked under network: disabled');
    process.exit(0);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
