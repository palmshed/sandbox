# `@palmshed/sandbox` API Reference

> Runtime specification: `1.0.0` | SDK: `1.0.0`

---

## Installation

```bash
npm install @palmshed/sandbox
```

Or from a local tarball:

```bash
npm install ./palmshed-sandbox-1.0.0.tgz
```

---

## `Sandbox`

### `Sandbox.create(options?)`

Creates and initializes a sandbox instance.

```ts
import { Sandbox } from '@palmshed/sandbox';

const sandbox = await Sandbox.create({
  backend:  'native',      // 'native' | 'docker'. Default: 'native'
  timeout:  10000,         // ms: default execution timeout
  cpu:      1,             // CPU units (backend-dependent; quota not enforced by native)
  cpuTimeLimit: 2000,      // ms: CPU time budget enforced across the process group
  memory:   '256MB',       // memory bound (backend-dependent)
  network:  'disabled',    // 'disabled' | 'allow' | 'proxy'
  // RFC 0006: apply OS-level filesystem isolation when the backend supports it
  // (Linux + Landlock). Defaults to true when supported; false is an explicit,
  // documented opt-out, never a silent downgrade.
  osFilesystemIsolation: true,
});
```

### `sandbox.capabilities`

Reports which features the active backend supports. Check before calling optional features.

```ts
const caps = sandbox.capabilities;
// {
//   filesystem: true,
//   networkIsolation: true,
//   cpuLimits: true,
//   memoryLimits: true,
//   streaming: true,
//   osFilesystemIsolation: 'supported',   // 'supported' | 'unsupported' | 'unknown' (RFC 0006)
//   remoteExecution: false
// }
```

`cpuLimits: true` reflects CPU **time** budget enforcement (`cpuTimeLimit`). Platform coverage is not uniform:

| Platform | CPU | Memory |
|----------|-----|--------|
| Linux    | Supported (process-group sampling) | Supported (process-group sampling) |
| macOS    | Supported (process-group sampling) | Supported (process-group sampling) |
| Windows  | Best-effort (PowerShell CIM process-tree polling) | Best-effort (PowerShell CIM process-tree polling) |
| Other    | Unsupported (falls back to timeout) | Unsupported (falls back to timeout) |

On Windows a child that detaches from the process tree can escape accounting; Linux/macOS cover pipelines, background jobs, and chained `sh -c` children. The hard core quota (`cpuQuota`) is experimental and not enforced by the Native backend. Windows sampling uses `Get-CimInstance Win32_Process` (the replacement for the removed WMIC utility) and is verified in CI on `windows-latest`.

### OS-level filesystem isolation (RFC 0006)

`osFilesystemIsolation` is a tri-state capability (`'supported'` | `'unsupported'` | `'unknown'`) reporting whether the executing process tree is confined to the sandbox workspace plus a minimal read-only runtime allowlist (interpreter, shared libraries, loader, config, zoneinfo). This is a different guarantee from the `filesystem` capability (which describes the VFS boundary) and from `networkIsolation` (RFC 0004).

```ts
if (sandbox.capabilities.osFilesystemIsolation === 'supported') {
  // The workload cannot read or write outside its workspace except the
  // runtime paths it needs to execute. Escapes E1-E10 are covered by tests.
}
```

- **How it works (Linux)**: each execution runs through a Landlock confinement runner launched behind `unshare --user --map-root-user` (needed for the unprivileged `CAP_SYS_ADMIN`). The runner applies an irrevocable ruleset (workspace full access, runtime allowlist read/exec, everything else denied) and then execs the workload. `unknown` and `unsupported` mean no OS-filesystem confinement is enforced: treat them as ambient host rights.
- **Opt-out**: `Sandbox.create({ osFilesystemIsolation: false })` disables the mechanism for that sandbox even when supported. This is an explicit, documented opt-out (e.g. workloads that need `npm` or arbitrary host binaries), never a silent downgrade.
- **Platforms**: Linux with Landlock ABI >= 2 and unprivileged user namespaces reports `supported`; macOS reports `unknown` (Seatbelt filesystem profile is pending validation); Windows and others report `unsupported`.
- **Residuals**: `/proc` and `/sys` are not hidden by Landlock (path-based mechanism). Runtime allowlist and residuals are documented in `rfcs/0006-os-filesystem-isolation.md`.

### `sandbox.backendName`

Returns the active backend name (`'native'` | `'docker'`).

### `sandbox.exec(command, options?)`

Executes a shell command. Returns an `Execution` handle immediately; the process is already running.

```ts
const execution = await sandbox.exec('node -e "console.log(42)"');
// execution.status() === 'running'
```

Options:

