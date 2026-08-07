# Palmshed Sandbox (`palmshed/sandbox`)

> General-purpose, language-agnostic sandbox specification and multi-language SDK suite.

`palmshed/sandbox` provides a canonical runtime specification (`spec/`) and SDKs for secure process execution, filesystem isolation, resource limits, network policies, and stdout/stderr streaming across pluggable execution backends.

---

## Architectural Hierarchy

1. **Runtime Specification (`spec/`)**: JSON Schemas & versioning ([spec/version.md](file:///Users/bniladridas/Desktop/sandbox/spec/version.md)).
2. **Compliance Suite (`compliance/`)**: Cross-language conformance test suite.
3. **SDKs (`sdk/`)**: Reference TypeScript SDK ([sdk/typescript](file:///Users/bniladridas/Desktop/sandbox/sdk/typescript)), Rust, Go, Python.
4. **Backends (`backends/`)**: Native process driver, Docker container driver, Firecracker, WASI.

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

const res = await sandbox.exec("node -v");
console.log(res.stdout);

await sandbox.destroy();
```

See [AGENTS.md](file:///Users/bniladridas/Desktop/sandbox/AGENTS.md) for full architectural guidelines and specification rules.
