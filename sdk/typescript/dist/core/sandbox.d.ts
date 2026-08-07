import { ExecOptions, ExecResult, SandboxOptions } from './types.js';
export declare class Sandbox {
    private backendEngine;
    private isDestroyed;
    private constructor();
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
    static create(options?: SandboxOptions): Promise<Sandbox>;
    /** Current backend engine name */
    get backendName(): string;
    /** Negotiated capability flags of the active execution backend */
    get capabilities(): import("../backends/interface.js").BackendCapabilities;
    /** Run a process inside the sandbox runtime */
    exec(command: string, options?: ExecOptions): Promise<ExecResult>;
    /** Read file content from the sandbox filesystem */
    readFile(filePath: string): Promise<Buffer>;
    /** Write string or Buffer content to a file inside the sandbox filesystem */
    writeFile(filePath: string, content: Buffer | string): Promise<void>;
    /** Upload a file from host filesystem into the sandbox */
    uploadFile(localPath: string, sandboxPath: string): Promise<void>;
    /** Download a file from sandbox filesystem to the host */
    downloadFile(sandboxPath: string, localPath: string): Promise<void>;
    /** Destroy and purge all sandbox resources and execution processes */
    destroy(): Promise<void>;
    private ensureActive;
}
