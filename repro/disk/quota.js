/**
 * Demonstrates: virtual filesystem disk quota enforcement.
 *
 * Writes beyond the configured diskQuota must be rejected with
 * SandboxResourceError code ERR_DISK_QUOTA_EXCEEDED, and the sandbox must
 * remain healthy and reusable afterwards.
 *
 * Expected: small write OK; oversized write rejected; recovery write OK.
 * Violated: oversized write succeeds, or sandbox breaks afterwards; exit 1.
 */
'use strict';

const { Sandbox, SandboxResourceError } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', diskQuota: '1KB', timeout: 5000 });
  try {
    // 1. Within quota.
    await sandbox.writeFile('small.txt', 'Hello world');
    console.log('PASS: small write within quota');

    // 2. Exceed quota.
    const largeContent = 'X'.repeat(2048);
    try {
      await sandbox.writeFile('large.txt', largeContent);
      console.error('VIOLATED: oversized write succeeded despite 1KB quota');
      process.exit(1);
    } catch (err) {
      if (!(err instanceof SandboxResourceError) || err.code !== 'ERR_DISK_QUOTA_EXCEEDED') {
        console.error('VIOLATED: expected ERR_DISK_QUOTA_EXCEEDED, got:', err.code ?? err);
        process.exit(1);
      }
      console.log('PASS: oversized write rejected with ERR_DISK_QUOTA_EXCEEDED');
      console.log(`      resource=${err.resource} recoverable=${err.recoverable}`);
    }

    // 3. Recovery: sandbox still usable.
    await sandbox.writeFile('recovery.txt', 'OK');
    const readBuf = await sandbox.readFile('recovery.txt');
    if (readBuf.toString() !== 'OK') {
      console.error('VIOLATED: recovery write/read failed');
      process.exit(1);
    }
    console.log('PASS: sandbox reusable after quota rejection');

    process.exit(0);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
