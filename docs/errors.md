# Error Reference

Every failure surfaced by the SDK is either a **thrown `SandboxError`** (or
`SandboxResourceError`) or a **non-error terminal execution state**. This page
documents each code, its typical cause, the recommended recovery behavior, and
whether the sandbox instance remains reusable afterwards.

For the canonical error type definitions, see `sdk/typescript/src/core/types.ts`.
The execution statuses (`running → completed | failed | cancelled | timedout`)
are described in `docs/api.md`.

---

## Summary

| Code                    | Kind            | Thrown when                                                         | Sandbox reusable? |
| ----------------------- | --------------- | ------------------------------------------------------------------- | ----------------- |
| `ERR_CPU_EXCEEDED`      | Resource error  | A workload consumed more CPU time than `cpuTimeLimit`                | Yes (`recoverable: true`) |
| `ERR_OOM_EXCEEDED`      | Resource error  | A workload's memory exceeded the configured limit                    | Yes (`recoverable: true`) |
| `ERR_DISK_QUOTA_EXCEEDED` | Resource error | The workspace grew past `diskQuota`                                  | Yes (`recoverable: true`, workspace rolled back) |
| `EXEC_FAILED`           | SandboxError    | A process could not be spawned, or the backend lost its container    | Usually: probe first |
| `FS_ERROR`              | SandboxError    | A filesystem operation was refused or failed                          | Yes, unless the sandbox FS is corrupt |
| `INVALID_BACKEND`       | SandboxError    | Backend creation/startup failed or the backend name is unknown        | No sandbox exists yet; retry creation |
| `TIMEOUT`               | *declared, not thrown* | Reserved. Wall-clock timeouts surface as the `timedout` status instead | Yes |
| `OOM`                   | *legacy*        | Replaced by `ERR_OOM_EXCEEDED`                                        | Yes |
| `UNKNOWN`               | *reserved*      | Not currently emitted by any backend                                   | n/a |

---

## `ERR_CPU_EXCEEDED` (SandboxResourceError)

- **Meaning**: The process group consumed more cumulative CPU time (user + system) than the configured `cpuTimeLimit` (ms). CPU **time** budgets are enforced across the whole process tree, so pipelines, background jobs, and forked workers are counted.
- **Typical cause**: A busy loop, tight computation, or CPU-bound workload running past its budget while still within the wall-clock `timeout`.
- **Recovery behavior**: The offending process group is force-killed. The error carries `resource: 'cpu'`, `limit`, `observed`, and `recoverable: true`. No cleanup is required.
- **Sandbox reuse expected**: **Yes.** Use a follow-up `exec` (e.g. `echo probe`) to confirm health.

## `ERR_OOM_EXCEEDED` (SandboxResourceError)

- **Meaning**: The sampled resident set size (RSS) of the process group exceeded the configured memory limit.
- **Typical cause**: A workload allocating memory past `memory` (per-execution or sandbox-level).
- **Recovery behavior**: The process group is force-killed. The error carries `resource: 'memory'`, `limit`, `observed`, and `recoverable: true`.
- **Sandbox reuse expected**: **Yes.** No workspace mutation occurs as a side effect of enforcement.

## `ERR_DISK_QUOTA_EXCEEDED` (SandboxResourceError)

- **Meaning**: The sandbox workspace usage grew past the configured `diskQuota`.
- **Typical cause**: A workload writing files (`dd`, `fallocate`, shell redirections, downloads) past the quota, possibly faster than the 250 ms enforcement poll interval.
- **Recovery behavior**: The process group is force-killed and the native backend **rolls back files created during the failing execution**, returning the workspace under quota. The error carries `resource: 'disk'`, `limit`, `observed`, and `recoverable: true`.
- **Sandbox reuse expected**: **Yes**; the rollback is specifically designed to keep the sandbox reusable despite having no delete API.

