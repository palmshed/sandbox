import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BackendEngine } from './interface.js';
import { ExecOptions, ExecResult, SandboxError, SandboxOptions } from '../core/types.js';
import { logDebug } from '../core/log.js';

export class DockerBackend implements BackendEngine {
  public readonly name = 'docker';
  // Capability negotiation principle: a capability MUST NOT be `true` unless
  // backed by implementation AND integration-test coverage. The Docker driver
  // wires CLI calls for run/exec/cp/stop, but cpuTimeLimit is not enforced,
  // per-execution memory overrides are ignored, and network policies beyond
  // `disabled` are unhandled. cpuLimits/memoryLimits/networkIsolation are
  // therefore reported `false` (reserved: backend-parity work item #4) until
  // Docker resource/network enforcement is implemented and integration-tested.
  public readonly capabilities = {
    filesystem: true,
    networkIsolation: false,
    cpuLimits: false,
    memoryLimits: false,
    streaming: true,
    remoteExecution: false,
  };
  private containerId: string = '';
  private options!: SandboxOptions;

  /**
   * Reject paths that escape the container VFS workspace or would break out of
   * shell quoting in `sh -c` commands. The container root is the sandbox
   * workspace, so absolute paths and `..` traversal are refused (FS_ERROR).
   */
  private static assertSafeContainerPath(p: string): string {
    if (p.includes('\0')) {
      throw new SandboxError('Invalid path: NUL byte', 'FS_ERROR');
    }
    const normalized = path.posix.normalize(p).replace(/^\.\//, '');
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized === '.' ||
      normalized.startsWith('/')
    ) {
      throw new SandboxError('Path traversal attempt outside container workspace', 'FS_ERROR');
    }
    return normalized;
  }

  /** Single-quote a string for safe interpolation into an `sh -c` command. */
  private static shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  async init(options: SandboxOptions): Promise<void> {
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
      throw new SandboxError(`Failed to start Docker container: ${result.stderr}`, 'INVALID_BACKEND');
    }
    this.containerId = result.stdout.trim();
    logDebug('backend.init', {
      backend: this.name,
      containerId: this.containerId,
      image,
      network: options.network ?? 'allow',
    });
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (!this.containerId) {
      throw new SandboxError('Docker container is not running', 'EXEC_FAILED');
    }

    logDebug('exec.start', {
      backend: this.name,
      timeout: options.timeout ?? this.options?.timeout ?? null,
    });

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

  async readFile(filePath: string): Promise<Buffer> {
    const target = DockerBackend.assertSafeContainerPath(filePath);
    const res = await this.runDockerCmd(['exec', this.containerId, 'cat', target]);
    if (res.exitCode !== 0) {
      throw new SandboxError(`Failed to read file in container: ${res.stderr}`, 'FS_ERROR');
    }
    return Buffer.from(res.stdout);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const target = DockerBackend.shellQuote(DockerBackend.assertSafeContainerPath(filePath));
    const strContent = typeof content === 'string' ? content : content.toString('base64');
    const isBase64 = typeof content !== 'string';

    const cmd = isBase64
      ? `echo "${strContent}" | base64 -d > ${target}`
      : `cat << 'EOF' > ${target}\n${strContent}\nEOF`;

    const res = await this.runDockerCmd(['exec', this.containerId, 'sh', '-c', cmd]);
    if (res.exitCode !== 0) {
      throw new SandboxError(`Failed to write file in container: ${res.stderr}`, 'FS_ERROR');
    }
  }

  async uploadFile(localPath: string, sandboxPath: string): Promise<void> {
    const target = DockerBackend.assertSafeContainerPath(sandboxPath);
    const res = await this.runDockerCmd(['cp', localPath, `${this.containerId}:${target}`]);
    if (res.exitCode !== 0) {
      throw new SandboxError(`Failed to upload file to container: ${res.stderr}`, 'FS_ERROR');
    }
  }

  async downloadFile(sandboxPath: string, localPath: string): Promise<void> {
    const source = DockerBackend.assertSafeContainerPath(sandboxPath);
    const res = await this.runDockerCmd(['cp', `${this.containerId}:${source}`, localPath]);
    if (res.exitCode !== 0) {
      throw new SandboxError(`Failed to download file from container: ${res.stderr}`, 'FS_ERROR');
    }
  }

  async destroy(): Promise<void> {
    if (this.containerId) {
      await this.runDockerCmd(['stop', '-t', '1', this.containerId]);
      this.containerId = '';
    }
    logDebug('backend.destroy', { backend: this.name });
  }

  private runDockerCmd(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? this.options?.timeout ?? 0;

    return new Promise((resolve, reject) => {
      let stdoutAcc = '';
      let stderrAcc = '';
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;

      const child = spawn('docker', args);

      if (options.stdin && child.stdin) {
        options.stdin.pipe(child.stdin);
      }

      if (timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeout);
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        stdoutAcc += str;
        if (options.onStdout) options.onStdout(str);
        if (options.stdout) options.stdout.write(chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        stderrAcc += str;
        if (options.onStderr) options.onStderr(str);
        if (options.stderr) options.stderr.write(chunk);
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new SandboxError(`Docker CLI error: ${err.message}`, 'INVALID_BACKEND', err));
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const finishedAtMs = Date.now();
        const durationMs = finishedAtMs - startTime;
        const execId = `exec_${Math.random().toString(36).substring(2, 10)}`;
        const exitCode = timedOut ? -1 : (code ?? 0);

        logDebug('exec.end', {
          backend: this.name,
          exitCode,
          durationMs,
          timedOut,
        });

        const metadata = {
          id: execId,
          backend: this.name,
          specVersion: '1.0.0',
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
}
