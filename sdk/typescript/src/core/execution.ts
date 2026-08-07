import { ExecResult, ExecutionMetadata } from './types.js';

export class Execution {
  constructor(private readonly _result: ExecResult) {}

  /** Unique execution identifier */
  get id(): string {
    return this._result.id;
  }

  /** Process exit status code */
  get exitCode(): number {
    return this._result.exitCode;
  }

  /** Captured stdout output string */
  get stdout(): string {
    return this._result.stdout;
  }

  /** Captured stderr output string */
  get stderr(): string {
    return this._result.stderr;
  }

  /** Execution duration in milliseconds */
  get durationMs(): number {
    return this._result.durationMs;
  }

  /** True if process execution timed out */
  get timedOut(): boolean {
    return this._result.timedOut;
  }

  /** Full structured execution metadata */
  get metadata(): ExecutionMetadata {
    return this._result.metadata;
  }

  /** Access raw ExecResult payload */
  result(): ExecResult {
    return this._result;
  }
}
