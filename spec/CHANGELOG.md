# Specification Governance & Changelog

All notable changes to the Palmshed Sandbox Runtime Specification (`spec/`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed
- Deprecation policy (`deprecations.md`): the one-minor-version-cycle window is replaced with a strict **6-month** window, measured in calendar time from the deprecation announcement release. The 6-month window becomes a binding guarantee at specification v1.0.0; see `docs/release-readiness.md` for the freeze plan.

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
