import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { ExecResult, ExecutionMetadata } from './types.js';
import { BoundedOutput } from './retention.js';

export type ExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timedout';

export interface ExecutionEvents {
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  exit: (code: number, timedOut: boolean) => void;
  progress: (info: { durationMs: number }) => void;
  cancelled: () => void;
}

/**
 * Represents a live execution inside a Sandbox.
 *
 * State transitions:  running → completed | failed | cancelled | timedout
 *
 * @example
 * const execution = await sandbox.exec("npm test");
 *
 * execution.on("stdout", (chunk) => process.stdout.write(chunk));
 * execution.on("exit",   (code)  => console.log("Exit:", code));
 *
 * await execution.wait();
 *
 * console.log(execution.status());   // "completed"
 * console.log(execution.exitCode);   // 0
 * console.log(execution.stdout());   // retained stdout (bounded; see truncated)
 * console.log(execution.stderr());   // retained stderr (bounded)
 * console.log(execution.logs());     // stdout + stderr combined
 * console.log(execution.metadata()); // { id, backend, specVersion, startedAt, ... }
 * console.log(execution.result());   // raw ExecResult
 *
 * // Stream-oriented (forward-compatible with large/remote outputs)
 * const s = execution.stdoutStream(); // Node.js Readable
 */
export class Execution extends EventEmitter {
  private _status: ExecutionStatus;
  private _result: ExecResult | null = null;
  // Bounded retention (issue #12): at most the last 16 MiB per stream is
  // kept. Real-time events below stay complete and unthrottled.
  private readonly _stdout = new BoundedOutput();
  private readonly _stderr = new BoundedOutput();
  private readonly _createdAt: number;
  private _settled: Promise<void>;
  private _settle!: () => void;
  private _reject!: (err: unknown) => void;
  /** Kill function registered by the backend once the process is spawned */
  private _killFn: ((signal?: NodeJS.Signals) => void) | null = null;

  constructor(
    private readonly _id: string,
    private readonly _backend: string,
  ) {
    super();
    this._status = 'running';
    this._createdAt = Date.now();
    this._settled = new Promise<void>((resolve, reject) => {
      this._settle = resolve;
      this._reject = reject;
    });
  }

  // ── Identity ─────────────────────────────────────────────────────────

  /** Unique execution identifier, e.g. `exec_9a8b7c6d` */
  get id(): string {
    return this._id;
  }

  /** Stable cross-service URI: `sandbox://execution/<id>` */
  get uri(): string {
    return `sandbox://execution/${this._id}`;
  }

  // ── State ─────────────────────────────────────────────────────────────

  /** Current lifecycle status */
  status(): ExecutionStatus {
    return this._status;
  }

  /** Wait until the execution reaches a terminal state */
  async wait(): Promise<void> {
    return this._settled;
  }

  // ── Convenience scalar properties ─────────────────────────────────────

  /** Process exit code; -1 while still running */
  get exitCode(): number {
    return this._result?.exitCode ?? -1;
  }

  /** Duration in milliseconds; live elapsed time while still running */
  get durationMs(): number {
    return this._result?.durationMs ?? Date.now() - this._createdAt;
  }

  /** True if execution timed out */
  get timedOut(): boolean {
    return this._result?.timedOut ?? false;
  }

  // ── Output methods (string, forward-compatible with streaming) ────────

  /**
   * Returns retained stdout as a string (at most the last 16 MiB; see
   * `truncated`). Prefer `on("stdout", …)` for complete real-time
   * consumption.
   */
  stdout(): string {
    return this._stdout.text();
  }

  /**
   * Returns retained stderr as a string (bounded like stdout).
   * Prefer `on("stderr", …)` for complete real-time consumption.
   */
  stderr(): string {
    return this._stderr.text();
  }

  /** Returns retained stdout + retained stderr as a single string */
  logs(): string {
    return this._stdout.text() + this._stderr.text();
  }

  /** True once either stream dropped retained bytes (sticky). */
  get truncated(): boolean {
    return this._stdout.truncated || this._stderr.truncated;
  }

  /**
   * Returns a Node.js Readable stream over retained stdout.
   */
  stdoutStream(): Readable {
    return Readable.from(this._stdout.text());
  }

  /**
   * Returns a Node.js Readable stream over retained stderr.
   */
  stderrStream(): Readable {
    return Readable.from(this._stderr.text());
  }

  // ── Structured results ─────────────────────────────────────────────────

  /** Structured execution metadata (available once settled) */
  metadata(): ExecutionMetadata | null {
    return this._result?.metadata ?? null;
  }

  /** Full raw ExecResult payload (available once settled) */
  result(): ExecResult | null {
    return this._result;
  }

  // ── Signals ───────────────────────────────────────────────────────────

  /**
   * Cancel the execution.
   * Sends SIGTERM to the process group, then SIGKILL after 1s if still running.
   */
  async cancel(): Promise<void> {
    if (this._status !== 'running') return;
    this._status = 'cancelled';
    this.emit('cancelled');
    if (this._killFn) {
      this._killFn('SIGTERM');
    }
    this._settle();
  }

  // ── Internal (called by backends/Sandbox) ─────────────────────────────

  /** @internal Register the process kill function provided by the backend */
  _registerKill(fn: (signal?: NodeJS.Signals) => void): void {
    this._killFn = fn;
  }

  /** @internal */
  _onStdout(chunk: string): void {
    this._stdout.push(chunk);
    this.emit('stdout', chunk);
  }

  /** @internal */
  _onStderr(chunk: string): void {
    this._stderr.push(chunk);
    this.emit('stderr', chunk);
  }

  /** @internal */
  _complete(result: ExecResult): void {
    this._result = result;
    if (result.timedOut) {
      this._status = 'timedout';
    } else if (result.exitCode === 0) {
      this._status = 'completed';
    } else {
      this._status = 'failed';
    }
    this.emit('exit', result.exitCode, result.timedOut);
    this.emit('progress', { durationMs: result.durationMs });
    this._settle();
  }

  /**
   * @internal
   * Called when the backend rejects an execution (e.g. ERR_OOM_EXCEEDED, ERR_DISK_QUOTA_EXCEEDED).
   * Sets status to 'failed' and rejects the wait() promise with the original error.
   */
  _fail(err: unknown): void {
    if (this._status !== 'running') return;
    this._status = 'failed';
    this._reject(err);
  }
}
