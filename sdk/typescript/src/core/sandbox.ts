import { BackendEngine, createBackend } from '../backends/index.js';
import { Execution } from './execution.js';
import { ExecOptions, ExecResult, SandboxOptions } from './types.js';

export class Sandbox {
  private backendEngine: BackendEngine;
  private isDestroyed = false;

  private constructor(backendEngine: BackendEngine) {
    this.backendEngine = backendEngine;
  }

  /**
   * Factory method to create and initialize a new isolated sandbox instance.
   *
   * @example
   * ```ts
   * const sandbox = await Sandbox.create({
   *   cpu: 2,
   *   memory: "512MB",
   *   timeout: 30000,
   *   network: "disabled"
   * });
   *
   * const res = await sandbox.exec("node -v");
   * console.log(res.stdout);
   * await sandbox.destroy();
   * ```
   */
  static async create(options: SandboxOptions = {}): Promise<Sandbox> {
    const backendName = options.backend || 'native';
    const engine = createBackend(backendName);
    await engine.init(options);
    return new Sandbox(engine);
  }

  /** Current backend engine name */
  get backendName(): string {
    return this.backendEngine.name;
  }

  /** Negotiated capability flags of the active execution backend */
  get capabilities() {
    return this.backendEngine.capabilities;
  }

  /**
   * Run a process inside the sandbox and return a live Execution handle.
   *
   * The handle transitions through: running → completed | failed | cancelled | timedout
   *
   * @example
   * const execution = await sandbox.exec("npm test");
   * execution.on("stdout", (chunk) => process.stdout.write(chunk));
   * execution.on("exit", (code) => console.log("Exit:", code));
   * await execution.wait();
   * console.log(execution.status());   // "completed" | "failed" | "timedout"
   * console.log(execution.metadata()); // { id, backend, specVersion, ... }
   */
  async exec(command: string, options: ExecOptions = {}): Promise<Execution> {
    this.ensureActive();
    const execId = `exec_${Math.random().toString(36).substring(2, 10)}`;
    const handle = new Execution(execId, this.backendEngine.name);

    const wrappedOptions: ExecOptions = {
      ...options,
      onStdout: (chunk) => {
        handle._onStdout(chunk);
        options.onStdout?.(chunk);
      },
      onStderr: (chunk) => {
        handle._onStderr(chunk);
        options.onStderr?.(chunk);
      },
      // Backend calls this once the child process is spawned.
      // We pass the kill function to the Execution handle so cancel()
      // and destroy()-during-execution can terminate the real process.
      onProcessSpawned: (kill) => {
        handle._registerKill(kill);
      },
    };

    this.backendEngine.exec(command, wrappedOptions).then((result) => {
      result.id = execId;
      result.metadata.id = execId;
      handle._complete(result);
    }).catch((err) => {
      handle._fail(err);
    });

    return handle;
  }

  /** Read file content from the sandbox filesystem */
  async readFile(filePath: string): Promise<Buffer> {
    this.ensureActive();
    return await this.backendEngine.readFile(filePath);
  }

  /** Write string or Buffer content to a file inside the sandbox filesystem */
  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    this.ensureActive();
    return await this.backendEngine.writeFile(filePath, content);
  }

  /** Upload a file from host filesystem into the sandbox */
  async uploadFile(localPath: string, sandboxPath: string): Promise<void> {
    this.ensureActive();
    return await this.backendEngine.uploadFile(localPath, sandboxPath);
  }

  /** Download a file from sandbox filesystem to the host */
  async downloadFile(sandboxPath: string, localPath: string): Promise<void> {
    this.ensureActive();
    return await this.backendEngine.downloadFile(sandboxPath, localPath);
  }

  /** Destroy and purge all sandbox resources and execution processes */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    await this.backendEngine.destroy();
  }

  private ensureActive(): void {
    if (this.isDestroyed) {
      throw new Error('Sandbox instance has already been destroyed.');
    }
  }
}
