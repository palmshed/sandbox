# RFC 0008: Rust SDK Binding Note (F1)

- **Status**: Accepted as the F1 implementation contract; crate released as `v0.1.0` (see `sdk/rust/`), 3-OS CI gate green, not published to crates.io.
- **Scope**: Maps the existing TypeScript sandbox contract to Rust without
  redefining it. JSON schemas stay authoritative; this note only fixes how
  TypeScript-isms surface in Rust and where the engine boundary lies.

## 1. Public Rust surface

The crate exposes exactly the contract already established by
`sdk/typescript/src/index.ts`, no more:

- `Sandbox`: create, capabilities, exec, readFile/writeFile/uploadFile/downloadFile, destroy.
- `Execution`: id, uri, status, wait, exit code, duration, timedOut, stdout/stderr/logs, stream accessors, metadata/result, cancel, lifecycle events.
- Data types: `SandboxOptions`, `ExecOptions`, `ExecResult`, `ExecutionMetadata`, `ResourceLimits`, `NetworkPolicy`, capability tri-state, `SPEC_VERSION`.
- Errors: `SandboxError` plus `SandboxResourceError` with the `ERR_CPU_EXCEEDED`, `ERR_OOM_EXCEEDED`, and `ERR_DISK_QUOTA_EXCEEDED` codes and the recoverable/details shape.
- Capability model: the same tri-state and boolean flags with the same probe-at-init semantics. No Rust-only flags.

## 2. TypeScript to Rust bindings

| TypeScript | Rust |
|---|---|
| `Buffer` returns/content | `Vec<u8>`; string convenience only where the API is text-typed |
| `Readable`/`Writable` options and `stdoutStream()` | async byte stream (single concrete stream type, documented) |
| `EventEmitter` (`stdout`/`stderr`/`exit`/`progress`/`cancelled`) | typed callbacks or channel/stream subscription (one mechanism, documented) |
| `NodeJS.Signals` | Rust signal enum covering what the backends can send |
| `async` methods | Rust `async` (one runtime documented by the crate) |
| `cancel()` | explicit async cancellation that resolves waiters, kills the tree (SIGTERM then SIGKILL cadence preserved), and is idempotent |
| `onProcessSpawned` (internal kill plumbing) | crate-internal equivalent, never public API |

## 3. Absent and unknown semantics (binding rule)

Rust must preserve the spec's absent/unknown distinctions instead of
collapsing them into defaults:

- Optional measurements (`cpuTimeMs`, `peakMemoryBytes`) are `Option<_>`; absent stays absent.
- `truncated` follows the #13 settlement: optional in the schema, absent means unknown (never false); the SDK emits it deterministically whenever it produced the result.
- Capability unknowns stay unknown; enforcement-absent stays enforcement-absent. No `unwrap_or(false)` on any contract boundary.

## 4. Engine boundary

Rust owns its own OS glue: process spawn, process-group/tree discovery and kill, RSS/CPU sampling, plain-filesystem VFS operations, and Docker CLI invocation for the Docker path. This glue implements specified behavior only: same schemas, same error codes, same statuses, same failure semantics. There is no Node runtime dependency and no new sandbox semantics. Shelling out to Node is rejected: the Rust SDK must stand alone.

## 5. Spec authority

The four JSON schemas in `spec/` are the normative contract. Rust types map to them field for field. No Rust-only semantic extensions to the protocol. If a binding question cannot be answered from the schemas plus `docs/api.md` behavior descriptions, it is escalated as a spec question rather than answered unilaterally.

## 6. Testing

- The existing TypeScript compliance suite is the normative assertion source: each assertion is ported as a Rust-native test case against the Rust SDK.
- The TCK itself is not a cross-language runner (it imports the TypeScript engine); it is not executed by Rust.
- Added Rust-specific coverage: ownership and lifetime behavior, async cancellation races, stream backpressure and drop semantics, and error-code mapping.
- Contract parity check: the same operations run through both SDKs and the observable results (statuses, codes, outputs, metadata shapes) are compared.

## 7. Explicit non-goals

- No crash-registry interoperability (the registry format is implementation detail; Rust reaps only sandboxes it created).
- No version synchronization with the TypeScript package (independent 0.x line).
- No porting of Node-specific conveniences beyond the contract.
- No new capabilities, backends, or behavioral changes. Backend expansion (Firecracker, WASI, remote) and host mounts stay in their own future units.

## 8. F1 completion gate

```text
binding note (this document)
    ↓
Rust crate + OS glue
    ↓
normative contract tests (ported assertions)
    ↓
Rust-specific async/ownership tests
    ↓
tiny real consumer (create → write → exec → stream → result → destroy)
    ↓
cross-check against TypeScript behavior
    ↓
evidence
    ↓
0.x release (independent version line)
```
