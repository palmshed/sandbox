"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sandbox = void 0;
const index_js_1 = require("../backends/index.js");
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
    /** Run a process inside the sandbox runtime */
    async exec(command, options) {
        this.ensureActive();
        return await this.backendEngine.exec(command, options);
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
