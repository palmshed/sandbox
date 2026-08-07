"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sandbox = void 0;
const index_js_1 = require("../backends/index.js");
const execution_js_1 = require("./execution.js");
class Sandbox {
    backendEngine;
    isDestroyed = false;
    constructor(backendEngine) {
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
    static async create(options = {}) {
        const backendName = options.backend || 'native';
        const engine = (0, index_js_1.createBackend)(backendName);
        await engine.init(options);
        return new Sandbox(engine);
    }
    /** Current backend engine name */
    get backendName() {
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
    async exec(command, options = {}) {
        this.ensureActive();
        const execId = `exec_${Math.random().toString(36).substring(2, 10)}`;
        const handle = new execution_js_1.Execution(execId, this.backendEngine.name);
        const wrappedOptions = {
            ...options,
            onStdout: (chunk) => {
                handle._onStdout(chunk);
                options.onStdout?.(chunk);
            },
            onStderr: (chunk) => {
                handle._onStderr(chunk);
                options.onStderr?.(chunk);
            },
        };
        this.backendEngine.exec(command, wrappedOptions).then((result) => {
            result.id = execId;
            result.metadata.id = execId;
            handle._complete(result);
        });
        return handle;
    }
    /** Read file content from the sandbox filesystem */
    async readFile(filePath) {
        this.ensureActive();
        return await this.backendEngine.readFile(filePath);
    }
    /** Write string or Buffer content to a file inside the sandbox filesystem */
    async writeFile(filePath, content) {
        this.ensureActive();
        return await this.backendEngine.writeFile(filePath, content);
    }
    /** Upload a file from host filesystem into the sandbox */
    async uploadFile(localPath, sandboxPath) {
        this.ensureActive();
        return await this.backendEngine.uploadFile(localPath, sandboxPath);
    }
    /** Download a file from sandbox filesystem to the host */
    async downloadFile(sandboxPath, localPath) {
        this.ensureActive();
        return await this.backendEngine.downloadFile(sandboxPath, localPath);
    }
    /** Destroy and purge all sandbox resources and execution processes */
    async destroy() {
        if (this.isDestroyed)
            return;
        this.isDestroyed = true;
        await this.backendEngine.destroy();
    }
    ensureActive() {
        if (this.isDestroyed) {
            throw new Error('Sandbox instance has already been destroyed.');
        }
    }
}
exports.Sandbox = Sandbox;
