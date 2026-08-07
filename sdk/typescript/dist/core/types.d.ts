import { Readable, Writable } from 'stream';
export type NetworkPolicy = 'disabled' | 'allow' | 'proxy';
export interface ResourceLimits {
    /** Number of CPU cores allocated (e.g. 1, 2, 0.5). Quota semantics; experimental for the native backend. */
    cpu?: number;
    /** CPU core allocation quota (experimental, not yet enforced by native backend) */
    cpuQuota?: number;
    /** CPU time budget in milliseconds (e.g. 2000). Enforced across the process group by the native backend. */
    cpuTimeLimit?: number;
    /** Memory limit, e.g. "512MB", "2GB", or bytes in number */
    memory?: string | number;
    /** Execution timeout in milliseconds */
    timeout?: number;
}
export interface SandboxOptions {
    /** Execution backend type. Defaults to 'native' if docker is unavailable */
    backend?: 'native' | 'docker' | string;
    /** CPU cores count (quota semantics; experimental for the native backend) */
    cpu?: number;
    /** CPU core allocation quota (experimental, not yet enforced by native backend) */
    cpuQuota?: number;
    /** CPU time budget in milliseconds (e.g. 2000). Enforced across the process group by the native backend. */
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
    /** Environment variables key-value map */
    env?: Record<string, string>;
    /** Docker specific container image (only used when backend is docker) */
    image?: string;
}
export interface ExecOptions {
    /** Override default execution timeout for this run (ms) */
    timeout?: number;
    /** CPU time budget for this execution (ms). Overrides sandbox-level cpuTimeLimit. Enforced across the process group. */
    cpuTimeLimit?: number;
    /** CPU core allocation quota for this execution (experimental) */
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
export type ResourceErrorCode = 'ERR_CPU_EXCEEDED' | 'ERR_OOM_EXCEEDED' | 'ERR_DISK_QUOTA_EXCEEDED';
export interface SandboxResourceErrorDetails {
    resource: 'cpu' | 'memory' | 'disk';
    limit: string | number;
    observed?: string | number;
    recoverable: boolean;
}
export declare class SandboxError extends Error {
    readonly code: 'TIMEOUT' | 'OOM' | 'INVALID_BACKEND' | 'EXEC_FAILED' | 'FS_ERROR' | ResourceErrorCode | 'UNKNOWN';
    readonly details?: unknown | undefined;
    constructor(message: string, code: 'TIMEOUT' | 'OOM' | 'INVALID_BACKEND' | 'EXEC_FAILED' | 'FS_ERROR' | ResourceErrorCode | 'UNKNOWN', details?: unknown | undefined);
}
export declare class SandboxResourceError extends SandboxError {
    readonly code: ResourceErrorCode;
    readonly resource: 'cpu' | 'memory' | 'disk';
    readonly limit: string | number;
    readonly observed?: string | number;
    readonly recoverable: boolean;
    constructor(message: string, code: ResourceErrorCode, details: SandboxResourceErrorDetails);
}
