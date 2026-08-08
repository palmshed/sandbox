# Security Policy & Threat Model

## Threat Model & Security Boundaries

Palmshed Sandbox (`palmshed/sandbox`) isolates untrusted process execution. Security isolation depends on the active execution backend:

- **Native Backend**: Soft process isolation using OS temporary directory boundary & environment controls.
- **Docker Backend**: Containerized execution driver (wires `docker run/exec/cp/stop`). Resource enforcement and network isolation are NOT yet implemented or integration-tested — the backend reports `cpuLimits`, `memoryLimits`, and `networkIsolation` as `false` (work item `#4`). Do not rely on Docker for CPU/memory/network boundaries today.
- **Firecracker / WASI (Future)**: MicroVM and WebAssembly capability sandboxing.

## Reporting a Vulnerability

If you discover a security vulnerability within `palmshed/sandbox`, please do NOT open a public GitHub issue. Send a report to **security@palmshed.io** including:

1. Description of the vulnerability.
2. Steps to reproduce or proof-of-concept script.
3. Affected backends or SDK versions.
