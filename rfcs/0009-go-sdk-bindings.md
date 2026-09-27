# RFC 0009: Go SDK Binding Note (F2)

- **Status**: Accepted as the F2 implementation contract. No code yet.
- **Scope**: Maps the existing sandbox contract to Go without redefining
  it. JSON schemas stay authoritative; this note fixes how TypeScript-isms
  surface in Go, how Go's concurrency model preserves terminal-state
  semantics, and what counts as release evidence.
- **Rule for the sequence**: each language gets its own binding note and
  native concurrency/error model, while the Sandbox contract stays
  singular.

## 1. Public API mapping

Same contract as the reference SDK: `Sandbox` (create, capabilities, exec,
filesystem operations, destroy), `Execution` (id, uri, status, wait, exit
code, duration, timedOut, stdout/stderr/logs, metadata/result, cancel,
output events), the data types, capability tri-state, `SPEC_VERSION`, and
the error-code family (`EXEC_FAILED`, `FS_ERROR`, `INVALID_BACKEND`,
`ERR_CPU_EXCEEDED`, `ERR_OOM_EXCEEDED`, `ERR_DISK_QUOTA_EXCEEDED`).

| TypeScript | Go |
|---|---|
| `Buffer` | `[]byte` |
| `Readable` stream | `io.Reader` (`StdoutStream`, `StderrStream`) |
| `Writable` options | `io.Writer` (piped stdout/stderr) |
| `EventEmitter` | `func(string)` callbacks plus `Done() <-chan struct{}` |
| `wait()` promise | `Wait()` (blocks until terminal) and `Done()` (channel) |
| `Option<T>` / absent | typed pointers (`*bool`, `*float64`, `*uint64`); `nil` is absent and means unknown, never false or zero |
| `NodeJS.Signals` | `syscall.Signal` on Unix, `taskkill /T /F` on Windows |
| `async` | goroutines coordinated with `sync` primitives; `context.Context` for caller-driven cancellation wiring |
| ISO-8601 timestamps | `time.Time` formatted as `2006-01-02T15:04:05.000Z`, matching the reference shape exactly |

## 2. Concurrency semantics (the Go-specific risk area)

Go has no borrow checker, so correctness here is runtime-proven rather
than compile-proven. The contract's observable behavior must be identical
to the reference SDK in all of the following:

1. **Guarded terminal state.** Status transitions are guarded by a mutex
   and a single terminal transition wins. A `Cancel` racing natural
   completion resolves one way deterministically (first terminal state
   observed by the guard), matching the reference contract; the SDK never
   reports `cancelled` after settling `completed`.
2. **Cancel cadence.** Cancellation sends `SIGTERM` to the process group,
   then `SIGKILL` after 1s, and is idempotent. A bare `context` cancel is
   not sufficient on its own; it wires the caller's context into the same
   guarded state machine.
3. **Callback ordering and affinity.** Each stream is drained by exactly
   one goroutine, so per-stream chunk order matches production order.
   Callbacks execute on that stream's drain goroutine: a blocking callback
   blocks its own stream only (documented consequence, not a new
   semantic). Callbacks must be safe for concurrent use across the two
   streams.
4. **Synchronized retained output.** Retained output, `truncated`, result,
   and metadata are read by the caller while drain goroutines write them;
   all access is mutex-guarded. Retained output stays bounded exactly as
   specified (16 MiB per stream, truncation marker, sticky flag).
5. **Shared execution handles.** `*Execution` is a shared handle to one
   execution; repeated `Wait()` is safe and returns immediately once
   settled (channel close is idempotent).
6. **Concurrent pipe draining.** stdout and stderr are drained
   concurrently (two goroutines plus a `sync.WaitGroup`) before waiting
   on the process. Sequential draining is a deadlock and is explicitly
   forbidden.

## 3. Engine boundary

Go owns its own OS glue: process spawn through the platform shell,
process-group/tree discovery and kill, RSS/CPU sampling when ported,
plain-filesystem VFS operations, and Docker CLI invocation for the Docker
path. Same schemas, same error codes, same statuses, same failure
semantics. No Node runtime dependency, no new sandbox semantics, and no
shelling out to the reference SDK.

## 4. Absent and unknown semantics (binding rule)

Same rule as the reference SDK and the Rust binding: optional
measurements are pointers and stay `nil`; `truncated` follows the settled
compatibility decision (optional in the schema, absent means unknown,
never false) while the SDK emits it deterministically when it produced the
result; capability unknowns stay unknown and enforcement-absent stays
absent. No silent defaulting to false or zero at any contract boundary.

## 5. Windows process and environment behavior

Carried forward from the Rust port, which found these empirically:

- The minimal environment passed to workloads must include
  `SystemRoot`, `ComSpec`, and `USERPROFILE` on Windows. Without them the
  runtime cannot load and aborts. The Windows key set mirrors the
  reference contract; the host environment is still never inherited
  wholesale.
- Process trees are killed with `taskkill /T /F` on Windows and process
  groups on POSIX.

## 6. Transient filesystem retry behavior

Windows can surface sharing violations and access-denied errors while a
just-exited child still holds a handle (or an indexer scans the
workspace). Filesystem writes, directory creation, and destroy use a
bounded retry with backoff for those transient errors. They are never
treated as contract failures and no assertion is weakened to accommodate
them.

## 7. Test strategy and release evidence

- The reference TypeScript compliance suite remains the normative
  assertion source; every assertion is ported as a Go-native test.
- Go-specific coverage: guarded cancel/complete races, callback ordering
  and blocking behavior, shared-handle observation, repeated `Wait`,
  optional-value preservation, and stable error strings.
- **`go test -race ./...` is a mandatory gate**, in CI and as release
  evidence for the Go line, not an optional extra. The race detector is an
  implementation-correctness gate for section 2; the contract stays the
  authority on behavior.
- A tiny Go consumer (create, write, exec, stream, result, destroy)
  demonstrates usability, cross-checked against the reference SDK.

## 8. Versioning and tagging

- The Go module version is an independent 0.x line.
- Git tags for the Go line use the `go-` namespace (for example
  `go-v0.1.0`) so they cannot collide with the TypeScript (`v1.x`) or
  Rust (`v0.x`) tag namespaces and cannot trigger the npm release
  pipeline.
- No version synchronization with any other SDK.

## 9. Explicit non-goals

- No crash-registry interoperability with other SDKs.
- No new capabilities, backends, or behavioral changes.
- No porting of Node-specific conveniences beyond the contract.
- No publishing to a public Go module proxy at the F2 milestone.
