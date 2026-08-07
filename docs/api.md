# `@palmshed/sandbox` API Reference

> Runtime specification: `0.1.1` | SDK: `0.1.0-alpha.3`

---

## Installation

```bash
npm install @palmshed/sandbox
```

Or from a local tarball:

```bash
npm install ./palmshed-sandbox-0.1.0-alpha.3.tgz
```

---

## `Sandbox`

### `Sandbox.create(options?)`

Creates and initializes a sandbox instance.

```ts
import { Sandbox } from '@palmshed/sandbox';

const sandbox = await Sandbox.create({
  backend:  'native',      // 'native' | 'docker'. Default: 'native'
  timeout:  10000,         // ms — default execution timeout
  cpu:      1,             // CPU units (backend-dependent; quota not enforced by native)
  cpuTimeLimit: 2000,      // ms — CPU time budget enforced across the process group
  memory:   '256MB',       // memory bound (backend-dependent)
  network:  'disabled',    // 'disabled' | 'allow' | 'proxy'
});
```

### `sandbox.capabilities`

Reports which features the active backend supports. Check before calling optional features.

```ts
const caps = sandbox.capabilities;
// {
//   filesystem: true,
//   networkIsolation: false,
//   cpuLimits: true,
//   memoryLimits: true,
//   streaming: true,
//   remoteExecution: false
// }
```

`cpuLimits: true` reflects CPU **time** budget enforcement (`cpuTimeLimit`). Platform coverage is not uniform:

| Platform | CPU | Memory |
|----------|-----|--------|
| Linux    | Supported (process-group sampling) | Supported (process-group sampling) |
| macOS    | Supported (process-group sampling) | Supported (process-group sampling) |
| Windows  | Best-effort (WMIC process-tree polling) | Best-effort (WMIC process-tree polling) |
| Other    | Unsupported (falls back to timeout) | Unsupported (falls back to timeout) |

On Windows a child that detaches from the process tree can escape accounting; Linux/macOS cover pipelines, background jobs, and chained `sh -c` children. The hard core quota (`cpuQuota`) is experimental and not enforced by the Native backend.

### `sandbox.backendName`

Returns the active backend name (`'native'` | `'docker'`).

### `sandbox.exec(command, options?)`

Executes a shell command. Returns an `Execution` handle immediately — the process is already running.

```ts
const execution = await sandbox.exec('node -e "console.log(42)"');
// execution.status() === 'running'
```

Options:

```ts
{
  timeout?: number;   // override sandbox-level timeout for this execution
  cpuTimeLimit?: number; // ms — CPU time budget for this execution (overrides sandbox-level)
  memory?: string | number; // memory bound override (e.g. '256MB')
  stdout?:  Writable; // pipe stdout directly to a stream
  stderr?:  Writable; // pipe stderr directly to a stream
  onStdout?: (chunk: string) => void;  // callback per chunk
  onStderr?: (chunk: string) => void;
}
```

### `sandbox.writeFile(path, content)`

Writes a file into the sandbox virtual filesystem.

```ts
await sandbox.writeFile('main.js', 'console.log("hello")');
```

### `sandbox.readFile(path)`

Reads a file from the sandbox virtual filesystem. Returns `Buffer`.

```ts
const buf = await sandbox.readFile('output.txt');
console.log(buf.toString());
```

### `sandbox.uploadFile(localPath, remotePath)`

Copies a file from the host into the sandbox.

```ts
await sandbox.uploadFile('/tmp/input.csv', 'data/input.csv');
```

### `sandbox.downloadFile(remotePath, localPath)`

Copies a file from the sandbox to the host.

```ts
await sandbox.downloadFile('results/out.json', '/tmp/out.json');
```

### `sandbox.destroy()`

Tears down the sandbox and releases all resources. Always call this.

```ts
await sandbox.destroy();
```

---

## `Execution`

Returned by `sandbox.exec()`. Extends `EventEmitter`.

### State

```
running → completed | failed | cancelled | timedout
```

### `execution.status()`

Returns current status string.

### `execution.wait()`

Resolves when the execution reaches a terminal state.

```ts
await execution.wait();
```

### `execution.exitCode`

Process exit code. `-1` while still running.

### `execution.durationMs`

Elapsed milliseconds. Live value while running, final value after settled.

### `execution.timedOut`

`true` if the execution was killed due to timeout.

### `execution.stdout()`

Accumulated stdout as a string.

```ts
const out = execution.stdout(); // 'hello\n'
```

