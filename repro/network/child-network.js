/**
 * Demonstrates: `network: 'disabled'` blocks child process network access.
 *
 * Child processes spawned inside an isolated sandbox must inherit the network
 * isolation. A background child (sh -c & wait) or pipeline child must not be
 * able to access the network. RFC 0004 applies the network namespace to the
 * entire process group, so descendants inherit the isolation.
 *
 * Expected (guarantee holds): child connects fail; exit code 0.
 * Violated (if isolation broken): child connects succeed; exit code 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000, network: 'disabled' });
  try {
    const execution = await sandbox.exec(
      'sh -c "node -e \\"const s=require(\'net\').createConnection({host:\'1.1.1.1\',port:80,timeout:2000});s.on(\'connect\',()=>{console.log(\'CHILD_CONNECTED\');process.exit(0)});s.on(\'error\',e=>{console.log(\'CHILD_BLOCKED\');process.exit(1)})\\""',
      { timeout: 5000 }
    );
    await execution.wait();

    if (execution.exitCode === 0) {
      console.error('VIOLATED: child process network access succeeded under network: disabled');
      process.exit(1);
    }
    console.log('PASS: child process network access blocked under network: disabled');
    process.exit(0);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
