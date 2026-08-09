# Palmshed Sandbox Roadmap

> **Vision**: Transform `palmshed/sandbox` from working code into a reliable runtime and trusted infrastructure for AI agent platforms, code evaluation systems, and CI runners.

---

## Source of Truth Hierarchy

To prevent documentation drift across the repository:

> - **[`ROADMAP.md`](file:///Users/bniladridas/Desktop/sandbox/ROADMAP.md)** describes direction, milestones, and architectural progression.
> - **The Gist** records current validation state, verified capabilities, and benchmark profiles. (Living engineering log: https://gist.github.com/bniladridas/e2a499783be6d2b9de4dd7cf4f34ee7d)
> - **Tests (`compliance/`, `tck/`, `sdk/typescript/src/test/`)** define what is actually guaranteed.

---

## Target State

> *"An engineer should be able to discover `palmshed/sandbox`, understand its guarantees, install it, run an example, and integrate it into an AI agent or CI workflow without needing a personal explanation."*

---

## Guarantee Levels

- **Supported**: The sandbox enforces and tests this boundary. Verified via integration test suite and CI.
- **Experimental**: Implemented but still under active validation or hardware/OS capability testing.
- **Unsupported**: The API schema or capability negotiation may acknowledge the concept, but no enforcement guarantee currently exists.

---

## Early Threat Model Definition (Phase 2 Requirement)

Before marking security and resource enforcement capabilities complete, the project maintains an explicit threat model:

- **What the sandbox protects against**: CPU hogging/infinite loops, memory exhaustion (OOM), unhandled child process leaks, disk space flooding, unauthorized network access (when network isolation is enabled).
- **What it does not protect against (Native backend)**: Kernel vulnerabilities / kernel exploits without isolation backends (Docker/Firecracker), hardware side-channel attacks (e.g. Spectre/Meltdown).
- **Host Assumptions**: Host OS kernel is secure, running with appropriate permissions (e.g., cgroups v2 / namespaces configured where applicable).
- **Supported Isolation Boundaries**: Clearly documented per backend (`native` vs `docker` vs `firecracker`).

---

## Phase 1 - External Consumer Foundation (Completed / Continuous)

> **Goal**: Anyone can install and run `palmshed/sandbox` without knowing the internals.

- [x] Runtime specification v0.1.0 (`spec/`)
- [x] TypeScript reference SDK (`sdk/typescript`)
- [x] Basic execution & real-time stdout/stderr streaming
- [x] Virtual filesystem operations & initial TCK/compliance suite
- [x] Maintain `examples/consumer-test` as a permanent downstream consumer verification project
- [x] Verify npm package installation directly from tarball (`.tgz`) and npm registry (`examples/consumer-test/run.sh` + `registry-install` CI job)
- [x] Comprehensive usage documentation (creation, command execution, filesystem, streaming, destruction)
- [x] Document version compatibility rules and keep examples updated with every API change (`examples.yml` freshness CI runs all four examples against the packed artifact; `spec/compatibility.md` + `deprecations.md`)

**Success Criteria**: A new engineer can clone the repo and run a sandbox example in minutes.

---

## Phase 2 - Runtime Trust & Boundary Enforcement (Completed)

> **Goal**: Turn capability flags into verified runtime guarantees ("This sandbox enforces the boundaries it documents").
> **Rule**: Capabilities change from `false` → `true` only when backed by integration tests.
> **Status**: All items below are implemented, locally verified, and CI-verified across the Ubuntu/macOS/Windows matrix (36/36 SDK tests, 31/31 conformance/TCK, 15/15 repros on macOS; Windows network/POSIX repros auto-skip where the capability is unavailable). Closeout audit completed 2026-08-08. The `cpuQuota` and Docker-network scope decisions (2026-08-08) were resolved by explicit classification rather than implementation; Docker's unverified capability flags were demoted to `false` in the same session (see §3).

### 1. Process Lifecycle & Signal Handling (#2) [COMPLETED]
- [x] POSIX process tree discovery (group PIDs & sub-shell descendants)
- [x] Windows process tree termination (`taskkill /F /T` equivalent)
- [x] Orphan process detection integration test suite
- [x] `destroy()` during active streaming/background process execution
- [x] Timeout cleanup regression test suite across platforms

### 2. Resource Enforcement (#7)
- [x] Native CPU time limit enforcement (process-group sampling, `ERR_CPU_EXCEEDED`; commit `240f2a5`)
- [x] Native memory limit enforcement (process-group RSS polling, `ERR_OOM_EXCEEDED`; commits `bf5cc32` + `91debc8`)
- [x] Virtual filesystem disk quota enforcement (`ERR_DISK_QUOTA_EXCEEDED`; commit `85f477a`)
- [x] Structured failure states and error types (`ERR_OOM_EXCEEDED`, `ERR_DISK_QUOTA_EXCEEDED`, `ERR_CPU_EXCEEDED`)
- [x] Backend capability contract unit and integration tests: `memoryLimits: true` and `cpuLimits: true` verified via 36/36 SDK + 31/31 conformance/TCK tests
- [x] Recursive process-tree cleanup after resource-limit kills (commit `2ee1f24`)
- [x] **Scope decision (2026-08-08):** `cpuQuota` (hard core quota, cgroups v2 / Job Objects) is classified **experimental / out-of-scope** for the current Native capability contract. CPU **time** budget (`cpuTimeLimit` → `ERR_CPU_EXCEEDED`) is the verified Phase 2 guarantee. Core quota is a different semantic (hardware core pinning vs. time accounting) and must not be conflated with `cpuLimits`. It remains schema-acknowledged (`cpuQuota` in `sandbox.schema.json`/`exec.schema.json`) but is NOT enforced by the Native backend and will be revisited as its own design item (not part of the Phase 2 closeout).

### 3. Network Isolation (Completed)
- [x] Security threat model document (RFC 0004 threat model defined; 8 guarantees verified)
- [x] Native backend isolation design decision (`rfcs/0004-network-isolation.md`)
- [x] Native backend `network: 'disabled'` implementation:
  - Linux: `unshare -n --user --map-root-user` network namespace isolation, with init-time probe and proxy-env fallback when user namespaces are unavailable (commit `9b9c3f1`, fixed `f590557`)
  - macOS: `sandbox-exec` with Seatbelt profile (commit `9b9c3f1`, deprecation risk documented)
  - Windows: Unsupported (documented in platform matrix)
- [x] Adversarial network leak test suite (5/5 PASS):
  - TCP outbound blocking (commit `9b9c3f1`)
  - UDP outbound blocking (commit `780f385`)
  - DNS resolution blocking (commit `9b9c3f1`)
  - Localhost service access blocking (commit `9b9c3f1`)
  - Child process isolation inheritance (commit `780f385`)
- [x] **Scope decision (2026-08-08):** the Docker backend `--network none` leak-check suite is **explicitly out of scope for Phase 2**. Phase 2's network guarantee is scoped to the **Native backend** (`unshare`/`sandbox-exec`). Docker-backend network isolation is tracked as a separate backend-parity work item (`#4`) outside the Phase 2 closeout.
- [x] **Scope decision (2026-08-08):** the Docker backend's unverified capability flags are **demoted to `false`**. `docker.ts` reported `cpuLimits: true`, `memoryLimits: true`, and `networkIsolation: true` without implementation or integration-test coverage, violating the capability-promotion rule. They now report `false` (Docker keeps `filesystem: true` and `streaming: true`), enforced by an explicit capability-matrix compliance test (`compliance/backends/docker.test.js`). Docker CPU/memory enforcement and network isolation are future work (`#4`) and must land implementation **and** integration tests before their flags return to `true`.

### Acceptance Criteria for Capability Promotion (`false` → `true`)
- Implementation exists in the native backend engine
- Public API behavior and boundary contracts are fully documented
- Clear failure modes and error types are defined for limit breaches
- **Negative Boundary Test Requirement**: Every capability MUST have a negative test proving explicit, controlled failure and sandbox health when the boundary is breached (e.g., exceeding memory triggers `ERR_OOM_EXCEEDED` while leaving the sandbox engine healthy and reusable).
- Integration tests cover both standard and adversarial cases (fork bombs, memory leaks, unkilled child processes)
- CI suite verifies behavior consistently across target platforms
- Documentation & Gist updated with verified guarantee levels

### Reproducible Guarantee Laboratory (`repro/`)
Every guarantee and every reported bug gets a standalone repro (`repro/<area>/*.js`) that prints expected behavior and exits non-zero when the guarantee is violated. Workflow: repro → confirm it fails → automated test → fix → keep the regression test. Run with `node repro/run.js` (network repros auto-skip when `networkIsolation` is unavailable; add `--all-network` to force them). New capability work should land a matching repro in the same change.

---

## Phase 3 - Real-World Usage Examples

> **Goal**: Prove the sandbox solves actual production problems cleanly.

- [x] **AI Agent Runner (`examples/ai-agent-runner.mjs`)**
  - Workflow: `User Request → Agent → Sandbox → Execute Code → Return Output`
  - Validates: Node.js code execution, sandbox isolation (network disabled), timeout handling, stdout/stderr streaming
- [x] **Code Evaluation System (`examples/code-evaluator.mjs`)**
  - Workflow: `Submission → Sandbox → Run Tests → Collect Results`
  - Validates: Multi-test execution, failed programs, infinite loops, timeout enforcement
- [x] **Build / Test Environment (`examples/ci-runner.mjs`)**
  - Workflow: `Repository → Sandbox FS → npm test → Logs + Artifacts`
  - Validates: Workspace mounting (uploadFile), build + test execution, artifact extraction (readFile/downloadFile), failure and timeout handling, sandbox reuse after failed/timed-out workloads
  - All four examples run in CI via `examples.yml`, which installs the packed `@palmshed/sandbox` tarball (never the workspace build) and runs them on Ubuntu, macOS, and Windows

---

## Phase 4 - Security & Isolation Hardening (Completed for v1.0 scope)

> **Goal**: Make untrusted execution verifiably safe against adversarial workloads.

> **Status**: Complete for the **v1.0 scope** (2026-08-08). The v1.0 guarantee is *soft process isolation with a hardened virtual filesystem boundary*; host-filesystem isolation is explicitly **not** part of the v1.0 guarantee. The residual hardening items are deferred **post-v1.0** (RFC 0003, `SECURITY.md`):
> - **OS-level filesystem isolation** for the Native backend (chroot / mount namespaces / Seatbelt FS rules): post-v1.0 (issue `#3`)
> - **Windows network isolation**: unsupported (RFC 0004; no unprivileged mechanism)
> - **Docker resource/network enforcement**: deferred, capability flags remain `false` (issue `#4`)
> - **Hard `cpuQuota`**: experimental, not enforced by the Native backend (kept for future hard-quota design)

- [x] **CPU Hardening**: Infinite loops, runaway processes, strict timeout enforcement (CPU time budget enforced; hard core quota deferred post-v1.0)
- [x] **Memory Hardening**: Large allocations, OOM handling, cleanup after process kill
- [x] **Filesystem Hardening**: VFS boundary v0.1.2 (traversal / absolute-path / symlink-escape rejection, `workDir` containment, exec-path disk quota with rollback); OS-level isolation deferred post-v1.0
- [x] **Process Hardening**: Recursive child process cleanup, signal handling, forced termination

**Success Criteria**: A malicious or broken workload cannot escape or degrade the host environment (within the documented v1.0 boundary).

---

## Phase 5 - Developer Experience & Ergonomics

> **Goal**: Make integration intuitive and self-documenting.

- [x] TypeScript API documentation and automated reference doc generation (`docs/api.md` + Typedoc from `sdk/typescript/src/index.ts` via `npm run docs`; `docs.yml` fails CI if generation breaks)
- [x] Practical recipes and common integration pattern examples
- [x] Actionable error messages detailing root cause and recovery steps (`docs/errors.md`: error code, meaning, cause, recovery, sandbox-reuse expectation)
- [x] Built-in debug logging mode (`SANDBOX_LOG=debug`, off by default; lifecycle/resource events to stderr, consistent across native and Docker backends, never secrets/command/filesystem content)
- [x] Ergonomic API refinements for `sandbox.exec()`, `sandbox.writeFile()`, `sandbox.readFile()`, and `sandbox.destroy()`

---

## Phase 6 - Reliability Testing & Multi-Platform CI (Complete)

> **Goal**: Guarantee stability for high-throughput, long-running systems.
> **Status**: Complete (2026-08-09). Crash recovery (`#10`) closed the phase; see RFC 0005.

- [x] **Concurrency Testing**: 10 concurrent sandboxes + 8 parallel executions in a single sandbox (stress suite, `sdk/typescript/src/test/stress.test.ts`)
- [x] **Lifecycle Stress Testing**: 50 rapid create → destroy cycles and destroy-while-in-flight (`stress.test.ts`); separate crash/destroy coverage in lifecycle test suite
- [x] **Crash Recovery** (#10): Graceful cleanup upon host process crash or unexpected backend disconnection; RFC 0005 defines the failure model, guarantees (G1-G8), and reaper design. Implemented via in-process signal/exit hooks (graceful) plus a shared registry + stale-sandbox reaper that runs at sandbox creation (post-mortem, PID-reuse safe via host start-time token). Covered by 6 integration tests (`crash.test.ts`) and 3 repros (`repro/crash/`); platform matrix and limitations documented in RFC 0005 and `docs/api.md`
- [x] **Longer Concurrent Execution Testing**: sustained concurrent workload test (10 sandboxes × 3 staggered rounds interleaving healthy executions, CPU-budget kills, reuse probes, and concurrent destroy). The `d760757` Windows flake **reproduced** on `a136c7a` (a single `echo` exceeded the 10s timeout while the other test file's PowerShell CIM samplers saturated the 2-vCPU runner) and was **fixed** rather than masked: `node --test --test-concurrency=1` serializes the SDK test files so each test's internal concurrency is preserved without cross-file CPU starvation (3 consecutive green Windows runs on `8d9f40e`)
- [x] **Multi-Platform CI Matrix**: Automated CI verification on Ubuntu, macOS, and Windows (`ci.yml` + `compliance.yml` matrices, commit `ebd32be`)
- [x] **Reproducible Guarantee Lab in CI**: `node repro/run.js` runs in the CI matrix with capability-aware network skip

---

## Phase 7 - Observability & Benchmark Baselines

> **Goal**: Enable operators to inspect runtime behavior and rely on predictable performance.

- [ ] **Observability**: Assign unique `execution_id`, fine-grained timing metrics, peak resource reporting
- [ ] **Benchmark Expectations (Target Baselines)**:
  - Cold startup latency ($<50\text{ms}$ native)
  - Execution overhead ($<5\%$)
  - Concurrent sandbox capacity ($100+$ parallel instances without degradation)
  - Memory overhead per sandbox ($<10\text{MB}$ host overhead)

---

## Phase 8 - Release Readiness & Migration Policy (1.0.0)

> **Goal**: Ready for widespread external production adoption.
> **Plan**: The freeze criteria and mechanics are tracked in `docs/release-readiness.md`. The spec is frozen at 1.0.0 as of 2026-08-09.

- [x] Stable, frozen public API schema (`spec/v1.0.0`)
- [x] Semantic versioning guarantees and complete CHANGELOG
- [ ] **Migration & Compatibility Policy**:
  - [x] Strict 6-month deprecation window for non-breaking schema field transitions (written into `spec/deprecations.md`; binding at v1.0.0)
  - [x] Explicit supported Node.js runtime matrix (LTS versions: `engines >=20` in `sdk/typescript/package.json`; `ci.yml` `node-lts` job verifies Node 20 + 22 on Ubuntu, macOS, and Windows)
  - [x] Native backend driver compatibility matrix across Linux distributions / macOS (documented in `docs/release-readiness.md` with per-platform verified/best-effort status)
- [x] All examples verified against release tarball in CI (`examples.yml` packs the SDK, installs the tarball into the repo-root `node_modules`, then runs all four examples on Ubuntu, macOS, and Windows)
- [x] Package published to npm registry with zero-dependency core engine (`@palmshed/sandbox@1.0.0` published as `latest`; `files` allowlist ships `dist/` + `LICENSE` + `README.md`, `sdk/typescript/README.md` added, `engines` declared)

---

## Phase 9 - Production Validation Suite (Complete)

> **Goal**: Release confidence comes from an adversarial, packed-artifact
> gate, not only from unit and integration suites.
> **Status**: Complete (2026-08-09). `production/` ships a scenario runner,
> residue detection, seven consumer-workflow scenarios, and a soak driver; CI
> wires it against the packed npm tarball on the 3-OS matrix (`production.yml`)
> with nightly soak and an exact-version gate (`scheduled-tests.yml`).
> **Validation recorded 2026-08-09**: Production Validation 7/7 scenarios +
> soak smoke passed against the packed artifact on the Ubuntu/macOS/Windows
> matrix in the same session (run `31319381753`). The suite surfaced and the
> session fixed three Windows-only bugs that the 44-test SDK suite missed:
> a single-shot `fs.rm` destroy race (retried removal + unregister in
> `finally`), a registry-entry resurrection on destroy (serialized pgid writes
> awaited by unregister), and quadratic reaping on Windows (host start-token
> cached per PID; O(n²) PowerShell spawns per reap eliminated). A
> path-separator portability bug in the `resilience` scenario was also fixed.

- [x] **Runner (`production/run.mjs`)**: scenario discovery, per-scenario timing
      budgets, step timing, `--list` / `--only` / `--verbose`, summary table,
      non-zero exit on failure or residue.
- [x] **Residue detection (`production/lib/residue.mjs`)**: leaked sandbox dirs,
      leaked registry entries, processes holding sandbox dirs (Linux `/proc`,
      POSIX `lsof +L1`), registry pgid snapshots with live-process checks.
- [x] **Consumer-workflow scenarios**: AI coding agent (streaming, patch, test
      rerun, artifact byte-compare), CI runner (green build → regression →
      artifact preserved), code evaluation platform (20 sandboxes, mixed
      pass/fail/timeout/CPU-kill outcomes, pool 8, reuse after kill).
- [x] **Adversarial scenarios**: concurrency (50 sandboxes + 20 parallel execs
      in one), recovery (quota+timeout, CPU under concurrency,
      destroy-while-running, crash, 50 create/destroy cycles), resilience
      (malformed input, workDir auto-create/traversal, env overrides vs host
      allowlist, symlinks, 2000-file tree, 4 MiB stdout/stderr byte-exact).
- [x] **Soak (`production/soak/soak.mjs`)**: N sandboxes × read/write/exec
      cycles for a duration; reports iterations, throughput, failures; nightly
      `--minutes 5 --sandboxes 25`.
- [x] **Signal-death correctness fix** (found by the `recovery` scenario): a
      signal-killed workload (e.g. `process.abort()`) was reported as
      `completed` with `exitCode 0`; the native backend now reports `failed`
      with `128 + signalNumber` and records the signal in metadata.

---

## Living Engineering Gist Maintenance Plan

Maintain the central project Gist alongside every capability transition as a cumulative engineering log (preserving past validation history while appending new revisions):
1. **Overview & Purpose**
2. **Architecture & Design Principles**
3. **Current Capability Status** (Supported / Experimental / Unsupported)
4. **Integration Examples & Consumer Verification**
5. **Security Model & Isolation Boundaries**
6. **Benchmarks & Performance Profile**
7. **Validation & Test Results History** (preserve timeline of verified runs)
8. **Known Limitations**
9. **Roadmap Progress & Milestone Audit Log**
