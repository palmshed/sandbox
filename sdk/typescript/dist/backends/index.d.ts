import { BackendEngine } from './interface.js';
export type BackendFactory = () => BackendEngine;
export declare function registerBackend(name: string, factory: BackendFactory): void;
export declare function createBackend(name?: string): BackendEngine;
export { BackendEngine } from './interface.js';
export { NativeBackend } from './native.js';
export { DockerBackend } from './docker.js';
