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
});
