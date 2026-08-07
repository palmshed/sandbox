# Sandbox Specification Versioning

Current Specification Version: **0.1.1**

## Versioning Rules

The Palmshed Sandbox specification follows Semantic Versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking changes to the core execution contract, mandatory fields, or standard lifecycle methods.
- **MINOR**: Backward-compatible additions (e.g., new network policies, additional resource limit fields).
- **PATCH**: Backward-compatible bug fixes or clarifications in documentation and JSON schemas.

## Specification Changelog

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
