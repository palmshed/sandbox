# GitHub Workflows Documentation

| Workflow | Purpose | Trigger | Runners |
| --- | --- | --- | --- |
| `ci.yml` | Build SDK, unit & stress tests, compliance & TCK, repro laboratory. The `node-lts` job covers Node 20 + 22 LTS lines on ubuntu, macOS, and Windows | Push, Pull Request | ubuntu, macOS, Windows |
| `compliance.yml` | Compliance & TCK suite (dedicated job; also run by `ci.yml`) | Push, Pull Request | ubuntu, macOS, Windows |
| `examples.yml` | Run the quickstart, AI agent, code evaluator, and CI runner examples against the packed release artifact | Push, Pull Request (paths: `examples/**`, `sdk/typescript/src/**`, `sdk/typescript/package.json`) | ubuntu, macOS, Windows |
| `consumer-test.yml` | Isolated consumer integration test from packed tarball plus the published npm artifact (`@palmshed/sandbox@latest`) via `run-published.sh`, same shared suite both provenances, per-OS evidence upload | Push, Pull Request (paths: `examples/consumer-test/**`, `sdk/typescript/src/**`, `sdk/typescript/package.json`) | ubuntu, Windows |
| `security.yml` | `npm audit` dependency check | Push, Pull Request, Schedule (weekly) | ubuntu |
| `docs.yml` | Verify required documentation files exist + generate Typedoc API reference | Push, Pull Request | ubuntu |
| `scheduled-tests.yml` | Weekly Monday SDK test run plus nightly sustained soak and exact-version gate, all against the packed release artifact | Manual (`workflow_dispatch`), Schedule (weekly Monday, nightly) | ubuntu |
| `probes.yml` | Landlock capability probe and runtime-allowlist confinement smoke on the real Ubuntu runner image | Push, Pull Request | ubuntu-24.04 (pinned) |
| `production.yml` | Packed-artifact production validation scenarios and soak across the OS matrix | Push, Pull Request (paths: `production/**`, `sdk/typescript/src/**`, `sdk/typescript/package.json`) | ubuntu, macOS, Windows |
| `release.yml` | Version-gated release: validation gate, pack contents verification, artifacts & SBOM, GitHub release, npm publish + registry smoke test (TypeScript); Rust/Go/Python publishers are placeholders. The publish job is idempotent (skips already-published versions) and the smoke test retries install for up to 150s to absorb registry propagation delay | Version tags (`v*`) | ubuntu-24.04 (pinned) |

## Governance & Secrets
- **ci.yml**: Requires no secret tokens.
- **consumer-test.yml**: No secret tokens; the `registry-consumer` matrix job installs the published `@palmshed/sandbox@latest` package from the npm registry into a clean temp project and uploads per-OS evidence.
- **release.yml**: Requires `GITHUB_TOKEN` (auto-provisioned) and an npm publishing token stored as the `NPM_TOKEN` repository secret, wired into the publish job as `NODE_AUTH_TOKEN` (the job-level `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`; `setup-node`'s `registry-url` alone does not inject a token).
- Workflows serve as part of the public API and MUST be kept synchronized with specification updates.
- All workflows pin `actions/checkout@v5` and `actions/setup-node@v5` (v4 and earlier are built on Node 20, which is deprecated on GitHub runners). Artifact upload/download remain on `@v4`.
