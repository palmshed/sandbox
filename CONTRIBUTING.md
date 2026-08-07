# Contributing Guidelines

Thank you for contributing to Palmshed Sandbox!

## Contribution Workflow

1. **Specification First**: Any change affecting data models or execution contracts MUST start with an update to `spec/` schemas and `spec/version.md`.
2. **Update Conformance & TCK Tests**: When adding feature behavior, update `compliance/` and `tck/` test modules.
3. **Capabilities Principle**: Prefer adding capabilities over changing existing behavior. If a backend cannot support a feature, expose that through capability negotiation (`sandbox.capabilities`).
4. **Update AGENTS.md**: Any commit modifying repository layout, architecture, or developer conventions MUST update `AGENTS.md` in the exact same commit.

## Development & Verification Commands

```bash
# Build TypeScript Reference SDK
cd sdk/typescript && npm run build

# Run unit tests
cd sdk/typescript && npm test

# Run compliance suite and TCK
node --test compliance/sdk/*.test.js compliance/backends/*.test.js tck/*/*.test.js
```
