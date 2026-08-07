/**
 * Demonstrates: `network: 'disabled'` blocks outbound UDP.
 *
 * A workload inside a sandbox created with network: 'disabled' must be unable
 * to send UDP packets to external hosts. RFC 0004 implements this via
 * `unshare -n --user --map-root-user` on Linux and `sandbox-exec` on macOS.
 *
 * Expected (guarantee holds): send fails; exit code 0.
 * Violated (if isolation broken): send succeeds; exit code 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000, network: 'disabled' });
  try {
    const execution = await sandbox.exec(
      'node -e "const dgram=require(\'dgram\');const sock=dgram.createSocket(\'udp4\');sock.on(\'error\',(err)=>{console.log(\'BLOCKED\');process.exit(0)});sock.on(\'listening\',()=>{sock.send(Buffer.from(\'test\'),53,\'1.1.1.1\',(err)=>{if(err){console.log(\'BLOCKED_SEND\');process.exit(0)}else{console.log(\'SENT\');process.exit(1)}})});sock.bind(0)"',
      { timeout: 5000 }
    );
    await execution.wait();

    if (execution.exitCode === 0) {
      console.log('PASS: outbound UDP blocked under network: disabled');
      process.exit(0);
    }
    console.error('VIOLATED: outbound UDP succeeded under network: disabled');
    process.exit(1);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
