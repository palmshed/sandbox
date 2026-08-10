# Security Policy & Threat Model

## Threat Model & Security Boundaries

Palmshed Sandbox (`palmshed/sandbox`) isolates untrusted process execution. Security isolation depends on the active execution backend:

- **Native Backend**: Soft process isolation using OS temporary directory boundary & environment controls.
- **Docker Backend**: Containerized execution driver (wires `docker run/exec/cp/stop`). Resource enforcement and network isolation are NOT yet implemented or integration-tested; the backend reports `cpuLimits`, `memoryLimits`, and `networkIsolation` as `false` (work item `#4`). Do not rely on Docker for CPU/memory/network boundaries today.
- **Firecracker / WASI (Future)**: MicroVM and WebAssembly capability sandboxing.

## Filesystem Isolation Boundary

The virtual filesystem API (`readFile`, `writeFile`, `uploadFile`, `downloadFile`,
and `exec().workDir`) is contained to the sandbox workspace root. Path
traversal (`..`), absolute host paths, and symlink escapes are rejected with
`FS_ERROR`: a workload-planted symlink cannot redirect VFS operations to host
files. `filesystem: true` means **isolated VFS operations**, not OS-level
filesystem isolation of the executing process; the Native backend runs workloads
as the host user. See `rfcs/0003-filesystem.md`.

## OS-Level Filesystem Isolation (RFC 0006)

The Native backend can additionally confine the executed process tree to the
sandbox workspace plus a minimal read-only runtime allowlist (interpreter,
shared libraries, loader, config, zoneinfo), denying everything else at the
kernel level. This is reported as the `osFilesystemIsolation` capability
(`'supported'` | `'unsupported'` | `'unknown'`):

- **Linux**: enforced via a Landlock ruleset applied by a confinement runner
  launched behind `unshare --user --map-root-user` (unprivileged user
  namespaces supply the `CAP_SYS_ADMIN` Landlock requires). The mechanism is
  probed at `init()` with a real confined self-test before the capability
  reports `supported`. Only `supported` must be treated as an enforced
  boundary; `unknown`/`unsupported` mean ambient host rights.
- **macOS**: `unknown` (Seatbelt filesystem profile is deferred as a post-v1.0 follow-up, not promised; `supported` only after the escape suite passes there).
- **Windows / other**: `unsupported` (AppContainer per-path filesystem grants require package identity; restricted tokens cannot deny reads of world-readable files, so the RFC 0006 read-denial guarantee is not met; rationale in RFC 0006).

Adversarial escapes E1-E10 and the threat model are defined in
`rfcs/0006-os-filesystem-isolation.md`; the escape suite lives in
`sdk/typescript/src/test/osfilesystem.test.ts` and the production scenario
`production/scenarios/os-filesystem-isolation.mjs`. The workload cannot opt
out per-execution; a sandbox may opt out explicitly with
`Sandbox.create({ osFilesystemIsolation: false })`.

**Declared residuals**: Landlock is path-based and does not hide `/proc` or
`/sys`; reads of those trees may remain visible to the host user. The runtime
allowlist intentionally excludes the NSS/DNS system files (`/etc/passwd`,
`/etc/group`, `/etc/hosts`, `/etc/resolv.conf`, `/etc/nsswitch.conf`), so name
lookups that read them (`os.userInfo()`, hostname resolution) fail with
`EACCES` under confinement; this is a documented degradation, not an escape.
OS-level isolation is not a defense against kernel exploits or privileged
device-node attacks.

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
