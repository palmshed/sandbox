import { Readable, Writable } from 'stream';
export type NetworkPolicy = 'disabled' | 'allow' | 'proxy';
export interface ResourceLimits {
    /** Number of CPU cores allocated (e.g. 1, 2, 0.5) */
    cpu?: number;
    /** Memory limit, e.g. "512MB", "2GB", or bytes in number */
    memory?: string | number;
    /** Execution timeout in milliseconds */
    timeout?: number;
}
export interface SandboxOptions {
    /** Execution backend type. Defaults to 'native' if docker is unavailable */
    backend?: 'native' | 'docker' | string;
    /** CPU cores count */
    cpu?: number;
    /** Memory limit e.g. "512MB" */
    memory?: string | number;
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
    /** Structured execution metadata */
    metadata: ExecutionMetadata;
}
export declare class SandboxError extends Error {
    readonly code: 'TIMEOUT' | 'OOM' | 'INVALID_BACKEND' | 'EXEC_FAILED' | 'FS_ERROR' | 'UNKNOWN';
    readonly details?: unknown | undefined;
    constructor(message: string, code: 'TIMEOUT' | 'OOM' | 'INVALID_BACKEND' | 'EXEC_FAILED' | 'FS_ERROR' | 'UNKNOWN', details?: unknown | undefined);
}
