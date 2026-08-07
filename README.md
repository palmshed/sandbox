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

- **SDK Release Version**: `v0.1.0-beta.1` (Phase 2 complete: process lifecycle, resource enforcement, network isolation)
- **Runtime Specification**: `0.1.1` (see [`spec/version.md`](spec/version.md))
- **Stability**: **Beta**. All Phase 2 capabilities are implemented and verified. API contracts follow Semantic Versioning rules outlined in [`spec/compatibility.md`](spec/compatibility.md). The SDK release version and runtime specification version are managed independently: the SDK advances through pre-release versions (alpha → beta → rc → stable) while the specification version reflects contract changes only.
- **Network isolation note**: On macOS, `networkIsolation` is `true` (5/5 adversarial leak tests pass). On Linux, it is dynamically probed at `init()` -- `true` when unprivileged user namespaces are available, `false` on CI runners where they are restricted (falls back to proxy env vars).

---

## Architectural Hierarchy

1. **Runtime Specification (`spec/`)**: JSON Schemas & versioning ([`spec/version.md`](spec/version.md)).
2. **Compliance Suite (`compliance/`)**: Cross-language conformance test suite.
3. **SDKs (`sdk/`)**: Reference TypeScript SDK ([`sdk/typescript`](sdk/typescript)), Rust, Go, Python.
4. **Backends (`backends/`)**: Native process driver, Docker container driver, Firecracker, WASI.

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
