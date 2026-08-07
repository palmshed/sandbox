# Specification Governance & Changelog

All notable changes to the Palmshed Sandbox Runtime Specification (`spec/`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
