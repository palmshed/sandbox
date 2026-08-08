# Release Readiness Plan (v1.0.0)

This document plans the specification **v1.0.0** freeze. The spec is NOT frozen
yet; this is the working checklist for making the contract and packaging clean
before freezing.

## Freeze criteria (definition of done)

Frozen means: `spec/version.md` reports `1.0.0`, the JSON schemas are stable,
`release.yml` gates publish on spec/SDK version alignment, and the governance
promises below are enforceable.

- [ ] **Schema audit**: every field in `sandbox.schema.json`, `exec.schema.json`,
      `filesystem.schema.json`, and `capabilities.schema.json` is implemented,
      tested, and documented in `docs/api.md` and `docs/errors.md`.
- [ ] **Governance aligned**:
  - [ ] Deprecation policy: strict 6-month window, binding at v1.0.0
        (`spec/deprecations.md`, aligned with Phase 8 wording).
  - [ ] SemVer guarantees stated (`spec/compatibility.md`).
  - [ ] CHANGELOG complete with an `[1.0.0]` entry.
- [ ] **Packaging clean**:
  - [ ] `files` allowlist ships only `dist/`, `LICENSE`, `README.md`.
  - [ ] Consumer-facing `sdk/typescript/README.md` present.
  - [ ] Zero runtime dependencies.
  - [ ] `engines` declares supported Node.js LTS lines.
- [ ] **Runtime matrix**:
  - [ ] Node.js LTS lines (20, 22) covered in CI (`ci.yml` `node-lts` job).
  - [ ] Linux distribution / macOS compatibility matrix documented.
- [ ] **Verification gates**:
  - [ ] All examples verified against the packed release artifact in CI.
  - [ ] 3-OS CI, compliance & TCK, repro laboratory, consumer test, and
        documentation punctuation check all green.
  - [ ] `npm pack --dry-run` inspected before each release.

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
