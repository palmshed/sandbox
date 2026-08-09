# Palmshed Sandbox (`palmshed/sandbox`)

[![CI](https://github.com/palmshed/sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/palmshed/sandbox/actions/workflows/ci.yml)
[![Security Audit](https://github.com/palmshed/sandbox/actions/workflows/security.yml/badge.svg)](https://github.com/palmshed/sandbox/actions/workflows/security.yml)
[![Compliance & TCK](https://github.com/palmshed/sandbox/actions/workflows/compliance.yml/badge.svg)](https://github.com/palmshed/sandbox/actions/workflows/compliance.yml)
[![Consumer Test](https://github.com/palmshed/sandbox/actions/workflows/consumer-test.yml/badge.svg)](https://github.com/palmshed/sandbox/actions/workflows/consumer-test.yml)
[![Latest Release](https://img.shields.io/github/v/release/palmshed/sandbox?include_prereleases&label=release)](https://github.com/palmshed/sandbox/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> General-purpose, language-agnostic sandbox specification and multi-language SDK suite.

`palmshed/sandbox` provides a canonical runtime specification (`spec/`) and SDKs for secure process execution, filesystem isolation, resource limits, network policies, and stdout/stderr streaming across pluggable execution backends.

---

## Current Status & Stability Expectations

- **SDK Release Version**: `v1.0.0` (Phase 2 complete: process lifecycle, resource enforcement, network isolation)
- **Runtime Specification**: `1.0.0` (frozen; see [`spec/version.md`](spec/version.md))
- **Stability**: **Stable**. The runtime contract is frozen at v1.0.0. API contracts follow Semantic Versioning rules outlined in [`spec/compatibility.md`](spec/compatibility.md) and changes are gated by the 6-month deprecation policy ([`spec/deprecations.md`](spec/deprecations.md)).
- **Network isolation note**: On macOS, `networkIsolation` is `true` (5/5 adversarial leak tests pass). On Linux, it is dynamically probed at `init()`: `true` when unprivileged user namespaces are available, `false` on CI runners where they are restricted (falls back to proxy env vars). On Windows it is `false` (no native unprivileged network isolation; see RFC 0004). The Docker backend reports `networkIsolation`, `cpuLimits`, and `memoryLimits` as `false` until its enforcement is implemented and integration-tested (work item `#4`).
- **v1.0 security guarantee**: **Native v1.0 provides soft process isolation with a hardened virtual filesystem boundary. It does not provide host-filesystem isolation for executed workloads.** Platform limitations:
  - **OS-level filesystem isolation** (chroot / mount namespaces / Seatbelt FS rules): post-v1.0 (see RFC 0003, `SECURITY.md`)
  - **Windows network isolation**: unsupported (no native unprivileged mechanism; RFC 0004)
  - **Docker resource/network enforcement**: experimental / deferred; capability flags remain `false` (work item `#4`)
  - **`cpuQuota`**: experimental, not enforced by the Native backend (`cpuTimeLimit` time budgets are enforced)

---

## Architectural Hierarchy

1. **Runtime Specification (`spec/`)**: JSON Schemas & versioning ([`spec/version.md`](spec/version.md)).
2. **Compliance Suite (`compliance/`)**: Cross-language conformance test suite.
3. **SDKs (`sdk/`)**: Reference TypeScript SDK ([`sdk/typescript`](sdk/typescript)); Rust, Go, and Python SDKs are planned.
4. **Backends (`backends/`)**: Native process driver, Docker container driver; Firecracker and WASI are planned.

---

## Installation

```bash
npm install @palmshed/sandbox
```

---

## Quickstart (TypeScript Reference SDK)

```ts
import { Sandbox } from '@palmshed/sandbox';

const sandbox = await Sandbox.create({
  cpu: 2,
  memory: "512MB",
  timeout: 30000,
  network: "disabled",
  backend: "native"
});

const execution = await sandbox.exec("node -v");
await execution.wait();

console.log("Node version:", execution.stdout());

await sandbox.destroy();
```

See [AGENTS.md](AGENTS.md) for full architectural guidelines and specification rules.

---

## Development & Verification

The repository uses a shared preflight and verification pipeline
(`scripts/`), the same scripts CI runs:

- **`npm run preflight:quick`** - fast developer feedback (git state, prose
  punctuation, required READMEs, SDK typecheck).
- **`npm run preflight`** - full deterministic gate: SDK build/typecheck/tests,
  compliance/TCK, repro laboratory, examples, consumer test, JSON-schema
  validation, docs, workflows, package tarball, and git state.
- **`npm run preflight:release`** - preflight plus the release-readiness gate
  (SDK version == spec version == git tag, CHANGELOG entry).
- **`npm run production:validate`** - builds, packs, and installs the release
  artifact, then runs the production scenario suite and a soak smoke against
  the packed package (never the workspace build). This is the release
  confidence gate CI runs on the Ubuntu/macOS/Windows matrix.

Run the production suite alone with `node production/run.mjs` (`--list`,
`--only <ids>`, `--verbose`); see [`production/README.md`](production/README.md).

---

## Debug Logging (`SANDBOX_LOG=debug`)

Set `SANDBOX_LOG=debug` to emit lifecycle and resource-enforcement events to
stderr (off by default):

```bash
SANDBOX_LOG=debug node your-app.mjs
```

Emitted events (consistent across the native and Docker backends):

| Event                | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `backend.init`       | Backend initialized (capability flags + configured limits)     |
| `exec.start`         | Execution started (backend, pid where available, limits)       |
| `exec.end`           | Execution finished (exit code, duration, timeout flag, CPU ms) |
| `resource.enforced`  | A resource limit was enforced (cpu / memory / disk)            |
| `backend.destroy`    | Backend torn down                                              |

Log lines contain identifiers and resource configuration **only**: never
secrets, environment values, command contents, or filesystem contents. See
[`docs/errors.md`](docs/errors.md) for the error-code reference.
