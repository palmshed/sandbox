import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
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
  // work item #4 delivered cpuLimits, memoryLimits, and networkIsolation.
  // RFC 0007 hard quota adds: `cpuQuota ?? cpu` maps to `--cpus` at create
  // (per-exec overrides via a serialized `docker update --cpus` dance with
  // restore), and `cpuQuotaLimits` promotes only when the daemon API
  // supports container updates (verified at init, never assumed).
  // Documented residuals: RLIMIT_CPU is per-process (a forkbomb gets the
  // budget per process, unlike the native process-group accounting) with
  // one-second granularity; concurrent execs with different per-exec memory
  // limits serialize on the container-wide setting; OOM attribution falls
  // back to exit-code 137 once a container has OOMed before (stale flag);
  // clearing a limit materializes unlimited as 1TiB (daemon validation
  // rejects the 0/-1 spellings on update); clearing CPU quota restores the
  // host count (the daemon validates --cpus into 0.01..host CPUs, so above
  // capacity is rejected rather than passing through); override dances
  // share one mutex across memory and CPU updates.
  public readonly capabilities: BackendCapabilities = {
    filesystem: true,
    networkIsolation: true,
    cpuLimits: true,
    memoryLimits: true,
    streaming: true,
    osFilesystemIsolation: 'unsupported', // RFC 0006: Docker backend does not apply Landlock confinement
    remoteExecution: false,
    cpuQuotaLimits: false, // RFC 0007: promoted at init only when the daemon supports updates
  };
  private containerId: string = '';
  private options!: SandboxOptions;
  // Serializes resource update, exec, restore dances (memory and CPU share
  // it: concurrent `docker update` calls with disjoint flags could otherwise
  // interleave read-modify-write cycles and lose each other's settings).
  private resourceUpdateChain: Promise<void> = Promise.resolve();
  // Container-wide memory limit currently applied (bytes), mirrored from
  // create/update calls so per-exec overrides know when an update is needed.
  private appliedMemoryBytes: number | null = null;
  // Container-wide CPU quota currently applied (cores), mirrored the same
  // way. Precedence at create and per exec: cpuQuota ?? cpu.
  private appliedCpuQuota: number | null = null;

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

  /** Quota precedence shared by create and exec: cpuQuota ?? cpu, unset unless a positive number. */
  private static resolveCpuQuotaCores(cpuQuota?: number, cpu?: number): number | null {
    const raw = cpuQuota ?? cpu;
    return typeof raw === 'number' && raw > 0 ? raw : null;
  }

  /**
   * True when the daemon API supports `docker update --cpus` (API 1.29+).
   * Never throws: unparseable versions and unreachable daemons report false.
   */
  private async probeUpdateApiSupport(): Promise<boolean> {
    try {
      const res = await this.runDockerCmd(['version', '--format', '{{.Server.APIVersion}}']);
      if (res.exitCode !== 0) return false;
      const parts = res.stdout.trim().split('.');
      if (parts.length < 2) return false;
      const major = parseInt(parts[0], 10);
      const minor = parseInt(parts[1], 10);
      if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
      return major > 1 || (major === 1 && minor >= 29);
    } catch {
      return false;
    }
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

    // Resource limits mapping. CPU quota precedence (RFC 0007): cpuQuota ??
    // cpu. Non-positive values mean unset (mirrors cpuTimeLimit handling);
    // above-capacity values pass through and never bind.
    const sandboxQuota = DockerBackend.resolveCpuQuotaCores(options.cpuQuota, options.cpu);
    if (sandboxQuota !== null) {
      args.push(`--cpus=${sandboxQuota}`);
      this.appliedCpuQuota = sandboxQuota;
    } else {
      this.appliedCpuQuota = null;
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
    // RFC 0007: promote cpuQuotaLimits only when the daemon actually
    // supports container updates (`docker update --cpus` needs API 1.29+).
    // Version-gated, never assumed; failure leaves the flag false and the
    // container fully usable for everything else.
    if (await this.probeUpdateApiSupport()) {
      this.capabilities.cpuQuotaLimits = true;
    } else {
      logDebug('cpuquota.unavailable', {
        backend: this.name,
        reason: 'daemon API predates container updates',
      });
    }
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

    // CPU quota (cores): an explicit per-execution value (even 0/NaN, which
    // resolve to null) replaces the sandbox default for this execution;
    // absent means the default. Mirrors the native precedence and Q6.
    const sandboxQuotaDefault = DockerBackend.resolveCpuQuotaCores(
      this.options.cpuQuota,
      this.options.cpu
    );
    const execQuota =
      options.cpuQuota !== undefined
        ? DockerBackend.resolveCpuQuotaCores(options.cpuQuota, undefined)
        : sandboxQuotaDefault;

    // Fast path: the container already enforces both wanted settings (or no
    // limits are wanted and none are applied). No `docker update` needed. The
    // OOM snapshot is only read when a limit is active (avoids an extra
    // inspect call on every unenforced execution).
    const needsMemoryDance = memLimitBytes !== this.appliedMemoryBytes;
    const needsCpuDance = execQuota !== this.appliedCpuQuota;
    if (!needsMemoryDance && !needsCpuDance) {
      const oomBefore = memLimitBytes !== null ? await this.readOomKilled() : false;
      return this.execWithBudget(command, options, cpuTimeLimitMs, rawCpuTimeLimit ?? null, rawMemoryLimit ?? null, memLimitBytes, oomBefore);
    }

    // Slow path: apply the per-exec targets container-wide, run, then
    // restore the sandbox defaults. Serialized on the shared chain so
    // concurrent execs with different per-exec limits cannot interleave
    // container-wide `docker update` calls (last write would otherwise win
    // for both executions, and disjoint memory/CPU updates could clobber
    // each other read-modify-write style).
    const previous = this.resourceUpdateChain;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.resourceUpdateChain = current;
    await previous;
    try {
      const oomBefore = await this.readOomKilled();
      if (needsMemoryDance) await this.applyContainerMemory(memLimitBytes);
      if (needsCpuDance) await this.applyContainerCpus(execQuota);
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
          if (needsCpuDance) await this.applyContainerCpus(sandboxQuotaDefault);
          if (needsMemoryDance) await this.applyContainerMemory(sandboxDefaultBytes);
        } catch (err) {
          // Never mask the execution result with a restore failure. The
          // mirrors keep stale values, so the next dance retries the
          // restore instead of running under wrong limits silently.
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
   * so OOM is deterministic). Clearing materializes unlimited as 1TiB for
   * both flags: `docker update` rejects the 0/-1 unlimited spellings on
   * common daemons (cross-validation between the two flags), while an
   * explicit equal pair always validates; 1TiB exceeds any host, so it never
   * binds a real workload. The mirror still records null (conceptually
   * unlimited), which stays consistent because every override apply re-pins
   * both flags explicitly.
   */
  private async applyContainerMemory(targetBytes: number | null): Promise<void> {
    if (targetBytes === this.appliedMemoryBytes) return;
    // 1TiB in bytes: practical unlimited that always passes update validation.
    const UNLIMITED_BYTES = 1099511627776;
    const effective = targetBytes === null ? UNLIMITED_BYTES : targetBytes;
    const memArgs = [`--memory=${effective}`, `--memory-swap=${effective}`];
    const res = await this.runDockerCmd(['update', ...memArgs, this.containerId]);
    if (res.exitCode !== 0) {
      throw new SandboxError(
        `Failed to apply container memory limit: ${res.stderr.trim()}`,
        'EXEC_FAILED'
      );
    }
    this.appliedMemoryBytes = targetBytes;
  }

  /**
   * Apply a container-wide CPU quota in cores (null clears it). Mirror
   * updated only on success. Clearing restores the host CPU count: the
   * daemon validates `--cpus` into 0.01..host CPUs (observed: values above
   * the count are rejected, so neither 0 nor huge stand-ins work), and the
   * full count can never bind. Resolved from the daemon (`docker info`)
   * with an os.cpus fallback; a last-resort 64 keeps the dance total
   * rather than failing the restore.
   */
  private async applyContainerCpus(targetCores: number | null): Promise<void> {
    if (targetCores === this.appliedCpuQuota) return;
    let effective = targetCores;
    if (effective === null) {
      effective = await this.resolveHostCpus();
    }
    const res = await this.runDockerCmd(['update', `--cpus=${effective}`, this.containerId]);
    if (res.exitCode !== 0) {
      throw new SandboxError(
        `Failed to apply container CPU quota: ${res.stderr.trim()}`,
        'EXEC_FAILED'
      );
    }
    this.appliedCpuQuota = targetCores;
  }

  /**
   * Host CPU count for materializing unlimited restores. Daemon truth first
   * (`docker info` NCPU), SDK-host fallback (correct for the local daemons
   * this driver supports), cached per sandbox.
   */
  private hostCpuCountCache: number | null = null;

  private async resolveHostCpus(): Promise<number> {
    if (this.hostCpuCountCache !== null) return this.hostCpuCountCache;
    try {
      const res = await this.runDockerCmd(['info', '--format', '{{.NCPU}}']);
      const ncpu = parseInt(res.stdout.trim(), 10);
      if (res.exitCode === 0 && Number.isFinite(ncpu) && ncpu > 0) {
        this.hostCpuCountCache = ncpu;
        return ncpu;
      }
    } catch {
      // fall through to local fallbacks
    }
    if (os.cpus().length > 0) {
      this.hostCpuCountCache = os.cpus().length;
      return os.cpus().length;
    }
    this.hostCpuCountCache = 64;
    return 64;
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
