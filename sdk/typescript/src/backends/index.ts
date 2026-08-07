import { BackendEngine } from './interface.js';
import { NativeBackend } from './native.js';
import { DockerBackend } from './docker.js';
import { SandboxError } from '../core/types.js';

export type BackendFactory = () => BackendEngine;

const backendRegistry = new Map<string, BackendFactory>();

// Register default built-in backends
backendRegistry.set('native', () => new NativeBackend());
backendRegistry.set('docker', () => new DockerBackend());

export function registerBackend(name: string, factory: BackendFactory): void {
  backendRegistry.set(name.toLowerCase(), factory);
}

export function createBackend(name: string = 'native'): BackendEngine {
  const factory = backendRegistry.get(name.toLowerCase());
  if (!factory) {
    throw new SandboxError(
      `Unsupported backend '${name}'. Available backends: ${Array.from(backendRegistry.keys()).join(', ')}`,
      'INVALID_BACKEND'
    );
  }
  return factory();
}

export { BackendEngine } from './interface.js';
export { NativeBackend } from './native.js';
export { DockerBackend } from './docker.js';
