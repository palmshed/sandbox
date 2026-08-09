# Specification Governance & Changelog

All notable changes to the Palmshed Sandbox Runtime Specification (`spec/`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## Unreleased

### Added (optional extension, no version bump)

- `osFilesystemIsolation` capability in `capabilities.schema.json` (RFC 0006): a tri-state string (`supported` | `unsupported` | `unknown`) reporting whether the executed process tree is confined to the sandbox workspace plus a minimal read-only runtime allowlist. It is an **optional capability extension** to the frozen 1.0.0 contract: its presence does not change the 1.0.0 contract or require a version bump (`spec/version.md`). The capability is reported, never assumed; backends that cannot provide OS-level filesystem isolation report `unsupported` or `unknown`.
- `osFilesystemIsolation` boolean option in `sandbox.schema.json`: opt-out gate (defaults to true when the mechanism is supported) for applying OS-level filesystem isolation.

---

## [1.0.0] - 2026-08-09

### Changed
- Frozen the runtime contract. JSON schemas are stable at v1.0.0; subsequent changes follow SemVer (`compatibility.md`) and the 6-month deprecation policy (`deprecations.md`).
- Deprecation policy (`deprecations.md`): the one-minor-version-cycle window is replaced with a strict **6-month** window, measured in calendar time from the deprecation announcement release. The 6-month window becomes a binding guarantee at specification v1.0.0.

### Fixed
- `capabilities.schema.json`: required field list referenced `network isolation` (with a space); corrected to `networkIsolation`.
- `exec.schema.json`: `ExecResult` now documents `id` (required) and the structured `metadata` object, matching the SDK and `spec/exec_metadata.md` (`additionalProperties: false` previously forbade the SDK's actual result shape).

---

## [0.1.2] - 2026-08-08

### Added
- `diskQuota` field in `sandbox.schema.json` (schema already supported by the SDK).
- Formalized the VFS isolation boundary in RFC 0003 and `SECURITY.md`: `readFile`, `writeFile`, `uploadFile`, `downloadFile`, and `exec().workDir` are contained to the sandbox root; path traversal, absolute host paths, and symlink escapes are rejected with `FS_ERROR`.
- Formalized the environment contract: a minimal allowlist of host variables (PATH, HOME, temp/locale) is inherited; explicit `env` values override it; the host environment is otherwise not inherited.

### Changed
- `env` semantics: host environment variables are no longer passed to executions wholesale (previously `...process.env`). This closes host-secret leakage to untrusted workloads.
- `workDir` semantics: contained to the sandbox root and created if absent (previously resolvable to arbitrary host paths).
- `filesystem` capability clarified: isolated VFS operations, not host-filesystem isolation of the executing process. The Native backend runs workloads as the host user.

### Fixed
- `writeFile`/`uploadFile`/`downloadFile`/`readFile` now reject symlink escapes (a workload-planted symlink could previously redirect VFS reads/writes/transfers outside the sandbox root).
- Disk quota is now enforced during execution via workspace-size polling with process-group kill (`ERR_DISK_QUOTA_EXCEEDED`), closing the exec-write bypass where workloads could write unlimited data despite `diskQuota`.

---

## [0.1.1] - 2026-08-08

### Added
- CPU resource contract: `cpuTimeLimit` (supported CPU time budget, ms) and `cpuQuota` (experimental core quota) in `sandbox.schema.json` and `exec.schema.json`.
- Per-execution `memory` override in `exec.schema.json` `ExecOptions`.
- Best-effort `cpuTimeMs` CPU usage reporting on `ExecResult`.
- Clarified `cpuLimits` capability semantics in `capabilities.schema.json`.

---

## [0.1.0] - 2026-08-07

### Added
- Core JSON schemas for sandbox options (`sandbox.schema.json`), execution parameters/results (`exec.schema.json`), filesystem transfers (`filesystem.schema.json`), and capability negotiation (`capabilities.schema.json`).
- Specification versioning contract (`version.md`).
- Core RFCs 0001, 0002, and 0003.
- Specification governance documents (`compatibility.md`, `deprecations.md`).
- Technology Compatibility Kit (`tck/`) for certifying external SDKs and backends.
