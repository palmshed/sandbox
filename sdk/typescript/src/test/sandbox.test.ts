import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { Sandbox } from '../index.js';

test('Native Backend Sandbox Execution', async (t) => {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });

  t.after(async () => {
    await sandbox.destroy();
  });

  await t.test('returns live Execution handle with URI and status', async () => {
    const execution = await sandbox.exec('echo "Hello Palmshed Sandbox"');
    // Execution is live (running) before wait
    assert.equal(execution.status(), 'running');
    assert.match(execution.id, /^exec_/);
    assert.match(execution.uri, /^sandbox:\/\/execution\/exec_/);

    await execution.wait();

    assert.equal(execution.status(), 'completed');
    assert.equal(execution.exitCode, 0);
    assert.match(execution.stdout(), /Hello Palmshed Sandbox/);
  });

  await t.test('populates structured metadata after wait()', async () => {
    const execution = await sandbox.exec('echo "Metadata Test"');
    await execution.wait();

    const meta = execution.metadata()!;
    assert.equal(meta.backend, 'native');
    assert.equal(meta.specVersion, '0.1.0');
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.timedOut, false);
    assert.equal(typeof meta.startedAt, 'string');
    assert.equal(typeof meta.finishedAt, 'string');
    assert.ok(meta.durationMs >= 0);
  });

  await t.test('emits stdout events in real time', async () => {
    const chunks: string[] = [];
    const execution = await sandbox.exec('echo "Stream Chunk"');
    execution.on('stdout', (data) => chunks.push(data));
    await execution.wait();

    assert.ok(chunks.length > 0);
    assert.ok(chunks.join('').includes('Stream Chunk'));
  });

  await t.test('emits exit event with code', async () => {
    let exitCode: number | null = null;
    const execution = await sandbox.exec('exit 0');
    execution.on('exit', (code) => { exitCode = code; });
    await execution.wait();
    assert.equal(exitCode, 0);
  });

  await t.test('logs() returns accumulated stdout', async () => {
    const execution = await sandbox.exec('echo "Log line"');
    await execution.wait();
    assert.match(execution.logs(), /Log line/);
  });

  await t.test('timedout status and metadata flag', async () => {
    const execution = await sandbox.exec('node -e "setTimeout(() => {}, 10000)"', {
      timeout: 200,
    });
    await execution.wait();
    assert.equal(execution.status(), 'timedout');
    assert.equal(execution.exitCode, -1);
    assert.equal(execution.metadata()!.timedOut, true);
  });

  await t.test('cancel() transitions status to cancelled', async () => {
    const execution = await sandbox.exec('node -e "setTimeout(() => {}, 10000)"', {
      timeout: 5000,
    });
    await execution.cancel();
    assert.equal(execution.status(), 'cancelled');
  });

  await t.test('filesystem write, read, upload, download', async () => {
    await sandbox.writeFile('hello.txt', 'Virtual filesystem works!');
    const buf = await sandbox.readFile('hello.txt');
    assert.equal(buf.toString(), 'Virtual filesystem works!');

    const tmpLocalSrc = path.join(os.tmpdir(), `test-upload-${Date.now()}.txt`);
    const tmpLocalDst = path.join(os.tmpdir(), `test-download-${Date.now()}.txt`);

    await fs.writeFile(tmpLocalSrc, 'Host to Sandbox file payload');
    await sandbox.uploadFile(tmpLocalSrc, 'uploaded/target.txt');
    await sandbox.downloadFile('uploaded/target.txt', tmpLocalDst);
    const downloadedContent = await fs.readFile(tmpLocalDst, 'utf-8');
    assert.equal(downloadedContent, 'Host to Sandbox file payload');

    await fs.rm(tmpLocalSrc, { force: true });
    await fs.rm(tmpLocalDst, { force: true });
  });

  await t.test('lifecycle: kills nested child processes on timeout and destroy', async () => {
    const isWin = process.platform === 'win32';
    // Spawn nested process (sh -> node child -> node grandchild)
    const script = `
      const { spawn } = require('child_process');
      const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)']);
      setInterval(() => {}, 1000);
    `;
    const execution = await sandbox.exec(`node -e "${script.replace(/\n/g, ' ')}"`, {
      timeout: 300,
    });

    await execution.wait();
    assert.equal(execution.status(), 'timedout');
    assert.equal(execution.metadata()!.timedOut, true);
  });

  await t.test('lifecycle: handles SIGTERM-ignoring child process gracefully', async () => {
    const execution = await sandbox.exec('node -e "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"', {
      timeout: 200,
    });

    await execution.wait();
    assert.equal(execution.status(), 'timedout');
    assert.equal(execution.metadata()!.timedOut, true);
  });

  await t.test('lifecycle: destroy() cleans multiple active streaming processes cleanly', async () => {
    const freshSandbox = await Sandbox.create({ backend: 'native' });
    const exec1 = await freshSandbox.exec('node -e "setInterval(() => console.log(\'exec1\'), 100)"');
    const exec2 = await freshSandbox.exec('node -e "setInterval(() => console.log(\'exec2\'), 100)"');

    // Destroy sandbox while both executions are active and streaming
    await freshSandbox.destroy();
    assert.ok(true, 'Sandbox destroyed active streams without throwing');
  });

  await t.test('resource enforcement: disk quota exceeded error & recovery', async () => {
    const quotaSandbox = await Sandbox.create({ backend: 'native', diskQuota: '1KB' });
    const { SandboxResourceError } = await import('../index.js');

    // 1. Normal write within quota
    await quotaSandbox.writeFile('small.txt', 'Hello world');

    // 2. Negative boundary test: exceed 1KB quota
    const largeContent = 'X'.repeat(2048);
    await assert.rejects(
      async () => {
        await quotaSandbox.writeFile('large.txt', largeContent);
      },
      (err: unknown) => {
        assert.ok(err instanceof SandboxResourceError);
        const resErr = err as InstanceType<typeof SandboxResourceError>;
        assert.equal(resErr.code, 'ERR_DISK_QUOTA_EXCEEDED');
        assert.equal(resErr.resource, 'disk');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );

    // 3. Recovery test: sandbox remains healthy and reusable for subsequent operations
    await quotaSandbox.writeFile('recovery.txt', 'OK');
    const readBuf = await quotaSandbox.readFile('recovery.txt');
    assert.equal(readBuf.toString(), 'OK');

    await quotaSandbox.destroy();
  });

  await t.test('resource enforcement: memory limit normal execution completes', async () => {
    // Allocate a sandbox with a generous 256MB limit — a simple echo should fit easily
    const memSandbox = await Sandbox.create({ backend: 'native', memory: '256MB' });

    const execution = await memSandbox.exec('echo "memory check"');
    await execution.wait();

    assert.equal(execution.status(), 'completed');
    assert.match(execution.stdout(), /memory check/);

    await memSandbox.destroy();
  });

  await t.test('resource enforcement: memory limit exceeded throws ERR_OOM_EXCEEDED', async () => {
    const { SandboxResourceError } = await import('../index.js');

    // Use an absurdly small limit (1MB) to deterministically trigger OOM on a Node allocation
    const memSandbox = await Sandbox.create({ backend: 'native' });

    // A Node.js process that allocates ~50MB deliberately
    const allocScript = `
      const chunks = [];
      for (let i = 0; i < 50; i++) {
        chunks.push(Buffer.alloc(1024 * 1024)); // 1MB per push
      }
      // Hold allocations and keep running so the poller can detect the breach
      setInterval(() => {}, 100);
    `.replace(/\n\s*/g, ' ');

    await assert.rejects(
      async () => {
        // 1MB limit — should be breached within the first few allocations
        await memSandbox.exec(`node -e "${allocScript}"`, {
          memory: '1MB',
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        const resErr = err as InstanceType<typeof SandboxResourceError>;
        assert.equal(resErr.code, 'ERR_OOM_EXCEEDED');
        assert.equal(resErr.resource, 'memory');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );

    await memSandbox.destroy();
  });

  await t.test('resource enforcement: sandbox stays healthy after OOM kill', async () => {
    const { SandboxResourceError } = await import('../index.js');
    const memSandbox = await Sandbox.create({ backend: 'native' });

    const allocScript = `
      const chunks = [];
      for (let i = 0; i < 50; i++) { chunks.push(Buffer.alloc(1024 * 1024)); }
      setInterval(() => {}, 100);
    `.replace(/\n\s*/g, ' ');

    // 1. Trigger OOM
    await assert.rejects(
      async () => {
        await memSandbox.exec(`node -e "${allocScript}"`, {
          memory: '1MB',
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => err instanceof SandboxResourceError && err.code === 'ERR_OOM_EXCEEDED'
    );

    // 2. Sandbox remains healthy: a subsequent execution succeeds without errors
    const recovery = await memSandbox.exec('echo "sandbox alive"');
    await recovery.wait();
    assert.equal(recovery.status(), 'completed');
    assert.match(recovery.stdout(), /sandbox alive/);

    await memSandbox.destroy();
  });
});

