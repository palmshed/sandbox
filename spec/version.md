# Sandbox Specification Versioning

Current Specification Version: **1.0.0**

## Versioning Rules

The Palmshed Sandbox specification follows Semantic Versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking changes to the core execution contract, mandatory fields, or standard lifecycle methods.
- **MINOR**: Backward-compatible additions (e.g., new network policies, additional resource limit fields).
- **PATCH**: Backward-compatible bug fixes or clarifications in documentation and JSON schemas.

## Specification Changelog

### v1.0.0 (Frozen runtime contract)
- Frozen the runtime contract: JSON schemas (`sandbox.schema.json`, `exec.schema.json`, `filesystem.schema.json`, `capabilities.schema.json`) are stable at v1.0.0. Subsequent changes follow SemVer and the 6-month deprecation policy (`compatibility.md`, `deprecations.md`).
- `capabilities.schema.json`: corrected the required field list (`networkIsolation`, previously mistyped as `network isolation`).
- `exec.schema.json`: `ExecResult` now includes `id` (required) and the structured `metadata` object (with `ExecutionMetadata`), matching the SDK and `spec/exec_metadata.md`.

### v0.1.2 (Filesystem boundary & environment contract)
- Added `diskQuota` to `sandbox.schema.json`: enforced on VFS writes and, during execution, across the sandbox workspace via process-group kill (`ERR_DISK_QUOTA_EXCEEDED`).
- Defined the VFS isolation boundary: `readFile`, `writeFile`, `uploadFile`, `downloadFile`, and `exec().workDir` are contained to the sandbox root. Path traversal (`..`), absolute host paths, and symlink escapes are rejected with `FS_ERROR`. Clarified in RFC 0003 and `SECURITY.md`.
- Defined the environment contract: the host environment is NOT inherited wholesale; a documented minimal allowlist (PATH, HOME, temp/locale variables) is carried, and explicit `env` values (sandbox-level and per-execution) override it.
- Clarified `workDir` semantics: contained to the sandbox root and created if absent.
- Clarified the `filesystem` capability: it means isolated virtual filesystem operations (the VFS boundary above), not host-filesystem isolation of the executing process.

### v0.1.1 (CPU resource contract addition)
- Added `cpuTimeLimit` (integer ms) to `sandbox.schema.json` and `exec.schema.json`: a supported CPU time budget enforced across the process group, distinct from wall-clock `timeout`.
- Added `cpuQuota` (number cores) to `sandbox.schema.json` and `exec.schema.json`: experimental hard core-quota boundary (cgroups v2 / Job Objects), not yet enforced by the native backend.
- Added `memory` to `exec.schema.json` `ExecOptions` (per-execution memory override already supported by the SDK).
- Added `cpuTimeMs` (best-effort CPU time reporting) to `ExecResult`.
- Clarified `cpuLimits` capability description: reflects CPU time budget enforcement; hard core quota reported separately.

### v0.1.0 (Initial Specification)
- Defined `sandbox.schema.json`, `exec.schema.json`, and `filesystem.schema.json`.
- Established backend engine lifecycle interface (`init`, `exec`, `readFile`, `writeFile`, `uploadFile`, `downloadFile`, `destroy`).
- Defined resource limits (CPU, memory, timeout) and network policy values (`disabled`, `allow`, `proxy`).
