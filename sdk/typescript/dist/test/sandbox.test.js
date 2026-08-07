"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs/promises"));
const index_js_1 = require("../index.js");
(0, node_test_1.default)('Native Backend Sandbox Execution', async (t) => {
    const sandbox = await index_js_1.Sandbox.create({ backend: 'native', timeout: 5000 });
    t.after(async () => {
        await sandbox.destroy();
    });
    await t.test('returns live Execution handle with URI and status', async () => {
        const execution = await sandbox.exec('echo "Hello Palmshed Sandbox"');
        // Execution is live (running) before wait
        strict_1.default.equal(execution.status(), 'running');
        strict_1.default.match(execution.id, /^exec_/);
        strict_1.default.match(execution.uri, /^sandbox:\/\/execution\/exec_/);
        await execution.wait();
        strict_1.default.equal(execution.status(), 'completed');
        strict_1.default.equal(execution.exitCode, 0);
        strict_1.default.match(execution.stdout(), /Hello Palmshed Sandbox/);
    });
    await t.test('populates structured metadata after wait()', async () => {
        const execution = await sandbox.exec('echo "Metadata Test"');
        await execution.wait();
        const meta = execution.metadata();
        strict_1.default.equal(meta.backend, 'native');
        strict_1.default.equal(meta.specVersion, '0.1.0');
        strict_1.default.equal(meta.exitCode, 0);
        strict_1.default.equal(meta.timedOut, false);
        strict_1.default.equal(typeof meta.startedAt, 'string');
        strict_1.default.equal(typeof meta.finishedAt, 'string');
        strict_1.default.ok(meta.durationMs >= 0);
    });
    await t.test('emits stdout events in real time', async () => {
        const chunks = [];
        const execution = await sandbox.exec('echo "Stream Chunk"');
        execution.on('stdout', (data) => chunks.push(data));
        await execution.wait();
        strict_1.default.ok(chunks.length > 0);
        strict_1.default.ok(chunks.join('').includes('Stream Chunk'));
    });
    await t.test('emits exit event with code', async () => {
        let exitCode = null;
        const execution = await sandbox.exec('exit 0');
        execution.on('exit', (code) => { exitCode = code; });
        await execution.wait();
        strict_1.default.equal(exitCode, 0);
    });
    await t.test('logs() returns accumulated stdout', async () => {
        const execution = await sandbox.exec('echo "Log line"');
        await execution.wait();
        strict_1.default.match(execution.logs(), /Log line/);
    });
    await t.test('timedout status and metadata flag', async () => {
        const execution = await sandbox.exec('node -e "setTimeout(() => {}, 10000)"', {
            timeout: 200,
        });
        await execution.wait();
        strict_1.default.equal(execution.status(), 'timedout');
        strict_1.default.equal(execution.exitCode, -1);
        strict_1.default.equal(execution.metadata().timedOut, true);
    });
    await t.test('cancel() transitions status to cancelled', async () => {
        const execution = await sandbox.exec('node -e "setTimeout(() => {}, 10000)"', {
            timeout: 5000,
        });
        await execution.cancel();
        strict_1.default.equal(execution.status(), 'cancelled');
    });
    await t.test('filesystem write, read, upload, download', async () => {
        await sandbox.writeFile('hello.txt', 'Virtual filesystem works!');
        const buf = await sandbox.readFile('hello.txt');
        strict_1.default.equal(buf.toString(), 'Virtual filesystem works!');
        const tmpLocalSrc = path.join(os.tmpdir(), `test-upload-${Date.now()}.txt`);
        const tmpLocalDst = path.join(os.tmpdir(), `test-download-${Date.now()}.txt`);
        await fs.writeFile(tmpLocalSrc, 'Host to Sandbox file payload');
        await sandbox.uploadFile(tmpLocalSrc, 'uploaded/target.txt');
        await sandbox.downloadFile('uploaded/target.txt', tmpLocalDst);
        const downloadedContent = await fs.readFile(tmpLocalDst, 'utf-8');
        strict_1.default.equal(downloadedContent, 'Host to Sandbox file payload');
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
        strict_1.default.equal(execution.status(), 'timedout');
        strict_1.default.equal(execution.metadata().timedOut, true);
    });
    await t.test('lifecycle: handles SIGTERM-ignoring child process gracefully', async () => {
        const execution = await sandbox.exec('node -e "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"', {
            timeout: 200,
        });
        await execution.wait();
        strict_1.default.equal(execution.status(), 'timedout');
        strict_1.default.equal(execution.metadata().timedOut, true);
    });
    await t.test('lifecycle: destroy() cleans multiple active streaming processes cleanly', async () => {
        const freshSandbox = await index_js_1.Sandbox.create({ backend: 'native' });
        const exec1 = await freshSandbox.exec('node -e "setInterval(() => console.log(\'exec1\'), 100)"');
        const exec2 = await freshSandbox.exec('node -e "setInterval(() => console.log(\'exec2\'), 100)"');
        // Destroy sandbox while both executions are active and streaming
        await freshSandbox.destroy();
        strict_1.default.ok(true, 'Sandbox destroyed active streams without throwing');
    });
    await t.test('resource enforcement: disk quota exceeded error & recovery', async () => {
        const quotaSandbox = await index_js_1.Sandbox.create({ backend: 'native', diskQuota: '1KB' });
        const { SandboxResourceError } = await import('../index.js');
        // 1. Normal write within quota
        await quotaSandbox.writeFile('small.txt', 'Hello world');
        // 2. Negative boundary test: exceed 1KB quota
        const largeContent = 'X'.repeat(2048);
        await strict_1.default.rejects(async () => {
            await quotaSandbox.writeFile('large.txt', largeContent);
        }, (err) => {
            strict_1.default.ok(err instanceof SandboxResourceError);
            const resErr = err;
            strict_1.default.equal(resErr.code, 'ERR_DISK_QUOTA_EXCEEDED');
            strict_1.default.equal(resErr.resource, 'disk');
            strict_1.default.equal(resErr.recoverable, true);
            return true;
        });
        // 3. Recovery test: sandbox remains healthy and reusable for subsequent operations
        await quotaSandbox.writeFile('recovery.txt', 'OK');
        const readBuf = await quotaSandbox.readFile('recovery.txt');
        strict_1.default.equal(readBuf.toString(), 'OK');
        await quotaSandbox.destroy();
    });
    await t.test('resource enforcement: memory limit normal execution completes', async () => {
        // Allocate a sandbox with a generous 256MB limit — a simple echo should fit easily
        const memSandbox = await index_js_1.Sandbox.create({ backend: 'native', memory: '256MB' });
        const execution = await memSandbox.exec('echo "memory check"');
        await execution.wait();
        strict_1.default.equal(execution.status(), 'completed');
        strict_1.default.match(execution.stdout(), /memory check/);
        await memSandbox.destroy();
    });
    await t.test('resource enforcement: memory limit exceeded throws ERR_OOM_EXCEEDED', async () => {
        const { SandboxResourceError } = await import('../index.js');
        // Use an absurdly small limit (1MB) to deterministically trigger OOM on a Node allocation
        const memSandbox = await index_js_1.Sandbox.create({ backend: 'native' });
        // A Node.js process that allocates ~50MB deliberately
        const allocScript = `
      const chunks = [];
      for (let i = 0; i < 50; i++) {
        chunks.push(Buffer.alloc(1024 * 1024)); // 1MB per push
      }
      // Hold allocations and keep running so the poller can detect the breach
      setInterval(() => {}, 100);
    `.replace(/\n\s*/g, ' ');
        await strict_1.default.rejects(async () => {
            // 1MB limit — should be breached within the first few allocations
            await memSandbox.exec(`node -e "${allocScript}"`, {
                memory: '1MB',
                timeout: 5000,
            }).then(e => e.wait());
        }, (err) => {
            strict_1.default.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
            const resErr = err;
            strict_1.default.equal(resErr.code, 'ERR_OOM_EXCEEDED');
            strict_1.default.equal(resErr.resource, 'memory');
            strict_1.default.equal(resErr.recoverable, true);
            return true;
        });
        await memSandbox.destroy();
    });
    await t.test('resource enforcement: sandbox stays healthy after OOM kill', async () => {
        const { SandboxResourceError } = await import('../index.js');
        const memSandbox = await index_js_1.Sandbox.create({ backend: 'native' });
        const allocScript = `
      const chunks = [];
      for (let i = 0; i < 50; i++) { chunks.push(Buffer.alloc(1024 * 1024)); }
      setInterval(() => {}, 100);
    `.replace(/\n\s*/g, ' ');
        // 1. Trigger OOM
        await strict_1.default.rejects(async () => {
            await memSandbox.exec(`node -e "${allocScript}"`, {
                memory: '1MB',
                timeout: 5000,
            }).then(e => e.wait());
        }, (err) => err instanceof SandboxResourceError && err.code === 'ERR_OOM_EXCEEDED');
        // 2. Sandbox remains healthy: a subsequent execution succeeds without errors
        const recovery = await memSandbox.exec('echo "sandbox alive"');
        await recovery.wait();
        strict_1.default.equal(recovery.status(), 'completed');
        strict_1.default.match(recovery.stdout(), /sandbox alive/);
        await memSandbox.destroy();
    });
    await t.test('resource enforcement: sh -c child memory growth triggers ERR_OOM_EXCEEDED', async (t) => {
        if (process.platform === 'win32')
            return t.skip('compound sh syntax is POSIX-only');
        const { SandboxResourceError } = await import('../index.js');
        const memSandbox = await index_js_1.Sandbox.create({ backend: 'native' });
        // The shell stays as a low-RSS parent (~2MB); the node child runs in the
        // background holding ~47MB+. An 8MB limit is above the shell alone but far
        // below the child, so only group-wide sampling can detect the breach.
        const allocScript = `
      const chunks = [];
      for (let i = 0; i < 200; i++) { chunks.push(Buffer.alloc(1024 * 1024)); }
      setInterval(() => {}, 100);
    `.replace(/\n\s*/g, ' ');
        await strict_1.default.rejects(async () => {
            await memSandbox.exec(`node -e "${allocScript}" & wait $!`, {
                memory: '8MB',
                timeout: 5000,
            }).then(e => e.wait());
        }, (err) => {
            strict_1.default.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
            const resErr = err;
            strict_1.default.equal(resErr.code, 'ERR_OOM_EXCEEDED');
            strict_1.default.equal(resErr.resource, 'memory');
            strict_1.default.equal(resErr.recoverable, true);
            return true;
        });
        await memSandbox.destroy();
    });
    await t.test('resource enforcement: pipeline child memory growth triggers ERR_OOM_EXCEEDED', async (t) => {
        if (process.platform === 'win32')
            return t.skip('compound sh syntax is POSIX-only');
        const { SandboxResourceError } = await import('../index.js');
        const memSandbox = await index_js_1.Sandbox.create({ backend: 'native' });
        const allocScript = `
      const chunks = [];
      for (let i = 0; i < 200; i++) { chunks.push(Buffer.alloc(1024 * 1024)); }
      setInterval(() => {}, 100);
    `.replace(/\n\s*/g, ' ');
        // node is the pipeline producer with a small `cat` consumer; the shell
        // parent stays tiny. Only group sampling sees the producer's RSS.
        await strict_1.default.rejects(async () => {
            await memSandbox.exec(`node -e "${allocScript}" | cat`, {
                memory: '8MB',
                timeout: 5000,
            }).then(e => e.wait());
        }, (err) => {
            strict_1.default.ok(err instanceof SandboxResourceError, `Expected SandboxResourceError, got ${err}`);
            const resErr = err;
            strict_1.default.equal(resErr.code, 'ERR_OOM_EXCEEDED');
            strict_1.default.equal(resErr.recoverable, true);
            return true;
        });
        await memSandbox.destroy();
    });
    await t.test('resource enforcement: sandbox reusable after compound-command OOM kill', async (t) => {
        if (process.platform === 'win32')
            return t.skip('compound sh syntax is POSIX-only');
        const { SandboxResourceError } = await import('../index.js');
        const memSandbox = await index_js_1.Sandbox.create({ backend: 'native' });
        const allocScript = `
      const chunks = [];
      for (let i = 0; i < 200; i++) { chunks.push(Buffer.alloc(1024 * 1024)); }
      setInterval(() => {}, 100);
    `.replace(/\n\s*/g, ' ');
        // 1. OOM kill of a background child
        await strict_1.default.rejects(async () => {
            await memSandbox.exec(`node -e "${allocScript}" & wait $!`, {
                memory: '8MB',
                timeout: 5000,
            }).then(e => e.wait());
        }, (err) => err instanceof SandboxResourceError && err.code === 'ERR_OOM_EXCEEDED');
        // 2. No leaked workload processes remain
        const leaked = await memSandbox.exec('pgrep -f "Buffer.alloc" || echo "none"');
        await leaked.wait();
        strict_1.default.match(leaked.stdout(), /none/);
        // 3. Sandbox remains reusable
        const recovery = await memSandbox.exec('echo "alive after compound oom"');
        await recovery.wait();
        strict_1.default.equal(recovery.status(), 'completed');
        strict_1.default.match(recovery.stdout(), /alive after compound oom/);
        await memSandbox.destroy();
    });
});
