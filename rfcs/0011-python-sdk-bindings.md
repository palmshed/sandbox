# RFC 0011: Python SDK Binding Note (F3)

- **Status**: Accepted as the F3 audit output. No code yet.
- **Scope**: Maps the existing sandbox contract to Python without
  redefining it. JSON schemas stay authoritative; this note fixes how
  TypeScript-isms surface in Python, which concurrency model the SDK
  uses, and what counts as release evidence.
- **Rule for the sequence**: each language gets its own binding note and
  native concurrency/error model, while the Sandbox contract stays
  singular. F1 (Rust) and F2 (Go) set the precedent this note follows.

## 1. Public API mapping

Same contract as the reference SDK: `Sandbox` (create, capabilities,
exec, filesystem operations, destroy), `Execution` (id, uri, status,
wait, exit code, duration, timedOut, stdout/stderr/logs, stream access,
metadata/result, cancel, output events), the data types, capability
tri-state, `SPEC_VERSION`, and the error-code family (`EXEC_FAILED`,
`FS_ERROR`, `INVALID_BACKEND`, `ERR_CPU_EXCEEDED`, `ERR_OOM_EXCEEDED`,
`ERR_DISK_QUOTA_EXCEEDED`).

| TypeScript | Python |
|---|---|
| `Buffer` | `bytes` (text helpers only where the API is text-typed) |
| `Readable` stream | async iterator (`async for chunk in ...`) as the primary stream shape |
| `EventEmitter` | `on_stdout`/`on_stderr` callbacks plus the async iterator; one subscription model documented, not two competing ones |
| `wait()` promise | `await ex.wait()` (asyncio) |
| `Option<T>` / absent | `Optional[X]`; `None` is absent and means unknown, never false or zero |
| `NodeJS.Signals` | `signal.Signals` from the standard library |
| `async` methods | `asyncio` throughout (async-first SDK, see section 2) |
| ISO-8601 timestamps | `datetime` formatted as `2006-01-02T15:04:05.000Z` shape (`timespec='milliseconds'`), matching the reference exactly |

## 2. Sync versus async decision: async-first

The stated consumer for this SDK is AI agent frameworks, which are
overwhelmingly `asyncio`-based. The SDK is therefore async-first: every
lifecycle and IO method is a coroutine, cancellation composes with
`asyncio` task cancellation, and streaming is an async iterator. No
synchronous twin API at the F3 milestone; a sync wrapper is a later,
separate decision if a concrete consumer requires it, not a day-one
surface doubling.

## 3. Concurrency and cancellation semantics

1. **Guarded terminal state.** Same rule as RFC 0009 section 2.1: the
   first terminal state observed by the guard wins, and `cancelled` is
   terminal and stable. The reference SDK's post-cancel overwrite
   (discrepancy 001) is not reproduced.
2. **Cancel cadence.** SIGTERM to the process group, then SIGKILL after
   1s, idempotent. Caller `asyncio` cancellation wires into the same
   guarded state machine; it never bypasses it.
3. **Callback and iterator ordering.** Each stream is drained by exactly
   one task, so per-stream chunk order matches production order. The
   async iterator and the callbacks observe the same ordered chunks; a
   blocking callback blocks only its own stream (documented consequence).
4. **Synchronized retained output.** Retained output, `truncated`,
   result, and metadata are read by the caller while drain tasks write
   them; all access is lock-guarded (`asyncio.Lock` or a plain lock held
   only over non-awaiting sections). Retained output stays bounded
   exactly as specified (16 MiB per stream, truncation marker, sticky
   flag).
5. **Shared execution handles.** One `Execution` object may be awaited
   from multiple tasks; repeated `wait()` returns immediately once
   settled.
6. **Concurrent pipe draining.** stdout and stderr drain concurrently
   before the process is waited on. Sequential draining is a deadlock
   and is explicitly forbidden (both prior SDK ports found a variant of
   this independently).

## 4. Engine boundary

Python owns its own OS glue: process spawn through the platform shell
(`asyncio.create_subprocess_exec`), process-group/tree discovery and
kill (`os.killpg` on POSIX, `taskkill /T /F` on Windows), plain
pathlib-based VFS operations, and Docker CLI invocation for the Docker
path when that phase arrives. Same schemas, same error codes, same
statuses, same failure semantics. No Node runtime dependency, no new
sandbox semantics, and no shelling out to the reference SDK.

## 5. Absent and unknown semantics (binding rule)

Same rule as both prior ports: optional measurements are `Optional`
and stay `None`; `truncated` follows the settled compatibility decision
(optional in the schema, absent means unknown, never false) while the
SDK emits it deterministically when it produced the result; capability
unknowns stay unknown and enforcement-absent stays absent. No silent
defaulting at any contract boundary.

## 6. Windows process and environment behavior

Carried forward from the F1/F2 ports, which found these empirically
rather than by reading documentation:

- The minimal environment passed to workloads must include
  `SystemRoot`, `ComSpec`, and `USERPROFILE` on Windows. The host
  environment is still never inherited wholesale.
- Process trees are killed with `taskkill /T /F` on Windows and process
  groups on POSIX.
- Filesystem writes, directory creation, and destroy use bounded retry
  with backoff for transient sharing violations and access-denied
  errors. They are never treated as contract failures.

## 7. Supported versions and packaging

- Minimum supported Python is **3.11**: `asyncio.timeout` semantics,
  `TaskGroup` availability for future use, and `tomllib` all baseline
  there, and 3.10 leaves security support imminently. CI covers the
  supported 3.x lines available on the runners at implementation time.
- Runtime dependencies: none (standard library only:
  `asyncio`/`subprocess`/`pathlib`). Test dependencies (`pytest`,
  `pytest-asyncio`) are dev-only and never ship.
- Package name `palmshed-sandbox`, importable as `palmshed_sandbox`,
  built from `pyproject.toml` under `sdk/python/`.

## 8. Test strategy and release evidence

- The reference TypeScript compliance suite remains the normative
  assertion source; every assertion is ported as a Python-native test.
- Python-specific coverage: event-loop behavior, async-iterator
  ordering, guarded cancel/complete races, shared-handle observation,
  repeated `wait`, optional-value preservation, and stable error strings.
- A tiny Python consumer (create, write, exec, stream, result, destroy)
  demonstrates usability, cross-checked against the reference SDK.
- CI runs the suite on all three OSes; the `-race` role from F2 has no
  direct equivalent, so ordering and race coverage come from
  deterministic tests plus `asyncio` debug-mode runs where useful.

## 9. Versioning and tagging

- The Python module version is an independent 0.x line.
- Git tags for the Python line use the `py-` namespace (for example
  `py-v0.1.0`), following the established `v0.x` (Rust) and `go-v0.x`
  pattern, so no language line can collide or trigger the npm release
  pipeline (scoped to `v[1-9]*`).
- No version synchronization with any other SDK. No publishing to PyPI
  at the F3 milestone.

## 10. Explicit non-goals

- No crash-registry interoperability with other SDKs.
- No new capabilities, backends, or behavioral changes.
- No porting of Node-specific conveniences beyond the contract.
- No synchronous twin API at the milestone.
- No PyPI publishing at the F3 milestone.
