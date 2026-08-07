# RFC 0003: Virtual Filesystem and Transfer Model

- **Author**: Palmshed Team
- **Status**: Accepted
- **Created**: 2026-08-07

## Summary
Provide file manipulation and bidirectional host-sandbox transfer semantics independent of underlying storage mechanisms.

## Design
- `readFile(path)` & `writeFile(path, content)`: In-memory byte array operations.
- `uploadFile(localPath, sandboxPath)` & `downloadFile(sandboxPath, localPath)`: Streaming file transfer abstractions.
