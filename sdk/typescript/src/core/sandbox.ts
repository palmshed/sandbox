import { BackendEngine, createBackend } from '../backends/index.js';
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

  /** Run a process inside the sandbox runtime */
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.ensureActive();
    return await this.backendEngine.exec(command, options);
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
