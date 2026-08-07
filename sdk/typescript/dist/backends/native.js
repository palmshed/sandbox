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
const fssync = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const types_js_1 = require("../core/types.js");
class NativeBackend {
    name = 'native';
    capabilities = {
        filesystem: true,
        networkIsolation: false,
        cpuLimits: false,
        memoryLimits: true,
        streaming: true,
        remoteExecution: false,
    };
    sandboxDir = '';
    options;
    /** Active child processes — killed on destroy() */
    activeProcesses = new Set();
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
        // Parse memory limit: per-execution option takes precedence over sandbox-level option
        const rawMemoryLimit = options.memory ?? this.options.memory;
        const memLimitBytes = rawMemoryLimit !== undefined ? this.parseSizeStringToBytes(typeof rawMemoryLimit === 'number' ? String(rawMemoryLimit) : rawMemoryLimit) : null;
        return new Promise((resolve, reject) => {
            let stdoutAcc = '';
            let stderrAcc = '';
            let timedOut = false;
            let oomKilled = false;
            let timer = null;
            let memPoller = null;
            let settled = false;
            /**
             * Sample the total RSS of a process group/tree in bytes, cross-platform.
             * The root PID is the spawned shell (`child.pid`); on POSIX it is also the
             * process group ID because the child is spawned detached. Sampling the
             * whole group ensures compound commands (pipelines, background jobs,
             * chained `sh -c` children) cannot bypass memory enforcement by running
             * in a descendant process with a small parent shell.
             * Returns -1 if the group cannot be read (process already exited).
             */
            const sampleGroupRssBytes = (rootPid) => {
                const platform = process.platform;
                if (platform === 'linux') {
                    // Sum VmRSS across every process whose pgrp matches the root PID.
                    let total = 0;
                    let found = false;
                    let entries = [];
                    try {
                        entries = fssync.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
                    }
                    catch {
                        return -1;
                    }
                    for (const d of entries) {
                        let statRaw;
                        try {
                            statRaw = fssync.readFileSync(`/proc/${d}/stat`, 'utf-8');
                        }
                        catch {
                            continue; // process already exited
                        }
                        // comm may contain spaces/parens, so parse after the last ')'
                        const closeParen = statRaw.lastIndexOf(')');
                        if (closeParen === -1)
                            continue;
                        const rest = statRaw.slice(closeParen + 2).split(' ');
                        // rest[0]=state, rest[1]=ppid, rest[2]=pgrp
                        if (parseInt(rest[2], 10) !== rootPid)
                            continue;
                        found = true;
                        try {
                            const status = fssync.readFileSync(`/proc/${d}/status`, 'utf-8');
                            const match = status.match(/VmRSS:\s*(\d+)\s*kB/);
                            if (match)
                                total += parseInt(match[1], 10) * 1024;
                        }
                        catch {
                            // process exited mid-scan
                        }
                    }
                    return found ? total : -1;
                }
                else if (platform === 'darwin') {
                    // macOS: ps reports RSS in 1KB blocks; -g selects by process group
                    let out;
                    try {
                        out = (0, child_process_1.execSync)(`ps -o rss= -g ${rootPid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
                    }
                    catch {
                        return -1; // process group already gone
                    }
                    const lines = out.trim().split('\n').filter(Boolean);
                    if (lines.length === 0)
                        return -1;
                    return lines.reduce((sum, l) => sum + (parseInt(l, 10) || 0), 0) * 1024;
                }
                else if (platform === 'win32') {
                    // Windows: WMIC process-tree walk from the root PID. This is polling
                    // based rather than Job Object accounting, so a child that detaches
                    // from the tree can escape accounting. Documented platform limitation.
                    let out;
                    try {
                        out = (0, child_process_1.execSync)('wmic process get ProcessId,ParentProcessId,WorkingSetSize /value', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
                    }
                    catch {
                        return -1;
                    }
                    const procs = new Map();
                    let curPid = 0;
                    let curPpid = 0;
                    let curRss = 0;
                    for (const line of out.split('\n')) {
                        const trimmed = line.trim();
                        if (!trimmed) {
                            if (curPid)
                                procs.set(curPid, { ppid: curPpid, rss: curRss });
                            curPid = 0;
                            curPpid = 0;
                            curRss = 0;
                            continue;
                        }
                        const eq = trimmed.indexOf('=');
                        if (eq === -1)
                            continue;
                        const key = trimmed.slice(0, eq);
                        const val = parseInt(trimmed.slice(eq + 1), 10) || 0;
                        if (key === 'ProcessId')
                            curPid = val;
                        else if (key === 'ParentProcessId')
                            curPpid = val;
                        else if (key === 'WorkingSetSize')
                            curRss = val;
                    }
                    if (curPid)
                        procs.set(curPid, { ppid: curPpid, rss: curRss });
                    // BFS from the root PID summing RSS across the process tree
                    let total = 0;
                    const visited = new Set();
                    const queue = [rootPid];
                    while (queue.length) {
                        const current = queue.shift();
                        if (visited.has(current))
                            continue;
                        visited.add(current);
                        const p = procs.get(current);
                        if (!p)
                            continue;
                        total += p.rss;
                        for (const [childPid, child] of procs) {
                            if (child.ppid === current && !visited.has(childPid))
                                queue.push(childPid);
                        }
                    }
                    return total;
                }
                return -1;
            };
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'cmd.exe' : '/bin/sh';
            const shellFlag = isWin ? '/s /c' : '-c';
            const child = (0, child_process_1.spawn)(shell, [shellFlag, command], {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                // Use a process group so we can kill descendants too (non-Windows)
                detached: !isWin,
            });
            this.activeProcesses.add(child);
            /**
             * Kill the process gracefully: SIGTERM first, then SIGKILL after 1s if
             * the process hasn't exited. On Windows, fall back to kill() directly.
             */
            const killProcess = (signal = 'SIGTERM') => {
                if (settled)
                    return;
                try {
                    if (!isWin && child.pid !== undefined) {
                        // Negative PID targets the entire POSIX process group
                        process.kill(-child.pid, signal);
                    }
                    else if (isWin && child.pid !== undefined) {
                        // Windows process tree cleanup using taskkill
                        const { execSync } = require('child_process');
                        try {
                            execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
                        }
                        catch {
                            child.kill(signal);
                        }
                    }
                    else {
                        child.kill(signal);
                    }
                    if (signal === 'SIGTERM') {
                        setTimeout(() => {
                            if (!settled)
                                killProcess('SIGKILL');
                        }, 1000);
                    }
                }
                catch {
                    // Process may have already exited
                }
            };
            // Expose kill function to the Execution handle via Sandbox.exec()
            if (options.onProcessSpawned) {
                options.onProcessSpawned(killProcess);
            }
            if (options.stdin && child.stdin) {
                options.stdin.pipe(child.stdin);
            }
            if (timeout > 0) {
                timer = setTimeout(() => {
                    timedOut = true;
                    killProcess('SIGKILL');
                }, timeout);
            }
            // RSS-polling memory enforcement (100ms interval). Samples the entire
            // process group/tree so descendant workloads (pipelines, background jobs,
            // chained sh -c children) are counted against the limit, not just the
            // top-level shell process.
            if (memLimitBytes !== null && child.pid !== undefined) {
                const monitoredRootPid = child.pid;
                memPoller = setInterval(() => {
                    if (settled) {
                        clearInterval(memPoller);
                        return;
                    }
                    const rss = sampleGroupRssBytes(monitoredRootPid);
                    if (rss === -1)
                        return; // process group already gone
                    if (rss > memLimitBytes) {
                        oomKilled = true;
                        clearInterval(memPoller);
                        killProcess('SIGKILL');
                    }
                }, 100);
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
                settled = true;
                this.activeProcesses.delete(child);
                if (timer)
                    clearTimeout(timer);
                reject(new types_js_1.SandboxError(`Execution failed: ${err.message}`, 'EXEC_FAILED', err));
            });
            child.on('close', (code) => {
                settled = true;
                this.activeProcesses.delete(child);
                if (timer)
                    clearTimeout(timer);
                if (memPoller)
                    clearInterval(memPoller);
                const finishedAtMs = Date.now();
                const durationMs = finishedAtMs - startTime;
                const execId = `exec_${Math.random().toString(36).substring(2, 10)}`;
                const exitCode = timedOut || oomKilled ? -1 : (code ?? 0);
                if (oomKilled && memLimitBytes !== null) {
                    // Capture final RSS best-effort (process is gone, use limit as observed)
                    reject(new types_js_1.SandboxResourceError(`Memory limit exceeded: process RSS exceeded limit of ${rawMemoryLimit}`, 'ERR_OOM_EXCEEDED', {
                        resource: 'memory',
                        limit: rawMemoryLimit,
                        observed: `>${rawMemoryLimit}`,
                        recoverable: true,
                    }));
                    return;
                }
                const metadata = {
                    id: execId,
                    backend: this.name,
                    specVersion: '0.1.0',
                    startedAt: new Date(startTime).toISOString(),
                    finishedAt: new Date(finishedAtMs).toISOString(),
                    durationMs,
                    exitCode,
                    timedOut,
                };
                resolve({
                    id: execId,
                    exitCode,
                    stdout: stdoutAcc,
                    stderr: stderrAcc,
                    durationMs,
                    timedOut,
                    metadata,
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
    async getDirectorySize(dirPath) {
        let totalSize = 0;
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    totalSize += await this.getDirectorySize(fullPath);
                }
                else if (entry.isFile()) {
                    const stat = await fs.stat(fullPath);
                    totalSize += stat.size;
                }
            }
        }
        catch {
            // Directory may not exist yet
        }
        return totalSize;
    }
    async assertDiskQuotaAvailable(additionalBytes) {
        if (!this.options?.diskQuota)
            return;
        const quotaBytes = typeof this.options.diskQuota === 'number'
            ? this.options.diskQuota
            : this.parseSizeStringToBytes(this.options.diskQuota);
        const currentSize = await this.getDirectorySize(this.sandboxDir);
        if (currentSize + additionalBytes > quotaBytes) {
            // SandboxResourceError is a direct import at the top of this file
            throw new types_js_1.SandboxResourceError(`Disk quota exceeded: current usage ${currentSize + additionalBytes} bytes exceeds limit of ${quotaBytes} bytes`, 'ERR_DISK_QUOTA_EXCEEDED', {
                resource: 'disk',
                limit: this.options.diskQuota,
                observed: currentSize + additionalBytes,
                recoverable: true,
            });
        }
    }
    parseSizeStringToBytes(sizeStr) {
        const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
        if (!match)
            return 100 * 1024 * 1024; // Default fallback 100MB
        const num = parseFloat(match[1]);
        const unit = (match[2] || 'MB').toUpperCase();
        const multipliers = {
            B: 1,
            KB: 1024,
            MB: 1024 * 1024,
            GB: 1024 * 1024 * 1024,
        };
        return Math.floor(num * (multipliers[unit] || 1024 * 1024));
    }
    async readFile(filePath) {
        const target = this.resolveSandboxPath(filePath);
        return await fs.readFile(target);
    }
    async writeFile(filePath, content) {
        const target = this.resolveSandboxPath(filePath);
        const contentBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf-8');
        await this.assertDiskQuotaAvailable(contentBytes);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
    }
    async uploadFile(localPath, sandboxPath) {
        const target = this.resolveSandboxPath(sandboxPath);
        const stat = await fs.stat(localPath);
        await this.assertDiskQuotaAvailable(stat.size);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(localPath, target);
    }
    async downloadFile(sandboxPath, localPath) {
        const source = this.resolveSandboxPath(sandboxPath);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.copyFile(source, localPath);
    }
    async destroy() {
        // Kill all active child processes before cleaning up the sandbox directory
        for (const child of this.activeProcesses) {
            try {
                const isWin = process.platform === 'win32';
                if (!isWin && child.pid !== undefined) {
                    process.kill(-child.pid, 'SIGKILL');
                }
                else if (isWin && child.pid !== undefined) {
                    const { execSync } = require('child_process');
                    try {
                        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
                    }
                    catch {
                        child.kill('SIGKILL');
                    }
                }
                else {
                    child.kill('SIGKILL');
                }
            }
            catch {
                // Process may have already exited
            }
        }
        this.activeProcesses.clear();
        if (this.sandboxDir) {
            await fs.rm(this.sandboxDir, { recursive: true, force: true });
        }
    }
}
exports.NativeBackend = NativeBackend;
