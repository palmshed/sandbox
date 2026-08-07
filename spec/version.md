# Sandbox Specification Versioning

Current Specification Version: **0.1.0**

## Versioning Rules

The Palmshed Sandbox specification follows Semantic Versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking changes to the core execution contract, mandatory fields, or standard lifecycle methods.
- **MINOR**: Backward-compatible additions (e.g., new network policies, additional resource limit fields).
- **PATCH**: Backward-compatible bug fixes or clarifications in documentation and JSON schemas.

## Specification Changelog

### v0.1.0 (Initial Specification)
- Defined `sandbox.schema.json`, `exec.schema.json`, and `filesystem.schema.json`.
- Established backend engine lifecycle interface (`init`, `exec`, `readFile`, `writeFile`, `uploadFile`, `downloadFile`, `destroy`).
- Defined resource limits (CPU, memory, timeout) and network policy values (`disabled`, `allow`, `proxy`).
