# Specification Compatibility Guarantees

This document outlines compatibility guarantees for the Palmshed Sandbox Runtime Specification (`spec/`).

## Semantic Versioning Guarantees

### Patch Releases (vX.Y.Z → vX.Y.Z+1)
- **Changes**: Non-functional clarifications, typo fixes, or documentation enhancements.
- **Guarantee**: 100% backward compatible for all SDKs, backends, and clients. No code changes required.

### Minor Releases (vX.Y.Z → vX.Y+1.0)
- **Changes**: Backward-compatible feature additions (e.g., new optional fields in JSON schemas, new capabilities).
- **Guarantee**: Existing SDKs and backends will continue to operate without modification.

### Major Releases (vX.Y.Z → vX+1.0.0)
- **Changes**: Breaking changes to lifecycle contracts, removal of deprecated fields, or required field additions.
- **Guarantee**: Requires major version bumps across all official SDKs and backends.
