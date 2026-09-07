import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BackendCapabilities, BackendEngine } from './interface.js';
import {
  ExecOptions,
  ExecResult,
  SandboxError,
  SandboxOptions,
  SandboxResourceError,
} from '../core/types.js';
import { logDebug } from '../core/log.js';

export class DockerBackend implements BackendEngine {
  public readonly name = 'docker';
  // Capability negotiation principle: a capability MUST NOT be `true` unless
  // backed by implementation AND integration-test coverage. Backend-parity
  // work item #4 delivered all three gaps, so the flags are promoted:
  //   cpuLimits: cpuTimeLimit enforced per execution via RLIMIT_CPU
  //     (`ulimit -t`, second granularity, per-process inheritance) with
  //     ERR_CPU_EXCEEDED on breach.
  //   memoryLimits: per-execution memory overrides applied container-wide via
  //     `docker update --memory/--memory-swap` (serialized update, exec,
  //     restore dance) with OOMKilled-transition attribution and
  //     ERR_OOM_EXCEEDED on breach.
  //   networkIsolation: `disabled` maps to `--network none` (proven by the
  //     hermetic only-lo-interface test); `allow` is the explicit default
  //     bridge; `proxy` adds host proxy env passthrough at container create.
  // Documented residuals: RLIMIT_CPU is per-process (a forkbomb gets the
  // budget per process, unlike the native process-group accounting) with
  // one-second granularity; concurrent execs with different per-exec memory
  // limits serialize on the container-wide setting; OOM attribution falls
  // back to exit-code 137 once a container has OOMed before (stale flag).
  public readonly capabilities: BackendCapabilities = {
    filesystem: true,
    networkIsolation: true,
    cpuLimits: true,
    memoryLimits: true,
    streaming: true,
    osFilesystemIsolation: 'unsupported', // RFC 0006: Docker backend does not apply Landlock confinement
    remoteExecution: false,
  };
  private containerId: string = '';
  private options!: SandboxOptions;
  // Serializes the memory update, exec, restore dance so concurrent execs
  // with different per-exec memory limits cannot interleave container-wide
  // `docker update` calls (last write would otherwise win for both).
  private memoryUpdateChain: Promise<void> = Promise.resolve();
  // Container-wide memory limit currently applied (bytes), mirrored from
  // create/update calls so per-exec overrides know when an update is needed.
  private appliedMemoryBytes: number | null = null;

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

