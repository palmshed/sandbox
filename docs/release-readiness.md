# Release Readiness Plan (v1.0.0)

This document records the specification **v1.0.0** freeze. The runtime contract
is frozen as of 2026-08-09: `spec/version.md` reports `1.0.0`, the JSON schemas
are stable, `release.yml` gates publish on spec/SDK version alignment, and the
governance promises below are enforceable.

## Freeze criteria (definition of done)

Frozen means: `spec/version.md` reports `1.0.0`, the JSON schemas are stable,
`release.yml` gates publish on spec/SDK version alignment, and the governance
promises below are enforceable.

- [x] **Schema audit**: every field in `sandbox.schema.json`, `exec.schema.json`,
      `filesystem.schema.json`, and `capabilities.schema.json` is implemented,
      tested, and documented in `docs/api.md` and `docs/errors.md`.
- [x] **Governance aligned**:
  - [x] Deprecation policy: strict 6-month window, binding at v1.0.0
        (`spec/deprecations.md`, aligned with Phase 8 wording).
  - [x] SemVer guarantees stated (`spec/compatibility.md`).
  - [x] CHANGELOG complete with an `[1.0.0]` entry.
- [x] **Packaging clean**:
  - [x] `files` allowlist ships only `dist/`, `LICENSE`, `README.md`.
  - [x] Consumer-facing `sdk/typescript/README.md` present.
  - [x] Zero runtime dependencies.
  - [x] `engines` declares supported Node.js LTS lines.
- [x] **Runtime matrix**:
  - [x] Node.js LTS lines (20, 22) covered in CI (`ci.yml` `node-lts` job on ubuntu, macOS, and Windows).
  - [x] Linux distribution / macOS compatibility matrix documented (see below).
- [x] **Verification gates**:
  - [x] All examples verified against the packed release artifact in CI
        (`examples.yml` packs and installs the tarball, then runs all four
        examples; see `examples/README.md`).
  - [x] 3-OS CI, compliance & TCK, repro laboratory, consumer test, and
        documentation punctuation check all green.
  - [x] `npm pack --dry-run` inspected before each release.

## Runtime & platform compatibility matrix (verified)

The matrix records only what CI actually verifies today, using the GitHub
Actions `-latest` labels as of 2026-08. These are rolling labels, so the
underlying OS versions move over time (for example, `macos-latest` is an ARM64
image currently transitioning from macOS 15 to macOS 26). The release workflow
pins `ubuntu-24.04`; the daily CI matrix intentionally tracks the `-latest`
labels.

| Platform (runner label) | Arch | Node.js LTS | Network isolation | CPU / memory limits | CI coverage |
|-------------------------|------|-------------|-------------------|---------------------|-------------|
| Ubuntu 24.04 (`ubuntu-latest`) | x64 | 20 and 22 | Supported when `unshare --user --map-root-user` is available; `false` on restricted runners (proxy-env fallback) | Supported (process-group sampling) | `ci.yml` (build-and-test + `node-lts`), `compliance.yml`, `examples.yml` |
| macOS (`macos-latest`, ARM64) | arm64 | 20 and 22 | Supported (`sandbox-exec`, deprecated by Apple; RFC 0004) | Supported (process-group sampling) | `ci.yml` (build-and-test + `node-lts`), `compliance.yml`, `examples.yml` |
| Windows Server 2025 (`windows-latest`) | x64 | 20 and 22 | Unsupported (RFC 0004) | Best-effort (PowerShell CIM process-tree polling) | `ci.yml` (build-and-test + `node-lts`), `compliance.yml`, `examples.yml` |

Claimable guarantees at v1.0.0:

- Node.js 20 and 22 are verified on Ubuntu 24.04 x64, macOS ARM64, and Windows
  Server 2025 via the `ci.yml` `node-lts` job (Node 20 also runs the full
  build-and-test, compliance, examples, and repro gates on all three OSes).
- Windows CPU/memory enforcement is best-effort (a detached child can escape
  accounting); Linux/macOS cover pipelines, background jobs, and chained
  `sh -c` children. The hard core quota (`cpuQuota`) remains experimental and
  unenforced.
- Linux network isolation is probed at `init()`: it holds when unprivileged
  user namespaces are available, and CI runners where the probe fails run with
  proxy-env fallback while the network tests skip.

## Freeze mechanics (when triggered)

1. Resolve open items above; record the audit result in the living gist.
2. Bump `spec/version.md` to `1.0.0` and add the `[1.0.0]` CHANGELOG entry.
3. Tag `v1.0.0` (SDK version must equal the tag; spec major.minor must equal the
   SDK major.minor, enforced by `release.yml`).
4. Publish `@palmshed/sandbox` with `npm tag latest` (non-prerelease path in
   `release.yml`).
5. Post-freeze changes follow the 6-month deprecation policy for removals and
   require a minor/major bump per `spec/compatibility.md`.

## Explicitly deferred past v1.0.0

- OS-level filesystem isolation for the native backend (chroot / mount
  namespaces / Seatbelt filesystem rules); `filesystem: true` means isolated
  VFS operations, not host-filesystem isolation of the executing process.
- Windows network isolation and Docker CPU/memory/network parity (work item
  `#4`); the Docker backend reports those capabilities as `false`.
- Hard CPU core quota (`cpuQuota`); CPU time budget (`cpuTimeLimit`) is the
  verified v1.0 guarantee.
- Rust, Go, and Python SDKs.
- Phase 7 observability extras (peak resource reporting, fine-grained timing,
  benchmark baselines) if not complete at freeze time.
