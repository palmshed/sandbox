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
- [ ] Verify npm package installation directly from tarball (`.tgz`) and npm registry
- [x] Comprehensive usage documentation (creation, command execution, filesystem, streaming, destruction)
- [ ] Document version compatibility rules and keep examples updated with every API change

**Success Criteria**: A new engineer can clone the repo and run a sandbox example in minutes.

---

## Phase 2 - Runtime Trust & Boundary Enforcement (Current Focus)

> **Goal**: Turn capability flags into verified runtime guarantees ("This sandbox enforces the boundaries it documents").
> **Rule**: Capabilities change from `false` → `true` only when backed by integration tests.

### 1. Process Lifecycle & Signal Handling (#2) [COMPLETED]
- [x] POSIX process tree discovery (group PIDs & sub-shell descendants)
- [x] Windows process tree termination (`taskkill /F /T` equivalent)
- [x] Orphan process detection integration test suite
- [x] `destroy()` during active streaming/background process execution
- [x] Timeout cleanup regression test suite across platforms

### 2. Resource Enforcement (#7)
- [x] Native CPU time limit enforcement (process-group sampling, `ERR_CPU_EXCEEDED`) — commit `240f2a5`
- [x] Native memory limit enforcement (process-group RSS polling, `ERR_OOM_EXCEEDED`) — commits `bf5cc32` + `91debc8`
- [x] Virtual filesystem disk quota enforcement (`ERR_DISK_QUOTA_EXCEEDED`) — commit `85f477a`
- [x] Structured failure states and error types (`ERR_OOM_EXCEEDED`, `ERR_DISK_QUOTA_EXCEEDED`, `ERR_CPU_EXCEEDED`)
- [x] Backend capability contract unit and integration tests: `memoryLimits: true` and `cpuLimits: true` verified via 26/26 SDK + 19/19 conformance/TCK enforcement tests
- [x] Recursive process-tree cleanup after resource-limit kills (commit `2ee1f24`)
- [ ] Native CPU core quota (`cpuQuota`) enforcement (experimental; cgroups v2 / Job Objects; best-effort sampling currently)

### 3. Network Isolation (Completed)
- [x] Security threat model document (RFC 0004 threat model defined; 8 guarantees verified)
- [x] Native backend isolation design decision (`rfcs/0004-network-isolation.md`)
- [x] Native backend `network: 'disabled'` implementation:
  - Linux: `unshare -n --user --map-root-user` network namespace isolation (commit `9b9c3f1`, fixed for unprivileged CI)
  - macOS: `sandbox-exec` with Seatbelt profile (commit `9b9c3f1`, deprecation risk documented)
  - Windows: Unsupported (documented in platform matrix)
- [x] Adversarial network leak test suite (5/5 PASS):
  - TCP outbound blocking (commit `9b9c3f1`)
  - UDP outbound blocking (commit `780f385`)
  - DNS resolution blocking (commit `9b9c3f1`)
  - Localhost service access blocking (commit `9b9c3f1`)
  - Child process isolation inheritance (commit `780f385`)
- [ ] Docker container network isolation test suite (`--network none` leak checks) — out of scope for Phase 2 Native backend

### Acceptance Criteria for Capability Promotion (`false` → `true`)
- Implementation exists in the native backend engine
- Public API behavior and boundary contracts are fully documented
- Clear failure modes and error types are defined for limit breaches
- **Negative Boundary Test Requirement**: Every capability MUST have a negative test proving explicit, controlled failure and sandbox health when the boundary is breached (e.g., exceeding memory triggers `ERR_OOM_EXCEEDED` while leaving the sandbox engine healthy and reusable).
- Integration tests cover both standard and adversarial cases (fork bombs, memory leaks, unkilled child processes)
- CI suite verifies behavior consistently across target platforms
- Documentation & Gist updated with verified guarantee levels

### Reproducible Guarantee Laboratory (`repro/`)
Every guarantee and every reported bug gets a standalone repro (`repro/<area>/*.js`) that prints expected behavior and exits non-zero when the guarantee is violated. Workflow: repro → confirm it fails → automated test → fix → keep the regression test. Run with `node repro/run.js` (add `--network` to include the red RFC 0004 gap repros). New capability work should land a matching repro in the same change.

---

## Phase 3 - Real-World Usage Examples

> **Goal**: Prove the sandbox solves actual production problems cleanly.

- [x] **AI Agent Runner (`examples/ai-agent-runner.js`)**
  - Workflow: `User Request → Agent → Sandbox → Execute Code → Return Output`
  - Validates: Python/Node.js execution, dependency isolation, timeout handling, stdout/stderr streaming
- [x] **Code Evaluation System (`examples/code-evaluator.js`)**
  - Workflow: `Submission → Sandbox → Run Tests → Collect Results`
  - Validates: Multi-test execution, failed programs, infinite loops, resource limit breaches
- [ ] **Build / Test Environment (`examples/ci-runner`)**
  - Workflow: `Repository → Sandbox FS → npm test / cargo test → Logs + Artifacts`
  - Validates: Workspace mounting, build execution, artifact extraction

---

## Phase 4 - Security & Isolation Hardening

> **Goal**: Make untrusted execution verifiably safe against adversarial workloads.

- [ ] **CPU Hardening**: Infinite loops, runaway processes, strict timeout enforcement (CPU time budget enforced; hard core quota pending)
- [ ] **Memory Hardening**: Large allocations, OOM handling, cleanup after process kill
- [ ] **Filesystem Hardening**: Strict disk limits, permission boundaries, temporary storage cleanup
- [ ] **Process Hardening**: Recursive child process cleanup, signal handling, forced termination

**Success Criteria**: A malicious or broken workload cannot escape or degrade the host environment.

---

## Phase 5 - Developer Experience & Ergonomics

> **Goal**: Make integration intuitive and self-documenting.

- [ ] TypeScript API documentation and automated reference doc generation
- [ ] Practical recipes and common integration pattern examples
- [ ] Actionable error messages detailing root cause and recovery steps
- [ ] Built-in debug logging mode (`SANDBOX_LOG=debug`)
- [ ] Ergonomic API refinements for `sandbox.exec()`, `sandbox.writeFile()`, `sandbox.readFile()`, and `sandbox.destroy()`

---

## Phase 6 - Reliability Testing & Multi-Platform CI

> **Goal**: Guarantee stability for high-throughput, long-running systems.

- [ ] **Concurrency Testing**: Automated 10 and 100 parallel sandbox execution stress tests
- [ ] **Lifecycle Stress Testing**: Rapid create → execute → destroy cycles and in-flight destruction
- [ ] **Crash Recovery**: Graceful cleanup upon host process crash or unexpected backend disconnection
- [ ] **Multi-Platform CI Matrix**: Automated CI verification on Ubuntu, macOS, and Windows

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

- [ ] Stable, frozen public API schema (`spec/v1.0.0`)
- [ ] Semantic versioning guarantees and complete CHANGELOG
- [ ] **Migration & Compatibility Policy**:
  - Strict 6-month deprecation window for non-breaking schema field transitions
  - Explicit supported Node.js runtime matrix (LTS versions)
  - Native backend driver compatibility matrix across Linux distributions / macOS
- [ ] All examples verified against release tarball in CI
- [ ] Package published to npm registry with zero-dependency core engine

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
