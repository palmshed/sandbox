import { Readable, Writable } from 'stream';

export type NetworkPolicy = 'disabled' | 'allow' | 'proxy';

export interface ResourceLimits {
  /** Number of CPU cores allocated (e.g. 1, 2, 0.5). Shared hard rate-cap semantics with cpuQuota (RFC 0007); cpuQuota takes precedence when set. Throttles, never kills; enforcement reported via cpuQuotaLimits (native Linux and Windows true where their probes pass; Docker true where the daemon supports updates.) */
  cpu?: number;
  /** CPU core allocation quota in cores, fractional allowed (RFC 0007; enforced where the capability reports true). Takes precedence over cpu; values at or below zero mean unset. */
  cpuQuota?: number;
  /** CPU time budget in milliseconds (e.g. 2000). Enforced across the process group by the native backend; enforced per process via RLIMIT_CPU (one-second granularity) by the docker backend. */
  cpuTimeLimit?: number;
  /** Memory limit, e.g. "512MB", "2GB", or bytes in number */
  memory?: string | number;
  /** Execution timeout in milliseconds */
  timeout?: number;
}

export interface SandboxOptions {
  /** Execution backend type. Defaults to 'native' if docker is unavailable */
  backend?: 'native' | 'docker' | string;
  /** CPU cores count (shared hard rate-cap semantics with cpuQuota, RFC 0007; cpuQuota takes precedence when set). */
  cpu?: number;
  /** CPU core allocation quota in cores, fractional allowed (RFC 0007; enforced where the capability reports true; values at or below zero mean unset). */
  cpuQuota?: number;
  /** CPU time budget in milliseconds (e.g. 2000). Enforced across the process group by the native backend; enforced per process via RLIMIT_CPU (one-second granularity) by the docker backend. */
  cpuTimeLimit?: number;
  /** Memory limit e.g. "512MB" */
  memory?: string | number;
  /** Disk storage quota limit e.g. "100MB", "1GB" or bytes */
  diskQuota?: string | number;
  /** Global command execution timeout in milliseconds */
  timeout?: number;
  /** Network access policy */
  network?: NetworkPolicy;
  /** Working directory inside the sandbox */
  workDir?: string;
  /**
   * RFC 0006: apply OS-level filesystem isolation when the backend supports it
   * (Linux + Landlock). Defaults to true when the mechanism is supported; set
   * to false for an explicit, documented opt-out (never a silent downgrade).
   */
  osFilesystemIsolation?: boolean;
  /** Environment variables key-value map */
  env?: Record<string, string>;
  /** Docker specific container image (only used when backend is docker) */
  image?: string;
}

export interface ExecOptions {
  /** Override default execution timeout for this run (ms) */
  timeout?: number;
  /** CPU time budget for this execution (ms). Overrides sandbox-level cpuTimeLimit. Enforced across the process group by the native backend; enforced per process via RLIMIT_CPU (one-second granularity) by the docker backend. */
  cpuTimeLimit?: number;
  /** CPU core allocation quota in cores for this execution (RFC 0007; enforced where the capability reports true). Overrides the sandbox quota for this execution only. */
  cpuQuota?: number;
  /** Memory limit for this execution, e.g. "256MB" or bytes. Overrides sandbox-level memory option. */
  memory?: string | number;
  /** Custom working directory relative to sandbox root */
  workDir?: string;
  /** Environment variables overlay */
  env?: Record<string, string>;
  /** Stream to pipe stdout */
  stdout?: Writable;
  /** Stream to pipe stderr */
  stderr?: Writable;
  /** Stream to pipe stdin */
  stdin?: Readable;
  /** Callback fired for real-time stdout chunks */
  onStdout?: (data: string) => void;
  /** Callback fired for real-time stderr chunks */
  onStderr?: (data: string) => void;
  /**
   * Called by the backend once the child process is spawned.
   * The provided `kill` function sends SIGTERM then SIGKILL to the process.
   * Used by Execution.cancel() and Sandbox.destroy() to terminate live processes.
   * @internal
   */
  onProcessSpawned?: (kill: (signal?: NodeJS.Signals) => void) => void;
}

export interface ExecutionMetadata {
  id: string;
  backend: string;
  specVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  /** Total CPU time consumed by the process group in ms (best-effort) */
  cpuTimeMs?: number;
}

export interface ExecResult {
  /** Execution ID */
  id: string;
  /** Process exit code (0 usually indicates success) */
  exitCode: number;
  /** Captured stdout output */
  stdout: string;
  /** Captured stderr output */
  stderr: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** True if execution was terminated due to timeout */
  timedOut: boolean;
  /** Total CPU time consumed by the process group in ms (best-effort) */
  cpuTimeMs?: number;
  /** Structured execution metadata */
  metadata: ExecutionMetadata;
}

export type ResourceErrorCode =
  | 'ERR_CPU_EXCEEDED'
  | 'ERR_OOM_EXCEEDED'
  | 'ERR_DISK_QUOTA_EXCEEDED';

export interface SandboxResourceErrorDetails {
  resource: 'cpu' | 'memory' | 'disk';
  limit: string | number;
  observed?: string | number;
  recoverable: boolean;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'TIMEOUT'
      | 'OOM'
      | 'INVALID_BACKEND'
      | 'EXEC_FAILED'
      | 'FS_ERROR'
      | ResourceErrorCode
      | 'UNKNOWN',
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export class SandboxResourceError extends SandboxError {
  public readonly resource: 'cpu' | 'memory' | 'disk';
  public readonly limit: string | number;
  public readonly observed?: string | number;
  public readonly recoverable: boolean;

  constructor(
    message: string,
    public override readonly code: ResourceErrorCode,
    details: SandboxResourceErrorDetails
  ) {
    super(message, code, details);
    this.name = 'SandboxResourceError';
    this.resource = details.resource;
    this.limit = details.limit;
    this.observed = details.observed;
    this.recoverable = details.recoverable;
  }
}

