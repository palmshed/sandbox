import assert from 'node:assert/strict';
import { Sandbox } from '@palmshed/sandbox';

async function main() {
  console.log('Testing consumer import and execution against packed @palmshed/sandbox artifact...');

  // 1. Creation & backend verification
  const sandbox = await Sandbox.create({
    backend: 'native',
    timeout: 5000,
  });

  assert.ok(sandbox, 'Sandbox instance created');
  assert.equal(sandbox.backendName, 'native');

  // 2. Capabilities negotiation check
  assert.equal(typeof sandbox.capabilities.filesystem, 'boolean');
  assert.equal(typeof sandbox.capabilities.streaming, 'boolean');

  // 3. Execution & exit code
  const execution = await sandbox.exec('node -e "console.log(\'sandbox ok\')"');
  assert.equal(execution.status(), 'running');
  assert.match(execution.uri, /^sandbox:\/\/execution\/exec_/);

  // Stream chunk assertion
  let streamCaptured = false;
  execution.on('stdout', (chunk) => {
    if (chunk.includes('sandbox ok')) {
      streamCaptured = true;
    }
  });

  await execution.wait();

  assert.equal(execution.status(), 'completed');
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.stdout().trim(), 'sandbox ok');
  assert.ok(streamCaptured, 'stdout stream chunk was captured via event listener');

  // 4. Stream handle verification
  const stream = execution.stdoutStream();
  let streamBuf = '';
  for await (const chunk of stream) {
    streamBuf += chunk;
  }
  assert.equal(streamBuf.trim(), 'sandbox ok');

  // 5. Cleanup verification
  await sandbox.destroy();
  console.log('Consumer verification passed cleanly!');
}

main().catch((err) => {
  console.error('Consumer verification failed:', err);
  process.exit(1);
});
