# GitHub Workflows Documentation

| Workflow | Purpose | Trigger | Runners |
| --- | --- | --- | --- |
| `ci.yml` | Build SDK, unit & stress tests, compliance & TCK, repro laboratory | Push, Pull Request | ubuntu, macOS, Windows |
| `compliance.yml` | Compliance & TCK suite (dedicated job; also run by `ci.yml`) | Push, Pull Request | ubuntu, macOS, Windows |
| `examples.yml` | Run the AI agent, code evaluator, and CI runner examples | Push, Pull Request (paths: `examples/**`, `sdk/typescript/src/**`, `sdk/typescript/package.json`) | ubuntu, macOS, Windows |
| `consumer-test.yml` | Isolated consumer integration test from packed tarball + install from npm registry (`@palmshed/sandbox@beta`) | Push, Pull Request (paths: `examples/consumer-test/**`, `sdk/typescript/src/**`, `sdk/typescript/package.json`) | ubuntu |
| `security.yml` | `npm audit` dependency check | Push, Pull Request, Schedule (weekly) | ubuntu |
| `docs.yml` | Verify required documentation files exist + generate Typedoc API reference | Push, Pull Request | ubuntu |
| `benchmarks.yml` | Scheduled SDK test run (benchmark harness not yet implemented) | Manual (`workflow_dispatch`), Schedule (weekly) | ubuntu |
| `release.yml` | Version-gated release: validation gate, artifacts & SBOM, GitHub release, npm publish (TypeScript); Rust/Go/Python publishers are placeholders | Version tags (`v*`) | ubuntu |

## Governance & Secrets
- **ci.yml**: Requires no secret tokens.
- **consumer-test.yml**: No secret tokens; the `registry-install` job installs the published `@palmshed/sandbox@beta` package from the npm registry.
- **release.yml**: Requires `GITHUB_TOKEN` (auto-provisioned) and an npm publishing token (`NODE_AUTH_TOKEN` via `setup-node` `registry-url`).
- Workflows serve as part of the public API and MUST be kept synchronized with specification updates.
