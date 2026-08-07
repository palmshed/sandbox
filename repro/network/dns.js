/**
 * Demonstrates: `network: 'disabled'` blocks DNS resolution.
 *
 * A workload inside a sandbox created with network: 'disabled' must be unable
 * to resolve hostnames (A/AAAA). Currently the Native backend does NOT enforce
 * this (networkIsolation is false), so this repro is RED until RFC 0004 lands.
 *
 * Expected (guarantee holds): resolve fails; exit code 0.
 * Current (violated): resolve succeeds; exit code 1.
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
