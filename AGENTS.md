# Palmshed Sandbox (`palmshed/sandbox`)

> A general-purpose, language-agnostic sandbox specification and multi-language SDK suite for secure process execution, filesystem isolation, resource limiting, and network policies across pluggable backends.

---

## Architecture & Hierarchy Principle

> **Core Principle**: The runtime specification (`spec/`) is the ultimate source of truth. SDKs, backends, examples, and documentation MUST conform strictly to the specification rather than defining independent behavior.

### System Hierarchy

1. **Runtime Specification (`spec/`)**: JSON Schemas, data models, governance (`compatibility.md`, `deprecations.md`), and versioning (`spec/version.md`).
2. **Architecture Decision Records (`rfcs/`)**: Explanations of *why* choices are made (`rfcs/0001-runtime-spec.md`, `rfcs/0002-network-policy.md`, `rfcs/0003-filesystem.md`).
3. **Technology Compatibility Kit (`tck/`)**: Modularity test suites (`lifecycle/`, `execution/`, `filesystem/`, `networking/`, `resources/`) for certifying external SDKs and backends.
4. **Compliance Suite (`compliance/`)**: Internal cross-SDK (`compliance/sdk/`) and Backend Conformance (`compliance/backends/`) test suites.
5. **SDK Implementations (`sdk/`)**: Language-specific SDKs (TypeScript reference SDK, Rust, Go, Python).
6. **Backend Engine Drivers (`backends/`)**: Local Native, Docker, Firecracker, WASI, and Remote Daemon drivers.

---

## Repository Layout

```text
sandbox/
├── spec/                  # Runtime specification & JSON schemas
│   ├── sandbox.schema.json# SandboxOptions JSON schema
│   ├── exec.schema.json   # ExecOptions & ExecResult JSON schemas
│   ├── filesystem.schema.json # Filesystem transfer schemas
│   ├── capabilities.schema.json # Backend capability negotiation schema
│   ├── CHANGELOG.md       # Specification changelog
│   ├── compatibility.md   # SemVer compatibility guarantees
│   ├── deprecations.md    # Field deprecation schedule
│   └── version.md         # Specification versioning
├── rfcs/                  # Architectural RFCs explaining design choices
│   ├── 0004-network-isolation.md # Native network isolation design (Accepted)
├── tck/                   # Technology Compatibility Kit for external certification
│   ├── lifecycle/
│   ├── filesystem/
│   ├── execution/
│   ├── networking/
│   └── resources/
├── backends/              # Pluggable backend drivers (Native, Docker, Remote Daemon, etc.)
├── sdk/                   # Language-specific SDKs
│   ├── typescript/        # Phase 1 Reference TypeScript SDK
│   ├── rust/              # Phase 2 Rust SDK & core engine
│   ├── go/                # Phase 3 Go SDK
│   └── python/            # Phase 3 Python SDK (AI agent frameworks)
├── scripts/
│   ├── punctuation-check.mjs  # CI: hard-fail on Unicode em dash in prose; warn-only on prose --
│   ├── preflight.mjs          # Repo preflight orchestrator (quick | normal | release modes)
│   ├── production-validate.mjs# Packed-artifact production suite + soak smoke (npm run production:validate)
│   ├── verify-sdk.mjs         # SDK gate: deps, typecheck, build, unit & stress tests
│   ├── verify-conformance.mjs # Compliance suite + TCK gate
│   ├── verify-repro.mjs       # Repro laboratory gate
│   ├── verify-examples.mjs    # Examples vs packed artifact gate
│   ├── verify-consumer.mjs    # Isolated consumer test gate (run.sh + fixture restore)
│   ├── verify-schemas.mjs     # spec/ JSON schema validation (ajv + $ref resolution)
│   ├── verify-docs.mjs        # Required READMEs + Typedoc API reference gate
│   ├── verify-workflows.mjs   # GitHub Actions workflow structural validation
│   ├── verify-package.mjs     # npm pack --dry-run tarball-content gate
│   ├── verify-gitstate.mjs    # git repository + generated-artifact tracking checks
│   ├── verify-release.mjs     # Version gate (tag == SDK == spec) + CHANGELOG
│   ├── lib/preflight-lib.mjs  # Shared helpers (run, install, artifact, counts, Reporter)
│   └── probes/                # Capability probes (network isolation measurement)
├── compliance/            # Cross-SDK & Backend conformance test suites
│   ├── sdk/               # SDK behavior verification
│   ├── backends/          # Backend engine contract tests
│   └── fixtures/          # Shared test fixtures
├── repro/                 # Reproducible guarantee/bug laboratory
│   ├── cpu/               # CPU-time enforcement repros
│   ├── memory/            # Memory enforcement repros
│   ├── process/           # Lifecycle repros (signals, nested trees, destroy)
│   ├── disk/              # Disk quota repros
│   ├── network/           # Network isolation repros (RFC 0004)
│   ├── crash/             # Crash recovery repros (RFC 0005; host-crash reaping)
│   └── run.js             # Runs all repros; use --verbose for output
├── examples/              # Usage examples and scripts
│   ├── consumer-test/     # Isolated consumer integration test (built from npm pack)
│   │   └── run.sh         # Reproducible: build + pack + install + test
│   └── README.md          # Usage examples overview
├── production/            # Production Validation Suite (packed-artifact end-to-end gates)
│   ├── run.mjs            # Scenario runner (--list / --only / --verbose, residue checks)
│   ├── lib/               # Harness (ctx, asserts, steps) + residue detection
│   ├── scenarios/         # ai-agent, ci-runner, code-evaluator, concurrency, recovery, crash-recovery, resilience, artifacts
│   ├── soak/soak.mjs      # Sustained soak driver (--minutes / --sandboxes)
│   └── README.md          # Confidence-gate criteria and run instructions
├── AGENTS.md              # Primary agent reference guide
└── README.md              # Repository overview
```

