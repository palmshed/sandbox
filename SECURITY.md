# Security Policy & Threat Model

## Threat Model & Security Boundaries

Palmshed Sandbox (`palmshed/sandbox`) isolates untrusted process execution. Security isolation depends on the active execution backend:

- **Native Backend**: Soft process isolation using OS temporary directory boundary & environment controls.
- **Docker Backend**: Containerized execution driver (wires `docker run/exec/cp/stop`). Resource enforcement and network isolation are NOT yet implemented or integration-tested — the backend reports `cpuLimits`, `memoryLimits`, and `networkIsolation` as `false` (work item `#4`). Do not rely on Docker for CPU/memory/network boundaries today.
- **Firecracker / WASI (Future)**: MicroVM and WebAssembly capability sandboxing.

## Filesystem Isolation Boundary

The virtual filesystem API (`readFile`, `writeFile`, `uploadFile`, `downloadFile`,
and `exec().workDir`) is contained to the sandbox workspace root. Path
traversal (`..`), absolute host paths, and symlink escapes are rejected with
`FS_ERROR` — a workload-planted symlink cannot redirect VFS operations to host
files. `filesystem: true` means **isolated VFS operations**, not OS-level
filesystem isolation of the executing process; the Native backend runs workloads
as the host user. OS-level isolation (chroot, mount namespaces, Seatbelt
filesystem rules) is post-v1.0 hardening. See `rfcs/0003-filesystem.md`.

## Environment Contract

Executions do **not** inherit the host environment wholesale. Only a documented
minimal allowlist (PATH, HOME, temp/locale variables; platform-appropriate on
Windows) is carried from the host; explicit `env` values (sandbox-level and
per-execution) override it. This prevents host secrets from leaking into
untrusted workloads.

## Reporting a Vulnerability

If you discover a security vulnerability within `palmshed/sandbox`, please do NOT open a public GitHub issue. Send a report to **security@palmshed.io** including:

1. Description of the vulnerability.
2. Steps to reproduce or proof-of-concept script.
3. Affected backends or SDK versions.
