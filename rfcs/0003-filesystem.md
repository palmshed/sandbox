# RFC 0003: Virtual Filesystem and Transfer Model

- **Author**: Palmshed Team
- **Status**: Accepted
- **Created**: 2026-08-07
- **Updated**: 2026-08-08 (filesystem isolation boundary, environment contract)

## Summary

Provide file manipulation and bidirectional host-sandbox transfer semantics independent of underlying storage mechanisms.

## Design

- `readFile(path)` & `writeFile(path, content)`: In-memory byte array operations.
- `uploadFile(localPath, sandboxPath)` & `downloadFile(sandboxPath, localPath)`: Streaming file transfer abstractions.

## Isolation Boundary (v0.1.2)

The VFS API surface (`readFile`, `writeFile`, `uploadFile`, `downloadFile`, and
`exec().workDir`) is **contained to the sandbox workspace root**. The following
are rejected with `FS_ERROR`:

1. **Path traversal**: any `..` segment that resolves outside the workspace
   root (lexical check via `path.relative`).
2. **Absolute host paths**: any path that does not resolve under the workspace
   root.
3. **Symlink escapes**: any path whose deepest existing ancestor (resolved with
   `fs.realpath`) lies outside the workspace root. A workload may create
   symlinks, but VFS operations refuse to follow a symlink that escapes the
   workspace. Symlinks that resolve inside the workspace remain usable.

`diskQuota` is enforced in two layers:

- At the **VFS API layer**: writes/transfers that would exceed the quota are
  rejected with `ERR_DISK_QUOTA_EXCEEDED` before they are performed.
- At the **process layer**: while an execution is running, workspace usage is
  polled (process-group sampling model); if usage exceeds the quota the process
  group is killed and the execution rejects with `ERR_DISK_QUOTA_EXCEEDED`.
  This closes the bypass where a workload wrote unlimited data through
  `exec()` directly (e.g. `dd`, `fallocate`).
- **Final size check & rollback**: after the process group closes, workspace
  usage is re-measured so workloads that wrote past the quota faster than the
  poll interval (250ms) are still caught. On an over-quota failure, the files
  created during that execution are rolled back, so the workspace returns under
  quota and the sandbox remains reusable (`recoverable: true`).

## Boundary Scope

`filesystem: true` means **isolated VFS operations**, not host-filesystem
isolation of the executing process. The Native backend runs workloads as the
host user with host filesystem access (soft process isolation). OS-level
filesystem isolation (chroot, mount namespaces, Seatbelt filesystem rules) is
explicitly out of scope for v1.0 and tracked as post-v1.0 hardening. See
`SECURITY.md` for the full threat model.

## Environment Contract (v0.1.2)

Executions do **not** inherit the host environment wholesale. A documented
minimal allowlist is carried from the host (PATH, HOME, temp/locale variables;
platform-appropriate on Windows). Explicit `env` values (sandbox-level and
per-execution) are injected and override the allowlist. This prevents host
secrets from leaking into untrusted workloads.
