import { EventEmitter } from 'events';
import { ExecResult, ExecutionMetadata } from './types.js';

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
 * Supports state transitions:
 *   running → completed | failed | cancelled | timedout
 *
 * @example
 * const execution = await sandbox.exec("npm test");
 *
 * execution.on("stdout", (line) => process.stdout.write(line));
 * execution.on("exit", (code) => console.log("Exit:", code));
 *
 * await execution.wait();
 * console.log(execution.status());    // "completed"
 * console.log(execution.metadata());  // full structured payload
 * console.log(execution.result());    // ExecResult
 * console.log(execution.logs());      // combined stdout+stderr
 */
export class Execution extends EventEmitter {
  private _status: ExecutionStatus;
  private _result: ExecResult | null = null;
  private _stdoutLog: string[] = [];
  private _stderrLog: string[] = [];
  private readonly _createdAt: number;
  private _settled: Promise<void>;
  private _settle!: () => void;

  constructor(
    private readonly _id: string,
    private readonly _backend: string,
  ) {
    super();
    this._status = 'running';
    this._createdAt = Date.now();
    this._settled = new Promise<void>((resolve) => {
      this._settle = resolve;
    });
  }

  // ── Identity ─────────────────────────────────────────────────────────

  /** Unique execution identifier, e.g. `exec_9a8b7c6d` */
  get id(): string {
    return this._id;
  }

  /** Stable URI for cross-service identification */
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

  // ── Results ────────────────────────────────────────────────────────────

  /** Structured execution metadata (available once settled) */
  metadata(): ExecutionMetadata | null {
    return this._result?.metadata ?? null;
  }

  /** Full ExecResult payload (available once settled) */
  /** Shortcut: process exit code (null while running) */
  get exitCode(): number {
    return this._result?.exitCode ?? -1;
  }

  /** Shortcut: accumulated stdout string */
  get stdout(): string {
    return this._stdoutLog.join('');
  }

  /** Shortcut: accumulated stderr string */
  get stderr(): string {
    return this._stderrLog.join('');
  }

  /** Shortcut: durationMs from result */
  get durationMs(): number {
    return this._result?.durationMs ?? Date.now() - this._createdAt;
  }

  /** Shortcut: whether execution timed out */
  get timedOut(): boolean {
    return this._result?.timedOut ?? false;
  }

  result(): ExecResult | null {
    return this._result;
  }

  /** Combined stdout + stderr log lines */
  logs(): string {
    return [...this._stdoutLog, ...this._stderrLog].join('');
  }

  // ── Signals ───────────────────────────────────────────────────────────

  /**
   * Cancel the execution. Currently signals via status transition.
   * Future: sends SIGTERM/SIGKILL to the backing process or remote endpoint.
   */
  async cancel(): Promise<void> {
    if (this._status !== 'running') return;
    this._status = 'cancelled';
    this.emit('cancelled');
    this._settle();
  }

  // ── Internal (called by backends) ─────────────────────────────────────

  /** @internal */
  _onStdout(chunk: string): void {
    this._stdoutLog.push(chunk);
    this.emit('stdout', chunk);
  }

  /** @internal */
  _onStderr(chunk: string): void {
    this._stderrLog.push(chunk);
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
}
