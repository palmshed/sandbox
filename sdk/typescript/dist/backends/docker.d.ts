import { BackendEngine } from './interface.js';
import { ExecOptions, ExecResult, SandboxOptions } from '../core/types.js';
export declare class DockerBackend implements BackendEngine {
    readonly name = "docker";
    readonly capabilities: {
        filesystem: boolean;
        networkIsolation: boolean;
        cpuLimits: boolean;
        memoryLimits: boolean;
        streaming: boolean;
        remoteExecution: boolean;
    };
    private containerId;
    private options;
    init(options: SandboxOptions): Promise<void>;
    exec(command: string, options?: ExecOptions): Promise<ExecResult>;
    readFile(filePath: string): Promise<Buffer>;
    writeFile(filePath: string, content: Buffer | string): Promise<void>;
    uploadFile(localPath: string, sandboxPath: string): Promise<void>;
    downloadFile(sandboxPath: string, localPath: string): Promise<void>;
    destroy(): Promise<void>;
    private runDockerCmd;
}
