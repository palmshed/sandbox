/**
 * Demonstrates: `network: 'disabled'` blocks localhost host-service access.
 *
 * A workload inside a sandbox created with network: 'disabled' must be unable
 * to reach host services listening on 127.0.0.1 (databases, agent APIs, dev
 * servers). RFC 0004 implements this via `unshare -n --user --map-root-user`
 * on Linux (the netns loopback is isolated and down) and `sandbox-exec` on macOS.
 *
 * Expected (guarantee holds): connect to localhost service fails; exit 0.
 * Violated (if isolation broken): connect succeeds; exit 1.
 */
'use strict';

const { Sandbox } = require('../../sdk/typescript/dist/index.js');

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000, network: 'disabled' });
  try {
    // Bind a listener on the HOST side, then try to reach it from the sandbox.
    const net = require('net');
    const listener = net.createServer();
    await new Promise((res) => listener.listen(0, '127.0.0.1', res));
    const port = listener.address().port;
    let hostConnects = 0;
    listener.on('connection', () => { hostConnects++; });

    const execution = await sandbox.exec(
      `node -e "const s=require('net').createConnection({host:'127.0.0.1',port:${port},timeout:1500});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('BLOCKED',e.code);process.exit(1)})"`,
      { timeout: 5000 }
    );
    await execution.wait();

    await new Promise((res) => listener.close(res));

    if (execution.exitCode === 0 && hostConnects > 0) {
      console.error('VIOLATED: localhost host-service access succeeded under network: disabled');
      process.exit(1);
    }
    console.log('PASS: localhost host-service access blocked under network: disabled');
    process.exit(0);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((e) => {
  console.error('VIOLATED: unhandled error', e);
  process.exit(1);
});