---

## Capability Negotiation

Every execution backend reports supported features dynamically via `capabilities`:

```json
{
  "filesystem": true,
  "networkIsolation": true,
  "cpuLimits": true,
  "memoryLimits": true,
  "streaming": true,
  "remoteExecution": false
}
```

`cpuLimits` reflects CPU **time** budget enforcement (Linux/macOS: supported via process-group sampling; Windows: best-effort PowerShell `Get-CimInstance` process-tree polling). The hard core quota (`cpuQuota`) is experimental and not enforced by the Native backend.

`networkIsolation` is probed at `init()` time:
- **Linux**: `true` if `unshare --user --map-root-user` succeeds (unprivileged user namespaces available); `false` on CI runners where user namespaces are restricted (falls back to proxy env vars)
- **macOS**: `true` (uses `sandbox-exec` with Seatbelt profile, note: deprecated by Apple; documented limitation in RFC 0004)
- **Windows**: `false`; no native unprivileged network isolation exists (documented in RFC 0004); `init()` flips the flag to `false` and network tests/repros skip on Windows

The **Docker backend** reports only capabilities backed by implementation and integration tests: `filesystem: true`, `streaming: true`, and `remoteExecution: false`. `cpuLimits`, `memoryLimits`, and `networkIsolation` are `false`; the driver wires `docker run/exec/cp/stop` CLI calls, but CPU time-budget enforcement, per-execution memory overrides, and network policies beyond `disabled` are not implemented or integration-tested (backend-parity work item `#4`). Do not mark these `true` without implementation and test coverage.

This allows SDKs to adapt gracefully without embedding backend-specific conditional logic.

---

## Living Engineering Gist

The central project engineering log lives at:

**https://gist.github.com/bniladridas/e2a499783be6d2b9de4dd7cf4f34ee7d** (`building-palmshed-sandbox.md`)

It records validation state, verified capabilities, benchmark profiles, and a cumulative revision history. Every capability transition (`false` → `true`) or completed issue sub-task MUST be reflected there in the same work session (including the commit(s), negative/recovery test results, and any platform limitations).

Update it via the GitHub API (avoids the interactive editor):

```bash
node -e '
  const fs = require("fs");
  const content = fs.readFileSync("<file>", "utf-8");
  const payload = { files: { "building-palmshed-sandbox.md": { content } } };
  fs.writeFileSync("<payload>.json", JSON.stringify(payload));
'
gh api -X PATCH gists/e2a499783be6d2b9de4dd7cf4f34ee7d --input <payload>.json
```

---

## Build & Conformance Commands

- **Preflight (quick)**: `npm run preflight:quick` (developer feedback in seconds; git state, punctuation, READMEs, SDK typecheck)
- **Preflight (normal)**: `npm run preflight` (everything deterministic: SDK, compliance/TCK, repro, examples, consumer, punctuation, schemas, docs, workflows, package, git state; same scripts CI runs)
- **Preflight (release)**: `npm run preflight:release` (normal + release-readiness version gate + clean working tree)
- **Production Validation Suite**: `npm run production:validate` (build + pack + install the release artifact, then run `production/run.mjs` and a soak smoke against the packed package, never the workspace build)
- **Build TypeScript Reference SDK**: `cd sdk/typescript && npm run build`
- **TypeScript Unit, Integration & Stress Tests**: `cd sdk/typescript && npm test`
- **Run Conformance Suite & TCK**: `node --test compliance/sdk/*.test.js compliance/backends/*.test.js tck/*/*.test.js`
- **Run Consumer Integration Test**: `examples/consumer-test/run.sh`
- **Run Repro Laboratory**: `node repro/run.js` (network repros auto-skip when `networkIsolation` is unavailable on the host; use `--all-network` to force them)
- **Run Production Validation Suite**: build + pack + install the release artifact, then `node production/run.mjs` (scenarios: `--list`, `--only <ids>`, `--verbose`). The suite validates the packed tarball, not the workspace build. See `production/README.md`.
- **Run Soak**: `node production/soak/soak.mjs --minutes 5 --sandboxes 25` (see `--help`-style flags in the file header)
- **CI parity**: the 3-OS production suite runs in `.github/workflows/production.yml`; nightly soak + exact-version gate run from `.github/workflows/scheduled-tests.yml`

---

## Coding & Architectural Conventions

- **Specification First**: Any modification to data structures or execution behavior MUST start with an update to `spec/` schemas and `spec/version.md`.
- **Capability Negotiation Principle**: Prefer adding capabilities over changing existing behavior. A capability flag MUST NOT be marked `true` unless it is backed by verified native implementation, documented failure states, and integration test coverage. Feature availability must be queried via `sandbox.capabilities` or `backend.capabilities`.
- **Agent Neutrality**: Sandbox engines know nothing about LLM prompts or agent frameworks. AI tools (e.g. `mull`, `kit`, `predicate`) consume the SDK.
- **Prose Punctuation**: Use proper punctuation in prose (`:` for explanation, `,` for a pause, `;` for related clauses, `()` for an aside, `.` for a separate thought). Do not use the Unicode em dash (`—`) or prose `--` in prose. Preserve technical `--` (CLI flags, POSIX `--` separators) and Markdown `---` (rules, table separators) exactly as-is. Enforced by `scripts/punctuation-check.mjs` in CI (`docs.yml`); the living gist follows the same convention.
- **AGENTS.md Maintenance**: Whenever folder structures, specification schemas, or SDK layouts are modified, this `AGENTS.md` file MUST be updated in the exact same commit.