> **Backend coverage**: `ERR_CPU_EXCEEDED`, `ERR_OOM_EXCEEDED`, and
> `ERR_DISK_QUOTA_EXCEEDED` are currently enforced by the **native** backend only.
> The Docker backend reports `cpuLimits`/`memoryLimits` as `false` (see
> `capabilities`) and does not enforce a disk quota.

## `EXEC_FAILED` (SandboxError)

- **Meaning**: A process could not be started, or the backend is no longer able to execute.
- **Typical cause**
  - Native: the shell spawn itself failed (e.g. missing interpreter, `EMFILE`, out of memory in the parent).
  - Docker: the container is no longer running when an execution is attempted.
- **Recovery behavior**: No automatic recovery. If the sandbox is still alive, a follow-up `exec` may succeed; if it keeps failing, destroy and recreate the sandbox.
- **Sandbox reuse expected**: **Maybe.** Probe with a trivial command; if it fails, create a new sandbox.

## `FS_ERROR` (SandboxError)

- **Meaning**: A filesystem operation was refused or could not be completed.
- **Typical cause**
  - Path traversal or absolute-path attempts outside the sandbox workspace.
  - Symlink escape attempts (native backend resolves symlinks to enforce containment).
  - NUL bytes in a path (Docker).
  - Underlying I/O failures inside the container (Docker `cat`/`cp` errors).
- **Recovery behavior**: The refused operation is a no-op; nothing was written outside the sandbox. Retry with a contained path.
- **Sandbox reuse expected**: **Yes**, unless the failure was an I/O error inside the container that left its filesystem in an unexpected state.

## `INVALID_BACKEND` (SandboxError)

- **Meaning**: No such execution backend exists, or the requested backend failed to start.
- **Typical cause**
  - `backend: 'unknown-name'` passed to `Sandbox.create`.
  - Docker daemon unreachable, image missing, or the container failed to start (`docker run` non-zero exit).
  - The Docker CLI itself could not be spawned.
- **Recovery behavior**: Adjust the backend name/config or fix the Docker setup, then retry `Sandbox.create`. No sandbox instance is returned on failure.
- **Sandbox reuse expected**: n/a; there is no sandbox to reuse.

---

## Non-error terminal states

These are **not** thrown errors; they are reported through `Execution`:

| State | Condition | Recovery | Reusable? |
| ----- | --------- | -------- | --------- |
| `timedout` | Wall-clock `timeout` exceeded; `result.timedOut === true`, `exitCode === -1` | Retry with a larger timeout or a cheaper command | Yes |
| `failed` | `exitCode !== 0` (command returned non-zero) | Inspect `stderr()`, fix the command, retry | Yes |
| `cancelled` | `execution.cancel()` was called | Simply start a new execution | Yes |

---

## Catching and inspecting errors

```ts
import { SandboxError, SandboxResourceError } from '@palmshed/sandbox';

try {
  await (await sandbox.exec('node -e "let x=0; while(true){x++}"', {
    cpuTimeLimit: 500,
  })).wait();
} catch (err) {
  if (err instanceof SandboxResourceError) {
    console.log(err.code);        // 'ERR_CPU_EXCEEDED'
    console.log(err.resource);    // 'cpu'
    console.log(err.limit);       // 500
    console.log(err.recoverable); // true
  } else if (err instanceof SandboxError) {
    console.log(err.code);        // e.g. 'EXEC_FAILED', 'FS_ERROR'
  }
}
```

Resource errors surface by rejecting `execution.wait()` (or `execution.result()`
remaining `null`). Non-resource failures that are not thrown appear as terminal
execution statuses.

## Debug logging

Set `SANDBOX_LOG=debug` to emit lifecycle and resource-enforcement events to
stderr (off by default):

```bash
SANDBOX_LOG=debug node your-app.mjs
```

Logs contain identifiers and resource configuration only: never secrets,
environment values, command contents, or filesystem contents. See the
`SANDBOX_LOG=debug` section in the README for the emitted event schema.
