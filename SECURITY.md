# Security Policy & Threat Model

## Threat Model & Security Boundaries

Palmshed Sandbox (`palmshed/sandbox`) isolates untrusted process execution. Security isolation depends on the active execution backend:

- **Native Backend**: Soft process isolation using OS temporary directory boundary & environment controls.
- **Docker Backend**: Containerized isolation using Linux cgroups, namespaces, and Docker network flags.
- **Firecracker / WASI (Future)**: MicroVM and WebAssembly capability sandboxing.

## Reporting a Vulnerability

If you discover a security vulnerability within `palmshed/sandbox`, please do NOT open a public GitHub issue. Send a report to **security@palmshed.io** including:

1. Description of the vulnerability.
2. Steps to reproduce or proof-of-concept script.
3. Affected backends or SDK versions.
