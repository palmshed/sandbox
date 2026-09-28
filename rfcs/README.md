# Architecture Decision Records (`rfcs/`)

Architectural RFCs document why key design choices and trade-offs were made.

- `0001-runtime-spec.md`: Runtime specification strategy.
- `0002-network-policy.md`: Network policy abstractions.
- `0003-filesystem.md`: Virtual filesystem and transfer model.
- `0004-network-isolation.md`: Native backend network isolation (`network: 'disabled'`).
- `0005-crash-recovery.md`: Crash recovery failure model, guarantees, and reaper design (issue `#10`).
- `0006-os-filesystem-isolation.md`: OS-level filesystem confinement of the executed process tree (issue `#3`).
- `0007-cpu-hard-quota.md`: CPU hard quota rate-cap design (contract, capability, platform mapping, failure behavior, test plan). Designed first, then implemented and shipped in spec/SDK 1.2.0 (native Linux cgroups v2, native Windows Job Objects, Docker `--cpus`).
- `0008-rust-sdk-bindings.md`: Rust SDK binding note for F1 (public surface, TypeScript to Rust mappings, absent/unknown semantics, engine boundary, test strategy). Implemented at the F1 milestone (`sdk/rust/`); 0.x release decision pending.
- `0009-go-sdk-bindings.md`: Go SDK binding note for F2 (public API mapping, concurrency semantics under Go's model, absent/unknown rule, Windows behavior, `-race` as a mandatory gate, `go-` tag namespace). Implemented at the F2 milestone (`sdk/go/`); release decision pending.
- `0010-reference-discrepancies.md`: Recorded cross-SDK contract discrepancies found by the F2 release gate. 001: post-cancel status overwrite in the TypeScript reference (and the Rust port that inherited it); Go is correct and is not changed to match.
- `0011-python-sdk-bindings.md`: Python SDK binding note for F3 (async-first API mapping, concurrency and cancellation semantics, absent/unknown rule, Windows behavior, supported versions, `py-` tag namespace). Contract only; no code yet.
