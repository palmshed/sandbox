# Reference-SDK Semantic Discrepancy 001: post-cancel status overwrite

- **Status**: Recorded, not fixed. Discovered during the F2 (Go SDK)
  release gate cross-language check.
- **Severity**: Contract semantics. No memory, isolation, or resource
  guarantee is affected.
- **Contract authority**: `rfcs/0009-go-sdk-bindings.md` section 2.1
  ("first terminal state observed by the guard wins"), which restates the
  intended behavior for all SDKs.

## Observed behavior

Six cancellation race scenarios run against both SDKs:

| Scenario | Expected (contract) | TypeScript (reference) | Go (F2) | Rust (F1) |
|---|---|---|---|---|
| cancel before natural completion | `cancelled` stays `cancelled` | **`cancelled` then `failed`** | `cancelled` | **`cancelled` then `failed`** (measured) |
| natural completion wins | `completed` stays `completed` | `completed` | `completed` | matches |
| cancel after terminal | unchanged | unchanged | unchanged | matches |
| repeated `cancel()` | idempotent | idempotent | idempotent | matches |
| repeated `wait()` | same result | same | same | matches |
| post-kill closure after cancel | must not overwrite `cancelled` | **overwrites to `failed`** | does not overwrite | **overwrites to `failed`** (measured) |

Evidence: `sdk/go/crosscheck/cancel-probe.mjs` (reference side, prints
observed behavior) and `sdk/go/cancellation_test.go` (Go side, asserts the
normative rule) run the same six scenarios; `sdk/rust/tests/cancellation.rs`
observes the Rust behavior.

## Root cause (TypeScript reference)

`Execution.cancel()` sets the status to `cancelled` and settles the
waiter, but `_complete()` (invoked when the killed child's `close` event
lands) overwrites the status unconditionally. The `cancelled` state is
therefore transient: a cancelled execution reports `failed` a moment
later. `sdk/typescript/src/core/execution.ts`.

The Rust port reproduces the same overwrite in
`Execution::complete()` (measured: `at_cancel=Cancelled
after_settle=Failed overwritten=true`), and its
`cancel_transitions_to_cancelled` test passes only when the assertion runs
before `complete()` lands, making it a latent flake rather than a
guarantee.

## Decision

The Go implementation is correct and is **not** changed to match the
reference. The reference behavior is the divergence. Changing the
TypeScript (and Rust) terminal-state handling would be a deliberate
cross-SDK contract change with its own compatibility review, not an
incidental part of the Go release. It is recorded here and left for that
separate decision.

## Scope notes

- No assertion was weakened to make the comparison pass.
- Neither the TypeScript nor the Rust implementation was modified during
  F2.
- Consumers that read `status` after cancelling should not rely on
  `cancelled` persisting in 1.3.0; only the `cancelled` *event* and the
  immediate status report it.
