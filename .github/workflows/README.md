# GitHub Workflows Documentation

| Workflow | Purpose | Trigger |
| --- | --- | --- |
| `ci.yml` | Build, type check, unit tests, compliance & TCK | Push, Pull Request |
| `compliance.yml` | Full compliance matrix across SDKs and Backends | Push, Pull Request |
| `security.yml` | Dependency audit, secret scanning, security analysis | Push, Pull Request, Schedule |
| `release.yml` | Publish release tag artifacts & package builds | Version tags (`v*`) |
| `docs.yml` | Validate markdown documentation and links | Push, Pull Request |
| `benchmarks.yml` | Performance regression checks & metrics | Manual (`workflow_dispatch`), Schedule |

## Governance & Secrets
- **ci.yml**: Requires no secret tokens.
- **release.yml**: Requires `GITHUB_TOKEN` and publishing tokens.
- Workflows serve as part of the public API and MUST be kept synchronized with specification updates.
