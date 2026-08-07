import { BackendEngine } from './interface.js';
import { ExecOptions, ExecResult, SandboxOptions } from '../core/types.js';
export declare class NativeBackend implements BackendEngine {
    readonly name = "native";
    readonly capabilities: {
        filesystem: boolean;
        networkIsolation: boolean;
        cpuLimits: boolean;
        memoryLimits: boolean;
        streaming: boolean;
        remoteExecution: boolean;
    };
    private sandboxDir;
    private options;
    /** Active child processes — killed on destroy() */
    private activeProcesses;
    init(options: SandboxOptions): Promise<void>;
    exec(command: string, options?: ExecOptions): Promise<ExecResult>;
    private resolveSandboxPath;
    readFile(filePath: string): Promise<Buffer>;
    writeFile(filePath: string, content: Buffer | string): Promise<void>;
    uploadFile(localPath: string, sandboxPath: string): Promise<void>;
    downloadFile(sandboxPath: string, localPath: string): Promise<void>;
    destroy(): Promise<void>;
}