### `execution.stderr()`

Accumulated stderr as a string.

### `execution.logs()`

`stdout + stderr` concatenated.

### `execution.stdoutStream()`

Returns a Node.js `Readable` over accumulated stdout. Useful for large outputs or piping.

```ts
const stream = execution.stdoutStream();
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

### `execution.stderrStream()`

Returns a Node.js `Readable` over accumulated stderr.

### `execution.metadata()`

Returns structured metadata after `wait()` resolves. `null` while running.

```ts
const meta = execution.metadata();
// {
//   id: 'exec_abc123',
//   backend: 'native',
//   specVersion: '0.1.1',
//   startedAt: '2026-08-08T00:00:00.000Z',
//   finishedAt: '2026-08-08T00:00:01.200Z',
//   durationMs: 1200,
//   exitCode: 0,
//   timedOut: false,
//   cpuTimeMs: 84.6
// }
```

### `execution.cancel()`

Cancels the execution. Currently transitions status to `cancelled`. Process-level signal (`SIGTERM`/`SIGKILL`) is pending.

```ts
await execution.cancel();
```

### `execution.id`

Unique identifier, e.g. `exec_9a8b7c6d`.

### `execution.uri`

Stable cross-service URI: `sandbox://execution/<id>`.

---

## Events

```ts
execution.on('stdout', (chunk: string) => { /* real-time output */ });
execution.on('stderr', (chunk: string) => { /* real-time error output */ });
execution.on('exit',   (code: number, timedOut: boolean) => { /* terminal */ });
execution.on('progress', ({ durationMs }: { durationMs: number }) => { /* live timing */ });
execution.on('cancelled', () => { /* cancelled */ });
```

---

## Common Patterns

### Run and collect output

```ts
const sandbox = await Sandbox.create({ backend: 'native' });

const execution = await sandbox.exec('echo "hello world"');
await execution.wait();

console.log(execution.stdout().trim()); // 'hello world'
console.log(execution.exitCode);        // 0

await sandbox.destroy();
```

### Stream output in real time

```ts
const execution = await sandbox.exec('npm test');
execution.on('stdout', (chunk) => process.stdout.write(chunk));
execution.on('stderr', (chunk) => process.stderr.write(chunk));
await execution.wait();
```

### Write a file, execute it, read results

```ts
await sandbox.writeFile('script.js', `
  const result = { value: 42, ok: true };
  require('fs').writeFileSync('out.json', JSON.stringify(result));
`);

const execution = await sandbox.exec('node script.js');
await execution.wait();

const buf = await sandbox.readFile('out.json');
const result = JSON.parse(buf.toString());
console.log(result); // { value: 42, ok: true }
```

### Enforce a timeout

```ts
const execution = await sandbox.exec('node -e "setTimeout(() => {}, 60000)"', {
  timeout: 500,
});
await execution.wait();

console.log(execution.status());  // 'timedout'
console.log(execution.timedOut);  // true
```

### Enforce a CPU time budget

Limits cumulative user+system CPU time across the whole process group (shell children, pipelines, background jobs), independent of wall-clock `timeout`.

```ts
import { SandboxResourceError } from '@palmshed/sandbox';

const execution = await sandbox.exec('node -e "while(true){}"', {
  cpuTimeLimit: 300, // ms of CPU time
  timeout: 5000,    // wall-clock guard
});
await execution.wait();

console.log(execution.status());      // 'failed'
// wait() rejects with SandboxResourceError:
//   code: 'ERR_CPU_EXCEEDED', resource: 'cpu', recoverable: true
```

After a CPU-limit kill the sandbox remains usable; a workload may run again immediately. `cpuTimeMs` in `metadata()`/`result()` reports best-effort CPU time.

---

## Known Limitations (`v0.1.0-alpha.3`)

* `execution.cancel()` transitions state only — does not yet send `SIGTERM`/`SIGKILL`.
* CPU **time** limit (`cpuTimeLimit`) is enforced by the Native backend; the hard core quota (`cpuQuota`) is experimental and not enforced.
* CPU and memory enforcement on Windows is best-effort (WMIC polling); a child that detaches from the process tree can escape accounting. Linux/macOS sample the full process group.
* Filesystem isolation (chroot, mount restrictions) is not yet active.
* Docker backend is present but not at full feature parity with Native.

These are tracked in the [`v0.1.0` milestone](https://github.com/palmshed/sandbox/milestone/1).