    // Network policy mapping. `disabled` gets a network namespace with no
    // interfaces (`--network none`); `allow` is the explicit default bridge;
    // `proxy` keeps the default bridge and passes the host proxy env vars
    // through so egress goes where the host proxy points.
    const networkPolicy = options.network ?? 'allow';
    if (networkPolicy === 'disabled') {
      args.push('--network', 'none');
    } else if (networkPolicy === 'proxy') {
      for (const name of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'no_proxy',
      ]) {
        const value = process.env[name];
        if (value !== undefined) args.push('-e', `${name}=${value}`);
      }
    }

    // Resource limits mapping
    if (options.cpu) {
      args.push(`--cpus=${options.cpu}`);
    }
    if (options.memory) {
      const memStr = typeof options.memory === 'number' ? `${options.memory}` : options.memory;
      args.push(`--memory=${memStr}`);
      this.appliedMemoryBytes = DockerBackend.parseSizeStringToBytes(
        typeof options.memory === 'number' ? String(options.memory) : options.memory
      );
    } else {
      this.appliedMemoryBytes = null;
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

    // CPU time budget (ms): per-execution option takes precedence over the
    // sandbox-level option, mirroring the native backend precedence.
    const rawCpuTimeLimit = options.cpuTimeLimit ?? this.options.cpuTimeLimit;
    const cpuTimeLimitMs =
      rawCpuTimeLimit !== undefined && rawCpuTimeLimit > 0 ? rawCpuTimeLimit : null;

    // Memory limit (bytes): per-execution option takes precedence over the
    // sandbox-level option. Null means unconstrained (no container default).
    const sandboxDefaultBytes =
      this.options.memory !== undefined
        ? DockerBackend.parseSizeStringToBytes(
            typeof this.options.memory === 'number'
              ? String(this.options.memory)
              : this.options.memory
          )
        : null;
    const rawMemoryLimit = options.memory ?? this.options.memory;
    const memLimitBytes =
      rawMemoryLimit !== undefined
        ? DockerBackend.parseSizeStringToBytes(
            typeof rawMemoryLimit === 'number' ? String(rawMemoryLimit) : rawMemoryLimit
          )
        : null;

    // Fast path: the container already enforces the wanted limit (or no
    // limit is wanted and none is applied). No `docker update` needed. The
    // OOM snapshot is only read when a limit is active (avoids an extra
    // inspect call on every unenforced execution).
    if (memLimitBytes === this.appliedMemoryBytes) {
      const oomBefore = memLimitBytes !== null ? await this.readOomKilled() : false;
      return this.execWithBudget(command, options, cpuTimeLimitMs, rawCpuTimeLimit ?? null, rawMemoryLimit ?? null, memLimitBytes, oomBefore);
    }

    // Slow path: apply the per-exec target container-wide, run, then restore
    // the sandbox default. Serialized on a chain so concurrent execs with
    // different per-exec limits cannot interleave updates (last write would
    // otherwise win for both executions).
    const previous = this.memoryUpdateChain;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.memoryUpdateChain = current;
    await previous;
    try {
      const oomBefore = await this.readOomKilled();
      await this.applyContainerMemory(memLimitBytes);
      try {
        return await this.execWithBudget(
          command,
          options,
          cpuTimeLimitMs,
          rawCpuTimeLimit ?? null,
          rawMemoryLimit ?? null,
          memLimitBytes,
          oomBefore
        );
      } finally {
        try {
          await this.applyContainerMemory(sandboxDefaultBytes);
        } catch (err) {
          // Never mask the execution result with a restore failure. The
          // mirror keeps the stale value, so the next dance retries the
          // restore instead of running under a wrong limit silently.
          logDebug('resource.restoreFailed', {
            backend: this.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      release();
    }
  }

  /**
   * Run a command with an optional CPU time budget. The budget is enforced by
   * the kernel via RLIMIT_CPU (`ulimit -t`, inherited by children), so it
   * holds on every Docker host including Docker Desktop (no host-cgroup
   * access needed). Breach attribution: with a budget set and no wall-clock
   * timeout, a signal-range exit means the kernel killed the tree on the
   * budget (RLIMIT hard kill is SIGKILL, 137; the soft-limit SIGXCPU default
   * action also terminates). Plain small exit codes pass through as real
   * workload failures. Documented residuals: one-second granularity
   * (ceil, minimum 1) and per-process accounting (a forkbomb gets the budget
   * per process, unlike the native process-group accounting).
   */
  private async execWithBudget(
    command: string,
    options: ExecOptions,
    cpuTimeLimitMs: number | null,
    rawCpuTimeLimit: number | null,
    rawMemoryLimit: string | number | null,
    memLimitBytes: number | null,
    oomBefore: boolean
  ): Promise<ExecResult> {
    let finalCommand = command;
    if (cpuTimeLimitMs !== null) {
      const secs = Math.max(1, Math.ceil(cpuTimeLimitMs / 1000));
      finalCommand = `ulimit -t ${secs}; ${command}`;
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
    args.push(this.containerId, 'sh', '-c', finalCommand);

    const result = await this.runDockerCmd(args, options);
    if (result.timedOut) return result;

    // OOM attribution first: the OOMKilled transition is kernel-certain.
    if (memLimitBytes !== null && result.exitCode !== 0) {
      const oomed = await this.checkOomTransition(oomBefore);
      if (oomed || result.exitCode === 137) {
        logDebug('resource.enforced', {
          backend: this.name,
          resource: 'memory',
          limit: rawMemoryLimit,
          recoverable: true,
        });
        throw new SandboxResourceError(
          `Memory limit exceeded: container OOM-killed past the limit of ${rawMemoryLimit}`,
          'ERR_OOM_EXCEEDED',
          {
            resource: 'memory',
            limit: rawMemoryLimit!,
            observed: `>${rawMemoryLimit}`,
            recoverable: true,
          }
        );
      }
    }

    if (
      cpuTimeLimitMs !== null &&
      result.exitCode !== 0 &&
      (result.exitCode === 137 || result.exitCode > 128)
    ) {
      logDebug('resource.enforced', {
        backend: this.name,
        resource: 'cpu',
        limit: rawCpuTimeLimit,
        recoverable: true,
      });
      throw new SandboxResourceError(
        `CPU time limit exceeded: execution consumed more than ${rawCpuTimeLimit}ms of CPU time`,
        'ERR_CPU_EXCEEDED',
        {
          resource: 'cpu',
          limit: rawCpuTimeLimit!,
          observed: `>${rawCpuTimeLimit}`,
          recoverable: true,
        }
      );
    }

    return result;
  }

  /**
   * Apply a container-wide memory limit (null clears it). Mirror updated only
   * on success. Applies always pin swap equal to memory (no swap spillover,
   * so OOM is deterministic). Clearing passes only `--memory 0`: bundling
   * `--memory-swap -1` in the same update trips daemon-side validation, and
   * a stale swap cap cannot bind RAM while memory.max is unlimited, so the
   * swap flag is intentionally left untouched on clear.
   */
  private async applyContainerMemory(targetBytes: number | null): Promise<void> {
    if (targetBytes === this.appliedMemoryBytes) return;
    const memArgs =
      targetBytes === null
        ? ['--memory', '0']
        : [`--memory=${targetBytes}`, `--memory-swap=${targetBytes}`];
    const res = await this.runDockerCmd(['update', ...memArgs, this.containerId]);
    if (res.exitCode !== 0) {
      throw new SandboxError(
        `Failed to apply container memory limit: ${res.stderr.trim()}`,
        'EXEC_FAILED'
      );
    }
    this.appliedMemoryBytes = targetBytes;
  }

  /** Read the container OOMKilled flag (false when unreadable; exec then fails honestly). */
  private async readOomKilled(): Promise<boolean> {
    try {
      const res = await this.runDockerCmd([
        'inspect',
        '--format',
        '{{.State.OOMKilled}}',
        this.containerId,
      ]);
      return res.exitCode === 0 && res.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** True when the flag transitioned since the snapshot (stale-true reads cannot transition). */
  private async checkOomTransition(oomBefore: boolean): Promise<boolean> {
    if (oomBefore) return false;
    return this.readOomKilled();
  }

  /** Size strings use the native backend semantics (default unit MB, 100MB fallback). */
  private static parseSizeStringToBytes(sizeStr: string): number {
    const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
    if (!match) return 100 * 1024 * 1024; // Default fallback 100MB
    const num = parseFloat(match[1]);
    const unit = (match[2] || 'MB').toUpperCase();
    const multipliers: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
    };
    return Math.floor(num * (multipliers[unit] || 1024 * 1024));
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
          specVersion: '1.1.0',
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
