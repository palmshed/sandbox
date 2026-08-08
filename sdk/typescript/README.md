# @palmshed/sandbox

General-purpose sandbox protocol and TypeScript reference SDK for secure process
execution, filesystem isolation, resource limiting, and network policies.

Zero runtime dependencies. The published package ships the compiled `dist/`
output only; consumers do not need a TypeScript toolchain.

## Install

```sh
npm install @palmshed/sandbox
```

Requires Node.js 20 or newer (Node LTS).

## Quickstart

```ts
import { Sandbox } from '@palmshed/sandbox';

const sandbox = await Sandbox.create({
  backend: 'native',
  timeout: 5000,
  memory: '256MB',
  network: 'disabled',
});

const execution = await sandbox.exec('echo hello');
await execution.wait();
console.log(execution.stdout()); // hello

await sandbox.destroy();
```

## Capabilities

Capabilities are reported per backend via `sandbox.capabilities`:

```ts
{
  filesystem: true,
  networkIsolation: true,
  cpuLimits: true,
  memoryLimits: true,
  streaming: true,
  remoteExecution: false
}
```

The `native` backend enforces CPU time budgets and memory limits via
process-group accounting on Linux and macOS, with best-effort coverage on
Windows. The `docker` backend provides filesystem operations and streaming;
CPU/memory limits and network isolation are not yet enabled for it.

## Documentation

- API reference: `docs/api.md` in the repository.
- Error reference: `docs/errors.md`.
- Runtime specification and JSON schemas: `spec/` in the repository.
- Usage examples: `examples/` in the repository.

## License

MIT
