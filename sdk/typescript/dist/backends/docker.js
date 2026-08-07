"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerBackend = void 0;
const child_process_1 = require("child_process");
const types_js_1 = require("../core/types.js");
class DockerBackend {
    name = 'docker';
    capabilities = {
        filesystem: true,
        networkIsolation: true,
        cpuLimits: true,
        memoryLimits: true,
        streaming: true,
        remoteExecution: false,
    };
    containerId = '';
    options;
    async init(options) {
        this.options = options;
        const image = options.image || 'node:20-alpine';
        const args = ['run', '-d', '--rm'];
        // Network policy mapping
        if (options.network === 'disabled') {
            args.push('--network', 'none');
        }
        // Resource limits mapping
        if (options.cpu) {
            args.push(`--cpus=${options.cpu}`);
        }
        if (options.memory) {
            const memStr = typeof options.memory === 'number' ? `${options.memory}b` : options.memory;
            args.push(`--memory=${memStr}`);
        }
        // Pass environment variables
        if (options.env) {
            for (const [k, v] of Object.entries(options.env)) {
                args.push('-e', `${k}=${v}`);
            }
        }
        // Keep container running via tail
        args.push(image, 'tail', '-f', '/dev/null');
        const result = await this.runDockerCmd(args);
        if (result.exitCode !== 0) {
            throw new types_js_1.SandboxError(`Failed to start Docker container: ${result.stderr}`, 'INVALID_BACKEND');
        }
        this.containerId = result.stdout.trim();
    }
    async exec(command, options = {}) {
        if (!this.containerId) {
            throw new types_js_1.SandboxError('Docker container is not running', 'EXEC_FAILED');
        }
        const args = ['exec'];
        if (options.workDir) {
            args.push('-w', options.workDir);
        }
        if (options.env) {
            for (const [k, v] of Object.entries(options.env)) {
                args.push('-e', `${k}=${v}`);
            }
        }
        args.push(this.containerId, 'sh', '-c', command);
        return this.runDockerCmd(args, options);
    }
    async readFile(filePath) {
        const res = await this.runDockerCmd(['exec', this.containerId, 'cat', filePath]);
        if (res.exitCode !== 0) {
            throw new types_js_1.SandboxError(`Failed to read file in container: ${res.stderr}`, 'FS_ERROR');
        }
        return Buffer.from(res.stdout);
    }
    async writeFile(filePath, content) {
        const strContent = typeof content === 'string' ? content : content.toString('base64');
        const isBase64 = typeof content !== 'string';
        const cmd = isBase64
            ? `echo "${strContent}" | base64 -d > "${filePath}"`
            : `cat << 'EOF' > "${filePath}"\n${strContent}\nEOF`;
        const res = await this.runDockerCmd(['exec', this.containerId, 'sh', '-c', cmd]);
        if (res.exitCode !== 0) {
            throw new types_js_1.SandboxError(`Failed to write file in container: ${res.stderr}`, 'FS_ERROR');
        }
    }
    async uploadFile(localPath, sandboxPath) {
        const res = await this.runDockerCmd(['cp', localPath, `${this.containerId}:${sandboxPath}`]);
        if (res.exitCode !== 0) {
            throw new types_js_1.SandboxError(`Failed to upload file to container: ${res.stderr}`, 'FS_ERROR');
        }
    }
    async downloadFile(sandboxPath, localPath) {
        const res = await this.runDockerCmd(['cp', `${this.containerId}:${sandboxPath}`, localPath]);
        if (res.exitCode !== 0) {
            throw new types_js_1.SandboxError(`Failed to download file from container: ${res.stderr}`, 'FS_ERROR');
        }
    }
    async destroy() {
        if (this.containerId) {
            await this.runDockerCmd(['stop', '-t', '1', this.containerId]);
            this.containerId = '';
        }
    }
    runDockerCmd(args, options = {}) {
        const startTime = Date.now();
        const timeout = options.timeout ?? this.options?.timeout ?? 0;
        return new Promise((resolve, reject) => {
            let stdoutAcc = '';
            let stderrAcc = '';
            let timedOut = false;
            let timer = null;
            const child = (0, child_process_1.spawn)('docker', args);
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
                reject(new types_js_1.SandboxError(`Docker CLI error: ${err.message}`, 'INVALID_BACKEND', err));
            });
            child.on('close', (code) => {
                if (timer)
                    clearTimeout(timer);
                resolve({
                    exitCode: timedOut ? -1 : (code ?? 0),
                    stdout: stdoutAcc,
                    stderr: stderrAcc,
                    durationMs: Date.now() - startTime,
                    timedOut,
                });
            });
        });
    }
}
exports.DockerBackend = DockerBackend;
