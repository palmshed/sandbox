import { ExecOptions, ExecResult, SandboxOptions } from '../core/types.js';

/** RFC 0006 OS-level filesystem isolation tri-state (spec/capabilities.schema.json). */
export type OsFilesystemIsolationStatus = 'supported' | 'unsupported' | 'unknown';

export interface BackendCapabilities {
  filesystem: boolean;
  networkIsolation: boolean;
  cpuLimits: boolean;
  memoryLimits: boolean;
  streaming: boolean;
  remoteExecution?: boolean;
  /** RFC 0006: whether the executed process tree is confined to the workspace + runtime allowlist. */
  osFilesystemIsolation?: OsFilesystemIsolationStatus;
}

export interface BackendEngine {
  /** Backend identifier name (e.g., 'native', 'docker') */
  readonly name: string;

  /** Capability negotiation flags */
  readonly capabilities: BackendCapabilities;

  /** Initialize the backend execution environment/container */
  init(options: SandboxOptions): Promise<void>;

  /** Execute a command string or executable + args */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Read file content from sandbox filesystem */
  readFile(path: string): Promise<Buffer>;

  /** Write file content into sandbox filesystem */
  writeFile(path: string, content: Buffer | string): Promise<void>;

  /** Copy/Upload a local file into the sandbox */
  uploadFile(localPath: string, sandboxPath: string): Promise<void>;

  /** Download a file from sandbox to local filesystem */
  downloadFile(sandboxPath: string, localPath: string): Promise<void>;

  /** Clean up and destroy the isolated runtime environment */
  destroy(): Promise<void>;
}
