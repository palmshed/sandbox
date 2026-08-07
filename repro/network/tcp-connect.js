/**
 * Demonstrates: `network: 'disabled'` blocks outbound TCP.
 *
 * A workload inside a sandbox created with network: 'disabled' must be unable
 * to open an outbound TCP connection to a non-loopback host. Currently the
 * Native backend does NOT enforce this (networkIsolation is false; only proxy
 * env vars are set), so this repro is RED until RFC 0004 lands.
 *
 * Expected (guarantee holds): connect fails; exit code 0.
 * Current (violated): connect succeeds; exit code 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000, network: 'disabled' });
  try {
    const execution = await sandbox.exec(
      'node -e "const s=require(\'net\').createConnection({host:\'1.1.1.1\',port:80,timeout:2000});s.on(\'connect\',()=>{console.log(\'CONNECTED\');process.exit(0)});s.on(\'error\',e=>{console.log(\'BLOCKED\',e.code);process.exit(1)})"',
      { timeout: 5000 }
    );
    await execution.wait();

    if (execution.exitCode === 0) {
      console.error('VIOLATED: outbound TCP succeeded under network: disabled');
      process.exit(1);
    }
    console.log('PASS: outbound TCP blocked under network: disabled');
    process.exit(0);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