```ts
{
  timeout?: number;   // override sandbox-level timeout for this execution
  cpuTimeLimit?: number; // ms: CPU time budget for this execution (overrides sandbox-level)
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
//   specVersion: '1.0.0',
//   startedAt: '2026-08-08T00:00:00.000Z',
//   finishedAt: '2026-08-08T00:00:01.200Z',
//   durationMs: 1200,
//   exitCode: 0,
//   timedOut: false,
//   cpuTimeMs: 84.6
// }
```

### `execution.result()`

Returns the full `ExecResult` payload after `wait()` resolves. `null` while running. Contains `id`, `exitCode`, `stdout`, `stderr`, `durationMs`, `timedOut`, `cpuTimeMs?`, and `metadata`.

```ts
const result = execution.result();
console.log(result?.stdout);   // accumulated stdout string
console.log(result?.exitCode); // 0
```

### `execution.cancel()`

Cancels the execution by sending `SIGTERM` to the process group, then `SIGKILL` after 1s if the process is still running. Transitions status to `cancelled` and emits the `cancelled` event.

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

## Errors & Recovery

Every thrown failure is a `SandboxError` (or `SandboxResourceError`) with a
structured `code`; non-thrown terminal outcomes surface as execution statuses
(`timedout`, `failed`, `cancelled`). For the meaning, typical cause, recovery
behavior, and sandbox-reuse expectations of each code, see
[`errors.md`](./errors.md).

## Crash Recovery (Native backend)

The Native backend cleans up after a host-process crash or unexpected
disconnection (RFC 0005). Two mechanisms work together:

1. **Graceful shutdown hooks.** When the host process exits normally, calls
   `process.exit()`, or receives a terminal signal (`SIGTERM`, `SIGINT`,
   `SIGHUP` on POSIX; `SIGINT`/`SIGBREAK` on Windows), the SDK runs the normal
   destroy path for every live sandbox: the workload process groups are
   terminated and the sandbox temp directories are removed. An uncaught
   exception also triggers the exit hook before the process terminates.
2. **Stale-sandbox reaper.** Each sandbox is registered in a shared registry
   under the OS temp directory with the owning host PID, that PID's process
   start-time token, and the workload process-group ids. When a sandbox is
   created, the reaper sweeps the registry and reclaims any sandbox whose
   recorded host is dead (or whose PID was recycled, detected via the start
   token mismatch): it kills the orphaned workload processes and removes the
   temp directory. This makes crash recovery eventual (on the next sandbox
   creation) rather than immediate.

### Guarantees

* A hard host crash (`SIGKILL`, segfault, OOM-kill, power loss) does not leak
  sandbox workloads or temp directories indefinitely.
* Backgrounded (`&`, `nohup`) workloads cannot escape reaping via the process
  group.
* A live sandbox is never reaped: recovery verifies the recorded host PID and
  its start-time token before reclaiming anything.
* Reaped sandboxes are never resurrected; a fresh `Sandbox.create()` always
  allocates a new workspace.

### Unavoidable limitations

* Cleanup is eventual: a hard-crashed host cannot clean up synchronously; the
  sweep runs on the next sandbox creation.
* No data is preserved: abandoned sandbox contents are destroyed, not
  quarantined.
* Windows has no POSIX process groups; reaping uses `taskkill /T /F` tree kill
  and the start-time token is best-effort.
* The registry metadata is not tamper-proof: the Native backend has no
  OS-level filesystem isolation yet (issue `#3`), so a hostile workload sharing
  the host account could in principle interfere with recovery bookkeeping. This
  is a documented consequence of running without OS isolation, not a recovery
  guarantee.

---

## Known Limitations (`v1.0.0`)

* `cancel()` sends `SIGTERM` to the process group (then `SIGKILL` after 1s).
* CPU **time** limit (`cpuTimeLimit`) is enforced by the Native backend; the hard core quota (`cpuQuota`) is experimental and not enforced.
* CPU and memory enforcement on Windows is best-effort (PowerShell `Get-CimInstance` process-tree polling); a child that detaches from the process tree can escape accounting. Linux/macOS sample the full process group.
* OS-level filesystem isolation (chroot, mount restrictions) is not yet active; the native backend provides soft process isolation with a hardened virtual filesystem boundary.
* Docker backend is available but only claims `filesystem` and `streaming`. Its `cpuLimits`, `memoryLimits`, and `networkIsolation` capabilities are reported `false`: the driver wires `docker run/exec/cp/stop` CLI calls, but CPU time-budget enforcement, per-execution memory overrides, and network policies beyond `disabled` are not implemented or integration-tested (work item `#4`). Verify `sandbox.capabilities` before relying on Docker resource/network guarantees.

These are tracked in the [`v1.0.0` milestone](https://github.com/palmshed/sandbox/milestone/1).
