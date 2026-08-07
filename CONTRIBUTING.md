# Contributing to Palmshed Sandbox

At this stage of development, code contributions are limited to the core maintainers while the runtime specification and APIs continue to evolve. We welcome bug reports, feature requests, discussions, and design feedback. Once the project reaches a stable release, external code contributions will be opened.

## Development Workflow & CI Verification

1. **Specification First**: Any modification to data structures or execution behavior MUST start with an update to `spec/` schemas and `spec/version.md`.
2. **Capabilities Principle**: Prefer adding capabilities over changing existing behavior. Query capability flags via `sandbox.capabilities`.
3. **Local Guardrails**: Run `./scripts/install-hooks` to enable local pre-commit and pre-push validation scripts.
4. **AGENTS.md Maintenance**: Whenever directory structures, schemas, or SDK layouts change, update `AGENTS.md` in the exact same commit.
