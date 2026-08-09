# `repro/`: Reproducible Guarantee Laboratory

Small, standalone scripts that reproduce a guarantee, a bug, or a regression in
one command. Each script is a minimal, self-contained artifact that answers:
*"does the runtime actually do what it claims on this machine?"*

## Contract

Every repro:

1. **States what it demonstrates** (header comment).
2. **Prints expected behavior** when run.
3. **Exits `0` when the guarantee holds**, `1` when it is violated (or an
   unexpected error occurs).
4. **Is runnable with one command** from the repository root:

```bash
node repro/memory/shell-child.js
```

## Layout

```
repro/
├── cpu/      # CPU time budget enforcement
├── memory/   # RSS/memory limit enforcement
├── process/  # lifecycle: signal handling, nested trees, destroy
├── disk/     # virtual filesystem disk quota
├── network/  # network isolation repros (RFC 0004 implemented)
└── crash/    # crash recovery repros (RFC 0005 implemented)
```

## Bug / Guarantee Workflow

When a bug is reported (or a guarantee is challenged):

1. **Add a repro** under the matching directory.
2. **Confirm it fails** (`exit 1`) against the current runtime.
3. **Turn it into an automated test** in `compliance/`, `tck/`, or
   `sdk/typescript/src/test/`.
4. **Fix the implementation.**
5. **Keep the test permanently**; the repro stays as a historical artifact.

This is the same pattern used for CPU and memory enforcement:

```
issue → minimal reproduction → failing test → fix → regression test
```

## Status Legend

| Directory | Status |
|-----------|--------|
| `cpu/`    | Green: CPU-time enforcement is implemented and validated |
| `memory/` | Green: memory enforcement is implemented and validated |
| `process/`| Green: lifecycle guarantees are implemented |
| `disk/`   | Green: disk quota is implemented |
| `network/`| **Green**: `network: 'disabled'` is enforced by the Native backend via `sandbox-exec` (macOS, verified 5/5) and `unshare -n --user --map-root-user` (Linux when user namespaces are available; falls back to proxy env vars otherwise). See `rfcs/0004-network-isolation.md`. |
| `crash/`  | **Green**: graceful shutdown and post-crash reaping work (RFC 0005). `graceful-shutdown.js` and `hard-crash.js` are POSIX-only and skip on Windows; `live-sandbox-immunity.js` is cross-platform. |

## Notes

- Scripts `require('../../sdk/typescript/dist/index.js')`, so the SDK must be
  built first: `cd sdk/typescript && npm run build`.
- No external dependencies; only Node built-ins plus the SDK.
