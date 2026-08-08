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
  assert.equal(typeof sandbox.capabilities.networkIsolation, 'boolean');
  assert.equal(typeof sandbox.capabilities.cpuLimits, 'boolean');
  assert.equal(typeof sandbox.capabilities.memoryLimits, 'boolean');

  // 3. Execution & exit code
  const execution = await sandbox.exec('node -e "console.log(\'sandbox ok\')"');
  assert.equal(execution.status(), 'running');
  assert.match(execution.id, /^exec_/);
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

  // 4. Stream handle verification (Readable stream from accumulated stdout)
  const stream = execution.stdoutStream();
  let streamBuf = '';
  for await (const chunk of stream) {
    streamBuf += chunk;
  }
  assert.equal(streamBuf.trim(), 'sandbox ok');

  // 5. Exit event with code
  const exitExec = await sandbox.exec('node -e "process.exit(42)"');
  let capturedExitCode: number | null = null;
  exitExec.on('exit', (code) => { capturedExitCode = code; });
  await exitExec.wait();
  assert.equal(exitExec.exitCode, 42);
  assert.equal(exitExec.status(), 'failed');
  assert.equal(capturedExitCode, 42);

  // 6. stderr capture
  const stderrExec = await sandbox.exec('node -e "process.stderr.write(\'err channel\')"');
  await stderrExec.wait();
  assert.equal(stderrExec.status(), 'completed');
  assert.equal(stderrExec.stderr().trim(), 'err channel');

  // 7. Metadata & result inspection
  const metaExec = await sandbox.exec('echo "metadata test"');
  await metaExec.wait();
  const meta = metaExec.metadata();
  assert.ok(meta, 'metadata object available after wait()');
  assert.equal(meta!.backend, 'native');
  assert.equal(meta!.specVersion, '1.0.0');
  assert.equal(typeof meta!.startedAt, 'string');
  assert.equal(typeof meta!.finishedAt, 'string');
  assert.ok(meta!.durationMs >= 0);
  assert.equal(meta!.timedOut, false);
  assert.equal(meta!.exitCode, 0);
  assert.equal(typeof meta!.id, 'string');

  const result = metaExec.result();
  assert.ok(result, 'result object available after wait()');
  assert.equal(typeof result!.stdout, 'string');
  assert.equal(typeof result!.stderr, 'string');
  assert.equal(typeof result!.durationMs, 'number');
  assert.equal(result!.timedOut, false);
  assert.equal(result!.exitCode, 0);

  // 8. logs() returns stdout + stderr combined
  const logsExec = await sandbox.exec('node -e "console.log(\'out line\'); process.stderr.write(\'err line\')"');
  await logsExec.wait();
  assert.ok(logsExec.logs().includes('out line'));
  assert.ok(logsExec.logs().includes('err line'));

  // 9. cancel() transitions status to cancelled
  const cancelExec = await sandbox.exec('node -e "setInterval(() => {}, 10000)"', {
    timeout: 5000,
  });
  assert.equal(cancelExec.status(), 'running');
  await cancelExec.cancel();
  assert.equal(cancelExec.status(), 'cancelled');

  // 10. destroy() cleans up and prevents further execution
  await sandbox.destroy();
  await assert.rejects(
    async () => sandbox.exec('echo "should fail"'),
    /already been destroyed/,
    'exec() after destroy() rejects',
  );

  console.log('Consumer verification passed cleanly!');
}

main().catch((err) => {
  console.error('Consumer verification failed:', err);
  process.exit(1);
});
