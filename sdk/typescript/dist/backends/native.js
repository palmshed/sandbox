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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeBackend = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const types_js_1 = require("../core/types.js");
class NativeBackend {
    name = 'native';
    capabilities = {
        filesystem: true,
        networkIsolation: false,
        cpuLimits: false,
        memoryLimits: false,
        streaming: true,
        remoteExecution: false,
    };
    sandboxDir = '';
    options;
    async init(options) {
        this.options = options;
        // Create an isolated temporary working directory for native execution
        const tmpPrefix = path.join(os.tmpdir(), 'palmshed-sandbox-');
        this.sandboxDir = await fs.mkdtemp(tmpPrefix);
        if (options.workDir) {
            const targetDir = path.resolve(this.sandboxDir, options.workDir);
            await fs.mkdir(targetDir, { recursive: true });
        }
    }
    async exec(command, options = {}) {
        const startTime = Date.now();
        const timeout = options.timeout ?? this.options.timeout ?? 0;
        const cwd = options.workDir
            ? path.resolve(this.sandboxDir, options.workDir)
            : this.sandboxDir;
        const env = {
            ...process.env,
            ...this.options.env,
            ...options.env,
        };
        // If network is disabled, set standard proxy/offline indicators
        if (this.options.network === 'disabled') {
            env.HTTP_PROXY = 'http://127.0.0.1:0';
            env.HTTPS_PROXY = 'http://127.0.0.1:0';
            env.NO_PROXY = '';
        }
        return new Promise((resolve, reject) => {
            let stdoutAcc = '';
            let stderrAcc = '';
            let timedOut = false;
            let timer = null;
            // Execute command in shell cross-platform
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'cmd.exe' : '/bin/sh';
            const shellFlag = isWin ? '/s /c' : '-c';
            const child = (0, child_process_1.spawn)(shell, [shellFlag, command], {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (options.stdin && child.stdin) {
                options.stdin.pipe(child.stdin);
            }
            if (timeout > 0) {
                timer = setTimeout(() => {
                    timedOut = true;
                    child.kill('SIGKILL');
                }, timeout);
            }
            child.stdout?.on('data', (chunk) => {
                const str = chunk.toString();
                stdoutAcc += str;
                if (options.onStdout)
                    options.onStdout(str);
                if (options.stdout)
                    options.stdout.write(chunk);
            });
            child.stderr?.on('data', (chunk) => {
                const str = chunk.toString();
                stderrAcc += str;
                if (options.onStderr)
                    options.onStderr(str);
                if (options.stderr)
                    options.stderr.write(chunk);
            });
            child.on('error', (err) => {
                if (timer)
                    clearTimeout(timer);
                reject(new types_js_1.SandboxError(`Execution failed: ${err.message}`, 'EXEC_FAILED', err));
            });
            child.on('close', (code) => {
                if (timer)
                    clearTimeout(timer);
                const durationMs = Date.now() - startTime;
                resolve({
                    exitCode: timedOut ? -1 : (code ?? 0),
                    stdout: stdoutAcc,
                    stderr: stderrAcc,
                    durationMs,
                    timedOut,
                });
            });
        });
    }
    resolveSandboxPath(targetPath) {
        const resolved = path.resolve(this.sandboxDir, targetPath);
        if (!resolved.startsWith(this.sandboxDir)) {
            throw new types_js_1.SandboxError('Path traversal attempt outside sandbox root', 'FS_ERROR');
        }
        return resolved;
    }
    async readFile(filePath) {
        const target = this.resolveSandboxPath(filePath);
        return await fs.readFile(target);
    }
    async writeFile(filePath, content) {
        const target = this.resolveSandboxPath(filePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
    }
    async uploadFile(localPath, sandboxPath) {
        const target = this.resolveSandboxPath(sandboxPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(localPath, target);
    }
    async downloadFile(sandboxPath, localPath) {
        const source = this.resolveSandboxPath(sandboxPath);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.copyFile(source, localPath);
    }
    async destroy() {
        if (this.sandboxDir) {
            await fs.rm(this.sandboxDir, { recursive: true, force: true });
        }
    }
}
exports.NativeBackend = NativeBackend;
