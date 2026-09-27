# Benchmark Harness (`benchmarks/`)

Reproducible evidence generation for sandbox performance. This harness
produces measurements; it does not set targets and its numbers are not
product promises.

## Definitions (accepted contract)

- **Cold start**: `Sandbox.create()` latency, split three ways. `coldInitMs`
  isolates one-time process/backend initialization (capability probes,
  reaper sweep) as first-create wall minus cold-create median.
  `coldCreateMs` is the first create (pays init); `coldCreate` (samples
  2..5 median) is create-after-init; `warmHost` (creates 6..15) is the
  steady state. Every sample starts from a fresh workspace. Docker image
  pull is excluded from all three; image availability and daemon version
  are recorded in the fingerprint.
- **Execution overhead**: representative workload v1 (fixed and
  deterministic): 1 KiB VFS write, one `node -e` hello exec, one VFS
  read-back, exercising process execution plus filesystem activity
  through the sandbox contract. 5 warmups discarded plus 15 samples
  inside the sandbox, compared against a semantically equivalent
  baseline (direct fs ops plus a bare child spawn of the same command;
  for Docker, `docker exec` against an equivalent already-running
  container). Raw sandbox and baseline walls are recorded alongside the
  median ratio so strange percentages can be investigated. The ratio on
  this small workload is fixed-cost dominated by design; it measures the
  sandbox tax on small work, not application overhead at scale.
- **Parallel capacity**: ramp of concurrently live sandboxes (default
  steps 10, 25, 50, 100 up to `--sandboxes`), each running a small mixed
  workload, then destroyed. Records per-step timings and the highest
  successful N. A saturation guard (host free memory, load average) stops
  the ramp before an overloaded host can produce a misleading number;
  stopped steps are recorded as invalid, not failures. The floor is 1 GiB
  available memory; on macOS available means vm_stat
  free+inactive+purgeable+speculative (freemem alone excludes reclaimable
  file-cache memory), elsewhere os.freemem. The active definition is
  recorded in the fingerprint.
- **Per-sandbox host overhead**: host RSS before, create 25 idle
  sandboxes, settle 2 seconds, RSS after; delta divided by N, plus file
  descriptor delta where observable. Workload memory is excluded by
  construction (idle sandboxes).

## Runner fingerprint

Every evidence document records OS, architecture, CPU model and count,
total RAM, Node version, package version and entry path, backend, Docker
daemon version and image state where applicable, and a timestamp.
Results from different runner shapes are never compared or averaged.

## Repetition

15 samples per metric (5 warmups discarded for overhead). Median, p95,
max, min, and sample count are reported; outliers are kept. Runs that
trip the saturation guardrail are invalid, with the reason recorded.

## Backend scope

Native first, alone. Docker is measured separately with its own
baselines. The two are never mixed.

## What does not become a promise

No number from this harness goes into the README, the roadmap, or the
living gist as a target until an explicit promotion decision names the
metric, the value, and the runner shape it holds on. Exploratory
measurements stay in evidence files.

## Usage

```sh
node benchmarks/run.mjs --list
node benchmarks/run.mjs --only cold --verbose
node benchmarks/run.mjs --backend docker --image ubuntu:24.04 --out evidence.json
node benchmarks/run.mjs --sandboxes 50 --samples 10
```

The packed `@palmshed/sandbox` package is measured (resolved from
`node_modules`, as in `production/`), never the workspace build. Exit
code is 0 on completion, including saturation-stopped ramps.
