# Production Validation Suite

End-to-end validation of `@palmshed/sandbox` exactly as a production consumer
would use it: installed from the packed release artifact, driving real workloads,
and verifying the host returns to its prior state afterward.

Unlike the SDK unit/integration suites, the production suite is **adversarial by
construction**: scenarios exercise full consumer workflows (AI coding agent, code
evaluation platform, CI runner) under concurrency and hostile inputs, then assert
two things at the end of every scenario:

1. **Correct outcomes** for every workload (pass, fail, timeout, CPU kill, quota
   breach) and a **usable sandbox** after each failure mode.
2. **Zero residue**: no leaked sandbox directories, no leaked registry entries,
   no live workload processes, after every sandbox is destroyed.

The suite runs against the **packed npm tarball** installed into the checkout's
`node_modules`, never against the workspace build, so it validates the artifact a
consumer actually installs.

## Layout

```text
production/
├── run.mjs                  # Scenario runner (--list, --only, --verbose, budgets, residue)
├── lib/
│   ├── harness.mjs          # ctx: sandbox factory, asserts, steps, residue helpers
│   └── residue.mjs          # dir / registry / process-holder / pgid live-process scans
├── scenarios/
│   ├── ai-agent.mjs         # Full AI agent workflow (streaming, patching, artifacts)
│   ├── artifacts.mjs        # Concurrent uploads/downloads, overwrites, byte-exact binary
│   ├── ci-runner.mjs        # Build → test green → regression → artifact preserved
│   ├── code-evaluator.mjs   # 20 sandboxes, mixed pass/fail/timeout/CPU-kill, pool 8
│   ├── concurrency.mjs      # 50 concurrent sandboxes + 20 parallel execs in one
│   ├── crash-recovery.mjs   # Host hard-kill → orphaned sandbox reaped on next create
│   ├── recovery.mjs         # quota+timeout, CPU+concurrency, destroy-while-running, crashes
│   ├── fixtures/
│   │   └── crash-host.cjs   # Host-process fixture used by crash-recovery
│   └── resilience.mjs       # Malformed input, env overrides, symlinks, 2000 files, 4MiB streams
└── soak/
    └── soak.mjs             # Sustained soak: N sandboxes, --minutes / --sandboxes
```

## Running

```bash
# 1. Build the SDK and install the packed artifact into this checkout
cd sdk/typescript && npm run build && cd ../..
PACKFILE=$(cd sdk/typescript && npm pack --silent | tail -n 1)
npm install --no-save "./sdk/typescript/$PACKFILE"

# 2. Run the full suite
node production/run.mjs

# 3. Run a subset
node production/run.mjs --list
node production/run.mjs --only recovery,resilience
node production/run.mjs --verbose          # surface per-step logs
```

Exit code is `0` when every scenario passed and left no residue, `1` otherwise.

## Soak

```bash
node production/soak/soak.mjs --minutes 5 --sandboxes 25
```

Each sandbox loops read/write/exec cycles until the deadline; the driver reports
iterations, throughput, and failures, and exits non-zero on any error or stall.

## Confidence-gate criteria

The suite is a release-confidence gate for `@palmshed/sandbox`. A release is
production-ready when the entire suite (plus the SDK, compliance/TCK, and repro
gates) is green on the 3-OS CI matrix:

- **Every scenario passes** on Ubuntu, macOS, and Windows against the packed
  tarball.
- **No residue** is reported in any scenario on any platform.
- **Windows-aware behavior** is respected where platform capabilities differ
  (network-isolation scenarios skip where the capability is `false`; CPU/memory
  enforcement is best-effort per the documented matrix).
- **Soak** completes a 5-minute nightly run with zero failures and no process
  growth trend across runs.

See `.github/workflows/production.yml` for the CI wiring and
`scheduled-tests.yml` for the nightly soak and exact-version verification.
