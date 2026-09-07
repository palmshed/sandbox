# RFC 0007: CPU Hard Quota (Rate Cap)

- **Author**: Palmshed Team
- **Status**: Design (no implementation). This RFC specifies the contract, semantics, capability model, platform mapping, failure behavior, and compliance test plan for hard CPU quotas. Enforcement lands in a later implementation cycle; no backend may report the new capability until then.
- **Created**: 2026-09-07
- **Specifies**: `cpuQuota` enforcement semantics for `spec/sandbox.schema.json` and `spec/exec.schema.json` (fields already exist); proposes one additive capability flag for `spec/capabilities.schema.json`. No schema changes are applied by this RFC.

## Summary

`cpuTimeLimit` (a CPU time *budget*: the kernel or sampler kills the tree past N milliseconds of CPU) is settled and verified. The remaining resource-control gap is the hard quota: a *rate cap* of X CPU cores that throttles the workload instead of killing it. A throttled workload runs slower; it never receives a kill for being slow. This is a different guarantee from budgets, wall timeouts, and core pinning, and it must not be conflated with any of them (ROADMAP recorded this scope decision on 2026-08-08; this RFC is the promised standalone design item).

## Goal model

- **Noisy-neighbor containment**: an untrusted workload (LLM-generated code, evaluation submissions, CI jobs) must not be able to saturate the host CPU and starve sibling sandboxes or the host itself.
- **Fair-share multi-tenancy**: operators can promise each sandbox a bounded CPU rate (for example 0.5 cores) regardless of what the workload does.
- **Predictable billing/benchmarking**: CPU consumption per sandbox stays within a declared envelope.

### Explicit non-goals

- Not **core pinning or affinity** (cpuset): which physical cores run the workload is the OS scheduler's business. The quota is a rate, not a placement.
- Not **realtime guarantees**: a quota is an upper bound, never a reservation. An idle host does not owe a throttled sandbox its full quota the moment it wakes.
- Not a **budget**: `cpuTimeLimit` already covers kill-on-exhaustion. Quota never kills; combining both (throttle plus budget) is specified below.
- Not **macOS enforcement**: no unprivileged hard-cap API exists there (RLIMIT_CPU is a budget that kills, thread policies are advisory). macOS reports the capability `false` with the rationale recorded.
- Not **cgroup v1**: the Linux mapping targets cgroups v2 only. v1 systems are explicitly out of scope and report `false`.

## Guarantee: what "hard CPU quota" means

