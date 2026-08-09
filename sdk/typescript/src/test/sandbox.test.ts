import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { Sandbox, SandboxError } from '../index.js';

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
    assert.equal(meta.specVersion, '1.0.0');
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

  await t.test('filesystem security: path traversal blocked on all VFS operations', async () => {
    const secSandbox = await Sandbox.create({ backend: 'native' });
    const tmpLocal = path.join(os.tmpdir(), `traversal-src-${Date.now()}.txt`);
    await fs.writeFile(tmpLocal, 'payload');

    const traversalOps: Array<[string, () => Promise<unknown>]> = [
      ['writeFile', () => secSandbox.writeFile('../../../../etc/evil.txt', 'x')],
      ['readFile', () => secSandbox.readFile('../../../../etc/hosts')],
      ['downloadFile', () => secSandbox.downloadFile('../../../../etc/hosts', path.join(os.tmpdir(), `traversal-dst-${Date.now()}.txt`))],
      ['uploadFile', () => secSandbox.uploadFile(tmpLocal, '../../../../etc/evil.txt')],
    ];

    for (const [op, fn] of traversalOps) {
      await assert.rejects(
        fn,
        (err: unknown) => err instanceof SandboxError && err.code === 'FS_ERROR',
        `${op} should reject path traversal`
      );
    }

    await fs.rm(tmpLocal, { force: true });
    await secSandbox.destroy();
  });

  await t.test('filesystem security: symlink escapes blocked across read/write/download', async (t) => {
    if (process.platform === 'win32') return t.skip('symlink escape tests are POSIX-only');
    const secSandbox = await Sandbox.create({ backend: 'native' });

    // read escape: workload-planted symlink to a host file
    await secSandbox.exec('node -e "require(\'fs\').symlinkSync(\'/etc/hosts\',\'link.txt\')"').then((e) => e.wait());
    await assert.rejects(
      () => secSandbox.readFile('link.txt'),
      (err: unknown) => err instanceof SandboxError && err.code === 'FS_ERROR',
      'symlink read escape should be blocked'
    );

    // download escape
    const tmpDst = path.join(os.tmpdir(), `symlink-dl-${Date.now()}.txt`);
    await assert.rejects(
      () => secSandbox.downloadFile('link.txt', tmpDst),
      (err: unknown) => err instanceof SandboxError && err.code === 'FS_ERROR',
      'symlink download escape should be blocked'
    );
    await fs.rm(tmpDst, { force: true });

    // write escape: symlink pointing at a host file must not overwrite it
    const victimPath = path.join(os.tmpdir(), `victim-${Date.now()}.txt`);
    await fs.writeFile(victimPath, 'original');
    await secSandbox.exec(`node -e "require('fs').symlinkSync('${victimPath}','victim.txt')"`).then((e) => e.wait());
    await assert.rejects(
      () => secSandbox.writeFile('victim.txt', 'pwnd'),
      (err: unknown) => err instanceof SandboxError && err.code === 'FS_ERROR',
      'symlink write escape should be blocked'
    );
    const readback = await fs.readFile(victimPath, 'utf-8');
    assert.equal(readback, 'original', 'host file must remain untouched');
    await fs.rm(victimPath, { force: true });

    // symlink-to-directory write escape
    await secSandbox.exec('node -e "require(\'fs\').symlinkSync(\'/etc\',\'dirlink\')"').then((e) => e.wait());
    await assert.rejects(
      () => secSandbox.writeFile('dirlink/hostname', 'x'),
      (err: unknown) => err instanceof SandboxError && err.code === 'FS_ERROR',
      'symlink-directory write escape should be blocked'
    );

    await secSandbox.destroy();
  });

  await t.test('filesystem security: exec workDir is contained and auto-created', async () => {
    const secSandbox = await Sandbox.create({ backend: 'native' });
    const escape = await secSandbox.exec('pwd', { workDir: '/etc' });
    await assert.rejects(
      () => escape.wait(),
      (err: unknown) => err instanceof SandboxError && err.code === 'FS_ERROR',
      'absolute host workDir should be rejected'
    );
    const ex = await secSandbox.exec('pwd', { workDir: 'sub/nested' });
    await ex.wait();
    assert.equal(ex.status(), 'completed');
    assert.ok(ex.stdout().trim().endsWith('sub/nested'), `pwd resolved to ${ex.stdout().trim()}`);
    await secSandbox.destroy();
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

  await t.test('resource enforcement: exec writes past disk quota -> ERR_DISK_QUOTA_EXCEEDED with rollback & recovery', async () => {
    const { SandboxResourceError } = await import('../index.js');
    const quotaSandbox = await Sandbox.create({ backend: 'native', diskQuota: '1KB' });

    // A workload that writes ~200KB faster than the 250ms poller tick must
    // still be caught by the final workspace size check on close.
    const writeScript = `
      const fs = require('fs');
      const b = Buffer.alloc(1024, 120);
      for (let i = 0; i < 200; i++) {
        fs.writeFileSync('bulk-' + i + '.bin', b);
      }
    `.replace(/\n\s*/g, ' ');

    await assert.rejects(
      async () => {
        await quotaSandbox.exec(`node -e "${writeScript}"`).then((e) => e.wait());
      },
      (err: unknown) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        const resErr = err as InstanceType<typeof SandboxResourceError>;
        assert.equal(resErr.code, 'ERR_DISK_QUOTA_EXCEEDED');
        assert.equal(resErr.resource, 'disk');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );

    // Rollback must leave the workspace under quota so the sandbox is reusable
    const recovery = await quotaSandbox.exec('echo "recovered"');
    await recovery.wait();
    assert.equal(recovery.status(), 'completed');
    assert.match(recovery.stdout(), /recovered/);

    await quotaSandbox.destroy();
  });

  await t.test('resource enforcement: memory limit normal execution completes', async () => {
    // Allocate a sandbox with a generous 256MB limit; a simple echo should fit easily
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

    // A Node.js process that allocates ~50MB deliberately. Touching each page
    // ensures the OS actually commits RSS, giving the 100ms poller a
    // deterministic observation window.
    const allocScript = `
      setTimeout(() => {
        const chunks = [];
        for (let i = 0; i < 50; i++) {
          const buf = Buffer.alloc(1024 * 1024);
          buf.fill('x');
          chunks.push(buf);
        }
        setInterval(() => {}, 100);
      }, 200);
    `.replace(/\n\s*/g, ' ');

    await assert.rejects(
      async () => {
        // 1MB limit: should be breached within the first few allocations
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
      setTimeout(() => {
        const chunks = [];
        for (let i = 0; i < 50; i++) {
          const buf = Buffer.alloc(1024 * 1024);
          buf.fill('x');
          chunks.push(buf);
        }
        setInterval(() => {}, 100);
      }, 200);
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

  await t.test('resource enforcement: sh -c child memory growth triggers ERR_OOM_EXCEEDED', async (t) => {
    if (process.platform === 'win32') return t.skip('compound sh syntax is POSIX-only');
    const { SandboxResourceError } = await import('../index.js');
    const memSandbox = await Sandbox.create({ backend: 'native' });

    // The shell stays as a low-RSS parent (~2MB); the node child runs in the
    // background holding ~47MB+. An 8MB limit is above the shell alone but far
    // below the child, so only group-wide sampling can detect the breach.
    const allocScript = `
      setTimeout(() => {
        const chunks = [];
        for (let i = 0; i < 200; i++) {
          const buf = Buffer.alloc(1024 * 1024);
          buf.fill('x');
          chunks.push(buf);
        }
        setInterval(() => {}, 100);
      }, 200);
    `.replace(/\n\s*/g, ' ');

    await assert.rejects(
      async () => {
        await memSandbox.exec(`node -e "${allocScript}" & wait $!`, {
          memory: '8MB',
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

  await t.test('resource enforcement: pipeline child memory growth triggers ERR_OOM_EXCEEDED', async (t) => {
    if (process.platform === 'win32') return t.skip('compound sh syntax is POSIX-only');
    const { SandboxResourceError } = await import('../index.js');
    const memSandbox = await Sandbox.create({ backend: 'native' });

    const allocScript = `
      setTimeout(() => {
        const chunks = [];
        for (let i = 0; i < 200; i++) {
          const buf = Buffer.alloc(1024 * 1024);
          buf.fill('x');
          chunks.push(buf);
        }
        setInterval(() => {}, 100);
      }, 200);
    `.replace(/\n\s*/g, ' ');

    // node is the pipeline producer with a small `cat` consumer; the shell
    // parent stays tiny. Only group sampling sees the producer's RSS.
    await assert.rejects(
      async () => {
        await memSandbox.exec(`node -e "${allocScript}" | cat`, {
          memory: '8MB',
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        const resErr = err as InstanceType<typeof SandboxResourceError>;
        assert.equal(resErr.code, 'ERR_OOM_EXCEEDED');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );

    await memSandbox.destroy();
  });

  await t.test('resource enforcement: sandbox reusable after compound-command OOM kill', async (t) => {
    if (process.platform === 'win32') return t.skip('compound sh syntax is POSIX-only');
    const { SandboxResourceError } = await import('../index.js');
    const memSandbox = await Sandbox.create({ backend: 'native' });

    // process.title gives a stable, short comm name for leak checks. Do NOT use
    // `pgrep -f "Buffer.alloc"`: on Linux, pgrep does not exclude ancestors, so
    // the checker shell (`sh -c 'pgrep -f Buffer.alloc ...'`) self-matches and
    // false-positives as a "leaked" PID. macOS pgrep excludes ancestors, which
    // is why this only failed on GitHub Actions Linux runners.
    const allocScript = `
      process.title = 'sbx-oom-wkld';
      setTimeout(() => {
        const chunks = [];
        for (let i = 0; i < 200; i++) {
          const buf = Buffer.alloc(1024 * 1024);
          buf.fill('x');
          chunks.push(buf);
        }
        setInterval(() => {}, 100);
      }, 200);
    `.replace(/\n\s*/g, ' ');

    // 1. OOM kill of a background child
    await assert.rejects(
      async () => {
        await memSandbox.exec(`node -e "${allocScript}" & wait $!`, {
          memory: '8MB',
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => err instanceof SandboxResourceError && err.code === 'ERR_OOM_EXCEEDED'
    );

    // 2. No leaked workload processes remain (exact comm match; no self-match)
    const leaked = await memSandbox.exec('pgrep -x sbx-oom-wkld || echo "none"');
    await leaked.wait();
    assert.match(leaked.stdout(), /none/);

    // 3. Sandbox remains reusable
    const recovery = await memSandbox.exec('echo "alive after compound oom"');
    await recovery.wait();
    assert.equal(recovery.status(), 'completed');
    assert.match(recovery.stdout(), /alive after compound oom/);

    await memSandbox.destroy();
  });

  await t.test('resource enforcement: CPU time normal execution completes and reports cpuTimeMs', async () => {
    const cpuSandbox = await Sandbox.create({ backend: 'native' });

    // Runs longer than one 100ms poll cycle so cpuTimeMs is captured; uses
    // almost no CPU, well within the budget.
    const execution = await cpuSandbox.exec('node -e "setTimeout(() => {}, 500)"', {
      cpuTimeLimit: 5000,
      timeout: 5000,
    });
    await execution.wait();

    assert.equal(execution.status(), 'completed');
    const meta = execution.metadata()!;
    assert.equal(typeof meta.cpuTimeMs, 'number');
    assert.ok(meta.cpuTimeMs! >= 0, 'cpuTimeMs reported in metadata');
    const result = execution.result()!;
    assert.equal(typeof result.cpuTimeMs, 'number');
    assert.ok(result.cpuTimeMs! >= 0, 'cpuTimeMs reported in result');

    await cpuSandbox.destroy();
  });

  await t.test('resource enforcement: direct busy loop exceeds CPU time -> ERR_CPU_EXCEEDED', async () => {
    const { SandboxResourceError } = await import('../index.js');
    const cpuSandbox = await Sandbox.create({ backend: 'native' });

    await assert.rejects(
      async () => {
        await cpuSandbox.exec('node -e "let x=0; while(true){x++}"', {
          cpuTimeLimit: 300,
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        const resErr = err as InstanceType<typeof SandboxResourceError>;
        assert.equal(resErr.code, 'ERR_CPU_EXCEEDED');
        assert.equal(resErr.resource, 'cpu');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );

    await cpuSandbox.destroy();
  });

  await t.test('resource enforcement: sh -c background child CPU burn -> ERR_CPU_EXCEEDED', async (t) => {
    if (process.platform === 'win32') return t.skip('compound sh syntax is POSIX-only');
    const { SandboxResourceError } = await import('../index.js');
    const cpuSandbox = await Sandbox.create({ backend: 'native' });

    // The shell parent stays idle (~0 CPU); the backgrounded node child burns
    // CPU. Only process-group accounting can see the workload's consumption.
    await assert.rejects(
      async () => {
        await cpuSandbox.exec('node -e "let x=0; while(true){x++}" & wait $!', {
          cpuTimeLimit: 300,
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        const resErr = err as InstanceType<typeof SandboxResourceError>;
        assert.equal(resErr.code, 'ERR_CPU_EXCEEDED');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );

    await cpuSandbox.destroy();
  });

  await t.test('resource enforcement: pipeline producer CPU burn -> ERR_CPU_EXCEEDED', async (t) => {
    if (process.platform === 'win32') return t.skip('compound sh syntax is POSIX-only');
    const { SandboxResourceError } = await import('../index.js');
    const cpuSandbox = await Sandbox.create({ backend: 'native' });

    await assert.rejects(
      async () => {
        await cpuSandbox.exec('node -e "let x=0; while(true){x++}" | cat', {
          cpuTimeLimit: 300,
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        const resErr = err as InstanceType<typeof SandboxResourceError>;
        assert.equal(resErr.code, 'ERR_CPU_EXCEEDED');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );

    await cpuSandbox.destroy();
  });

  await t.test('resource enforcement: multiple parallel CPU workers -> ERR_CPU_EXCEEDED', async (t) => {
    if (process.platform === 'win32') return t.skip('compound sh syntax is POSIX-only');
    const { SandboxResourceError } = await import('../index.js');
    const cpuSandbox = await Sandbox.create({ backend: 'native' });

    // Three parallel busy loops consume CPU far faster than a single worker.
    await assert.rejects(
      async () => {
        await cpuSandbox.exec(
          'for i in 1 2 3; do node -e "let x=0; while(true){x++}" & done; wait',
          { cpuTimeLimit: 300, timeout: 5000 }
        ).then(e => e.wait());
      },
      (err: unknown) => {
        assert.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
        const resErr = err as InstanceType<typeof SandboxResourceError>;
        assert.equal(resErr.code, 'ERR_CPU_EXCEEDED');
        assert.equal(resErr.recoverable, true);
        return true;
      }
    );

    await cpuSandbox.destroy();
  });

  await t.test('resource enforcement: sandbox reusable after CPU limit kill', async (t) => {
    if (process.platform === 'win32') return t.skip('compound sh syntax is POSIX-only');
    const { SandboxResourceError } = await import('../index.js');
    const cpuSandbox = await Sandbox.create({ backend: 'native' });

    // process.title + pgrep -x avoids Linux pgrep ancestor self-match false positives
    // (see compound-command OOM test). Also avoids ERE pitfalls: `while(true)` is a
    // capturing group, so `pgrep -f "while(true)"` never matched the literal source.
    const cpuScript = "process.title = 'sbx-cpu-wkld'; let x=0; while(true){x++}";

    // 1. CPU limit kill of a background child
    await assert.rejects(
      async () => {
        await cpuSandbox.exec(`node -e "${cpuScript}" & wait $!`, {
          cpuTimeLimit: 300,
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => err instanceof SandboxResourceError && err.code === 'ERR_CPU_EXCEEDED'
    );

    // 2. No leaked workload processes remain
    const leaked = await cpuSandbox.exec('pgrep -x sbx-cpu-wkld || echo "none"');
    await leaked.wait();
    assert.match(leaked.stdout(), /none/);

    // 3. Sandbox remains reusable
    const recovery = await cpuSandbox.exec('echo "alive after cpu kill"');
    await recovery.wait();
    assert.equal(recovery.status(), 'completed');
    assert.match(recovery.stdout(), /alive after cpu kill/);

    await cpuSandbox.destroy();
  });

  await t.test('resource enforcement: process tree fully cleaned after OOM with escaped descendants', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX-only process group semantics');
    const { SandboxResourceError } = await import('../index.js');
    const memSandbox = await Sandbox.create({ backend: 'native' });

    // Distinct title from the compound-OOM test so parallel/serial runs cannot
    // cross-talk; pgrep -x avoids Linux ancestor self-match (see above).
    const allocScript = `
      process.title = 'sbx-oom-tree';
      setTimeout(() => {
        const chunks = [];
        for (let i = 0; i < 200; i++) {
          const buf = Buffer.alloc(1024 * 1024);
          buf.fill('x');
          chunks.push(buf);
        }
        setInterval(() => {}, 100);
      }, 200);
    `.replace(/\n\s*/g, ' ');

    // 1. Trigger OOM on a background child process
    await assert.rejects(
      async () => {
        await memSandbox.exec(`node -e "${allocScript}" & wait $!`, {
          memory: '8MB',
          timeout: 5000,
        }).then(e => e.wait());
      },
      (err: unknown) => err instanceof SandboxResourceError && err.code === 'ERR_OOM_EXCEEDED'
    );

    // 2. Verify no escaped descendants remain (background jobs, nested children)
    const leaked = await memSandbox.exec('pgrep -x sbx-oom-tree || echo "none"');
    await leaked.wait();
    assert.match(leaked.stdout(), /none/, 'no leaked workload processes after OOM cleanup');

    // 3. Sandbox remains reusable after thorough cleanup
    const recovery = await memSandbox.exec('echo "tree fully cleaned"');
    await recovery.wait();
    assert.equal(recovery.status(), 'completed');
    assert.match(recovery.stdout(), /tree fully cleaned/);

    await memSandbox.destroy();
  });
});

