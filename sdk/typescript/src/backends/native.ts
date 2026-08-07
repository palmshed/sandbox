import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { BackendEngine } from './interface.js';
import { ExecOptions, ExecResult, SandboxError, SandboxOptions } from '../core/types.js';

export class NativeBackend implements BackendEngine {
  public readonly name = 'native';
  public readonly capabilities = {
    filesystem: true,
    networkIsolation: false,
    cpuLimits: false,
    memoryLimits: false,
    streaming: true,
    remoteExecution: false,
  };
  private sandboxDir: string = '';
  private options!: SandboxOptions;
  /** Active child processes — killed on destroy() */
  private activeProcesses = new Set<ChildProcess>();

  async init(options: SandboxOptions): Promise<void> {
    this.options = options;
    // Create an isolated temporary working directory for native execution
    const tmpPrefix = path.join(os.tmpdir(), 'palmshed-sandbox-');
    this.sandboxDir = await fs.mkdtemp(tmpPrefix);

    if (options.workDir) {
      const targetDir = path.resolve(this.sandboxDir, options.workDir);
      await fs.mkdir(targetDir, { recursive: true });
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
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
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const shellFlag = isWin ? '/s /c' : '-c';

      const child = spawn(shell, [shellFlag, command], {
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
      const killProcess = (signal: NodeJS.Signals = 'SIGTERM') => {
        if (settled) return;
        try {
          if (!isWin && child.pid !== undefined) {
            // Negative PID targets the entire process group
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
          if (signal === 'SIGTERM') {
            setTimeout(() => {
              if (!settled) killProcess('SIGKILL');
            }, 1000);
          }
        } catch {
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
        settled = true;
        this.activeProcesses.delete(child);
        if (timer) clearTimeout(timer);
        reject(new SandboxError(`Execution failed: ${err.message}`, 'EXEC_FAILED', err));
      });

      child.on('close', (code) => {
        settled = true;
        this.activeProcesses.delete(child);
        if (timer) clearTimeout(timer);
        const finishedAtMs = Date.now();
        const durationMs = finishedAtMs - startTime;
        const execId = `exec_${Math.random().toString(36).substring(2, 10)}`;
        const exitCode = timedOut ? -1 : (code ?? 0);

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

  private resolveSandboxPath(targetPath: string): string {
    const resolved = path.resolve(this.sandboxDir, targetPath);
    if (!resolved.startsWith(this.sandboxDir)) {
      throw new SandboxError('Path traversal attempt outside sandbox root', 'FS_ERROR');
    }
    return resolved;
  }

  async readFile(filePath: string): Promise<Buffer> {
    const target = this.resolveSandboxPath(filePath);
    return await fs.readFile(target);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const target = this.resolveSandboxPath(filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async uploadFile(localPath: string, sandboxPath: string): Promise<void> {
    const target = this.resolveSandboxPath(sandboxPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(localPath, target);
  }

  async downloadFile(sandboxPath: string, localPath: string): Promise<void> {
    const source = this.resolveSandboxPath(sandboxPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(source, localPath);
  }

  async destroy(): Promise<void> {
    // Kill all active child processes before cleaning up the sandbox directory
    for (const child of this.activeProcesses) {
      try {
        const isWin = process.platform === 'win32';
        if (!isWin && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Process may have already exited
      }
    }
    this.activeProcesses.clear();

    if (this.sandboxDir) {
      await fs.rm(this.sandboxDir, { recursive: true, force: true });
    }
  }
}