| # | Guarantee | Notes |
|---|---|---|
| Q1 | A sandbox created with `cpuQuota: X` (cores, fractional allowed) runs its whole process tree throttled to at most X cores of CPU rate | Throttle, never kill; inheritance covers children |
| Q2 | Every descendant of a workload process inherits the same rate cap | No escape by forking, pipelines, or background jobs |
| Q3 | A per-execution `cpuQuota` overrides the sandbox default for that execution only; later executions see the default again | Override scoping mirrors the memory-override dance (work item #4) |
| Q4 | Quota and time budget compose orthogonally: a throttled workload still dies by `ERR_CPU_EXCEEDED` when its CPU consumption (not wall time) exhausts `cpuTimeLimit` | Budget counts CPU milliseconds; quota only slows the wall clock |
| Q5 | Enforcement needs no elevated privileges | No root, no sudo, no setuid at runtime; where the platform cannot do this unprivileged, the capability is `false` |
| Q6 | Values at or below zero (and NaN) mean unset, mirroring `cpuTimeLimit`; values above host capacity pass through and simply never bind | No clamping, no rejection; a quota above the machine is meaningless but harmless |

## `cpu` versus `cpuQuota` reconciliation

The schemas carry two overlapping fields, and the Docker driver already wires `cpu` to `--cpus`. This RFC resolves the overlap without breaking anything:

- `cpu` and `cpuQuota` share **rate-cap semantics** (cores, fractional). They are not pinning versus cap; the schema already gives `cpu` quota semantics with a fractional minimum, which is incoherent for pinning.
- Precedence: `cpuQuota ?? cpu`. Backends MUST honor `cpuQuota` when set and fall back to `cpu` otherwise; they MUST NOT apply the two differently.
- `cpu` stays a working legacy name (the Docker `--cpus` wiring keeps behaving). No field is deprecated or removed by this RFC; a future breaking cycle may consolidate them.
- Spec description updates (proposed, applied at implementation time): both fields state the shared rate-cap semantic, the precedence rule, and the Q6 validation rule.

## Capability model: `cpuQuotaLimits`

`cpuLimits` keeps its settled meaning (CPU time-budget enforcement) and MUST NOT be reinterpreted. Hard quota gets its own additive boolean flag, following the capability negotiation principle (add capabilities, never change behavior):

```jsonc
{
  "cpuLimits": {             // existing: cpuTimeLimit budget enforcement
    "type": "boolean"
  },
  "cpuQuotaLimits": {        // new: hard rate-cap enforcement (this RFC)
    "type": "boolean",
    "description": "True when the backend enforces hard CPU rate caps (cpuQuota/cpu). Throttling only; never kills."
  }
}
```

Usage contract:

- **true**: the backend enforces Q1-Q4 for the configured runtimes on this platform, and the compliance tests pass.
- **false**: quotas are accepted but ignored (ambient scheduling); callers must not build noisy-neighbor policy on it. This is the only honest value on macOS, on Linux without cgroup delegation, and anywhere untested.
- The flag is per-backend and probed where the mechanism can vary at runtime (Linux delegation), static where the platform decides it (macOS `false`, Docker `true` wherever the daemon accepts the flags).

Fallback behavior contract:

- When `false`, passing `cpuQuota` is a silent no-op at the enforcement level but MUST remain visible: the option is still accepted by types and schemas, and documentation states the platform gap. No silent downgrade of anything else.
- When `true`, the cap applies automatically (sandbox default at create, per-exec override around the execution). There is no per-exec opt-out of a sandbox default short of an explicit override value.

## Platform strategy

Same discipline as RFC 0004 and RFC 0006: investigate, probe, then decide. No pretending equivalent throttling exists across platforms.

### Linux native: cgroups v2 (primary mapping)

- **Mechanism**: one cgroup per sandbox under a delegated v2 subtree, `cpu.max` set to `$QUOTA $PERIOD` with the default period 100000 (for example `50000 100000` for 0.5 cores). The spawned workload tree is moved into the cgroup by writing the child PID to `cgroup.procs` immediately after spawn (moves the whole thread group). Removal at destroy is best effort after the kill.
- **Discovery and probe**: at `init()`, locate a parent that can actually receive moves, trying in order: the SDK host's own cgroup (a live move downward from the workloads' origin cgroup is what the kernel permits; cross-branch moves into a shared provisioned parent are denied, so writability alone never suffices), the `PALMSHED_CGROUP_PARENT` environment override (operator escape hatch), the systemd user delegation path, then a direct child of the cgroup root. The probe demonstrates a REAL live-PID move per candidate (spawn a throwaway sleeper, move it in, kill it, remove the test directory): a bogus-PID write proves writability but fails before the kernel's migration permission checks, so it can report success where no live move is possible. First candidate with a successful live move wins; anything else reports the capability `false`. cgroup v1 hierarchies are out of scope and report `false`.
- **Per-exec override**: apply the override to the sandbox cgroup around the execution and restore the default afterwards, serialized on the same promise-mutex discipline as the Docker memory dance (work item #4). No transient per-exec cgroups (spawn-move race and lifecycle complexity for no benefit over the dance).
- **Residuals to declare**: the spawn-to-move window is closed by having the spawned shell move itself first (`PALMSHED_CPU_CGROUP` carries the sandbox path; the prefix runs before any fork, so descendants inherit the cgroup at birth instead of racing a host-side write). The host-side move remains as backup for slow-forking trees. Remaining residuals: microseconds of unthrottled shell startup before the self-move; rmdir best effort when threads linger; quotas above host capacity never bind (Q6). Setup relocates the SDK host itself into `<parent>/palmshed-self` before enabling `+cpu` in the parent (now member-free with respect to us, satisfying the no-internal-process constraint). Under osfs confinement the self-move write is denied by the Landlock ruleset and only the host-side move applies (fast-forking confined workloads may partially escape accounting); quota tests therefore opt out of confinement to isolate the mechanism. For deterministic results, run quota workloads under a private scope (`systemd-run --user --scope`); shared login sessions may honestly report `false`.

### Windows native: Job Objects (primary mapping)

- **Mechanism**: one Job Object per sandbox, `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION` with `ENABLE | HARD_CAP`, `CpuRate` set to percentage times 100 relative to host capacity (`round(quotaCores / hostCores * 10000)`, clamped to 1..10000; host cores from the OS). Children of job members join the job automatically (Node spawns without breakaway), so Q2 holds without per-process work. Requires Windows 8 / Server 2012 or later (minimum platform for the API).
- **Wiring**: the SDK is dependency-free TypeScript, so job management goes through PowerShell with inline C# P/Invoke: a per-sandbox persistent helper owns the job handles (create, set-rate, query-rate, duplicate-into-SDK) over an ASCII JSON-line protocol, so the C# compiles once instead of per operation. Per-exec overrides adjust the single job rate around the execution under the same mutex discipline.
- **Joining (birth-race closure)**: host-side assignment after spawn cannot cover children forked first (membership is fixed at fork, and the `cmd` wrapper always forks before any host round trip lands), so the workload joins ITSELF first via a `powershell ... && <command>` prefix: the helper duplicates the job handle into the SDK process once per job, the prefix duplicates it once more into itself and assigns itself before forking anything, then closes its copies. Prefix failures exit nonzero (11/12/13 identify the step), failing the execution loudly instead of running uncapped. Cost is a PowerShell startup plus a small C# compile per quota execution; unenforced executions never pay it. One SDK-side duplicated handle slot leaks per quota sandbox (Node cannot close foreign-table handles); process exit reclaims it.
- **Assignment edge**: a process can belong to only one job; if the job cannot be established or wired (host already in a job, Remote Desktop DFSS environments where rate control is unavailable), sandbox creation with a quota fails honestly with `EXEC_FAILED` rather than running uncapped. Without a quota the backend behaves exactly as today.
- **Per-exec override**: adjust the single job rate around the execution and restore afterwards (same dance, same mutex). Nested jobs are noted but not used.

### Docker: create plus update dance

- **Mechanism**: `cpuQuota ?? cpu` maps to `--cpus` at container create (extending the existing `cpu` wiring). Per-exec overrides use `docker update --cpus` plus restore under the shared resource-update mutex (generalize the memory mutex from work item #4 to cover all resource-update dances; concurrent `--cpus` and `--memory` updates must not interleave).
- **Readback for tests**: `docker inspect --format '{{.HostConfig.CpuQuota}}'` exposes the quota in microseconds, which gives the deterministic assertion.
- **Residuals**: same override-serialization note as memory; `--cpus` fractional support follows the daemon.

### macOS native: `false` with rationale

No unprivileged hard-cap API exists (`RLIMIT_CPU` is a kill budget, thread QoS and priority are advisory shaping, not caps). The backend reports `cpuQuotaLimits: false`, accepts the option without effect, and documents the gap. This matches the Seatbelt deferral posture: no pretending.

### Platform matrix (target declarations)

| Platform | Primitive | Declared hard quota |
|---|---|---|
| Linux native (cgroups v2 + delegation) | per-sandbox cgroup, `cpu.max` quota/period | **true** after probe plus compliance tests |
| Linux native (v1 only, or no delegation) | None | **false** (ambient scheduling, declared) |
| Windows native (8 / Server 2012+) | Job Object, `ENABLE \| HARD_CAP` rate | **true** after compliance tests |
| macOS native | None unprivileged | **false** (rationale recorded) |
| Docker (any daemon accepting the flags) | `--cpus` at create, `update` dance per exec | **true** after compliance tests |

## Validation rules (all backends, uniform)

- `cpuQuota` (or `cpu`) at or below zero, NaN, or non-numeric: treated as unset, mirroring `cpuTimeLimit`. No error.
- Above host capacity: passed through untouched; never binds; no clamp, no rejection (Q6).
- Quota and budget are independent options; setting both is legal and composes per Q4.
- Where the capability is `false`, the option is accepted and ignored (documented per platform).

## Failure behavior

- Throttling is not failure: no error code exists for "ran slowly". There is deliberately no `ERR_QUOTA_EXCEEDED`.
- Failures that DO surface: invalid backend state (container or cgroup or job missing mid-execution) surfaces as `EXEC_FAILED`; a quota that cannot be applied where the capability claims `true` fails the execution honestly instead of running uncapped (apply failure rejects before exec, mirroring the memory-apply rule from work item #4).
- Restore failures (override dance) never mask the execution result; the mirror keeps the stale value so the next dance retries instead of running under a wrong limit silently (same rule as the memory dance).

## Compliance test plan (to implement, not implemented here)

Each test runs against the real backend and asserts throttling while the sandbox stays healthy and reusable. Timing margins are deliberately wide (CI runners are noisy); deterministic readback carries the precision.

1. **Rate readback (deterministic, per platform)**: create with quota 0.5; assert the applied value (Linux: `cpu.max` reads `50000 100000`; Windows: queried `CpuRate` equals `round(0.5 / hostCores * 10000)`; Docker: `HostConfig.CpuQuota` equals `50000`). No timing involved.
2. **Throttling behavior (wall clock, wide margins)**: burn 2000ms of CPU under quota 0.5; assert wall time above 3000ms and below 60000ms. Control without quota asserts completion (no upper wall bound asserted on shared runners; the contrast with the throttled lower bound is the signal).
3. **Per-exec override**: sandbox default unset (or 2.0), one execution with quota 0.5 burns slower than the control; a following execution without override runs at ambient rate (restore proven by the control, mirroring the memory restore-control pattern).
4. **Inheritance**: the burn runs inside `sh -c` background plus pipeline children; throttling still applies (Q2). POSIX-only; skipped on Windows, where the equivalent is a `cmd`-spawned child tree under the same job.
5. **Quota plus budget interplay**: quota 0.5 with `cpuTimeLimit` 2000 on an infinite burn rejects `ERR_CPU_EXCEEDED` (budget counts CPU, quota only slows the wall clock; generous wall timeout).
6. **Validation rules**: quota 0, negative, and NaN behave as unset (throttled-time assertions absent; execution simply completes).
7. **Capability honesty**: macOS asserts `cpuQuotaLimits === false` and completion without throttling; Linux without delegation asserts `false`; Docker asserts `true` wherever the daemon accepts the flags.

Gating: Linux native tests skip when the init probe reports no delegation (same skip discipline as the RFC 0006 suite); Windows tests run on Windows CI; Docker tests reuse the Linux-daemon gate from work item #4.

## Design decision gate (this RFC does not implement)

Following RFC 0004 and RFC 0006 discipline, the order is:

1. This design is accepted (contract, capability, mappings, failure behavior, test plan above).
2. Spec deltas land as a minor bump when implementation starts: additive `cpuQuotaLimits` flag in `capabilities.schema.json`, description clarifications plus the precedence rule on `cpu`/`cpuQuota` in `sandbox.schema.json` and `exec.schema.json`. No field removals, no default changes. (Target: spec 1.2.0 with the implementation; spec stays 1.1.0 until then.)
3. Native Linux mapping first (cgroup discovery plus probe, per-sandbox cgroups, override dance), then Windows (Job helper, single job, override dance), then Docker (`--cpus` precedence plus update dance). Each backend promotes `cpuQuotaLimits` only after its compliance tests pass on real hosts.
4. macOS stays `false` with the rationale above; no Seatbelt-shaped promise is made here.

Implementation checklist for the next cycle: cgroup parent discovery plus init probe; per-sandbox cgroup lifecycle (create, move on spawn, best-effort remove); PowerShell C# job helper (create, set-rate, query-rate); Docker `--cpus` precedence plus shared resource-update mutex; the seven compliance tests with the gating above; AGENTS.md, docs/api.md, and type-comment updates at promotion time.
