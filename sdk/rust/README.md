# Rust SDK (`palmshed-sandbox` 0.1.0)

F1 implementation milestone: the spec contract in Rust with its own
native OS glue and no Node dependency. Binding rules:
`rfcs/0008-rust-sdk-bindings.md`.

## Scope

- `Sandbox` create/exec/filesystem/destroy, `Execution` live handle
  (status, wait, cancel, callbacks, retained output, result/metadata).
- Native backend only: spawn, concurrent pipe drain, wall-clock timeout,
  process-group/tree kill, contained VFS (traversal and symlink-escape
  rejection), minimal host env.
- `docker` and other backend names fail honestly with
  `INVALID_BACKEND`.

## Current limitations (F1 milestone, not the release)

- No resource sampling or enforcement: `cpu_time_ms` and
  `peak_memory_bytes` are always `None`; cpu/memory/disk/quota options
  are accepted but not enforced (capabilities report `false`).
- No network policies or OS filesystem confinement yet.
- No signal field in metadata.
- Linux/Windows compile but are CI-untested for Rust so far.

## Verify

```sh
cd sdk/rust && cargo test
cargo run --example eval
```
