# Palmshed Sandbox Roadmap

This roadmap outlines high-level milestones for `palmshed/sandbox`.

---

## v0.1 - Foundation & Core Execution (Current)
- [x] Runtime specification v0.1.0 (`spec/`)
- [x] Native execution backend
- [x] Docker execution backend
- [x] TypeScript reference SDK (`sdk/typescript`)
- [x] Real-time stdout/stderr streaming
- [x] File upload, download, and virtual filesystem
- [x] Resource limits (CPU, memory, timeout)
- [x] Network policies (`disabled`, `allow`, `proxy`)
- [x] Cross-SDK compliance suite & TCK

## v0.2 - Remote Execution & Daemon Protocol
- [ ] Remote daemon architecture & RPC connection protocol
- [ ] Remote filesystem synchronization
- [ ] Authentication & TLS security layer

## v0.3 - Polyglot SDKs
- [ ] Rust SDK (`sdk/rust`)
- [ ] Go SDK (`sdk/go`)
- [ ] Python SDK (`sdk/python`)
- [ ] Cross-language TCK validation across all SDKs

## v0.4 - MicroVMs & Advanced Sandboxing
- [ ] Firecracker MicroVM backend
- [ ] WebAssembly WASI backend
- [ ] Container/Environment snapshotting and fast restoration
- [ ] Cached execution environments
