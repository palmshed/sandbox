# RFC 0012: Firecracker Backend Feasibility and Architecture Gate (F4)

- **Status**: Accepted as the F4 Phase 1 gate; guest-agent protocol decided in section 14. No implementation yet.
- **Scope**: Settles whether and how a Firecracker backend can join the
  existing contract, and under what prerequisites. It does not change the
  specification, any SDK, or any existing backend.

## 1. Finding: a new execution boundary, not another process driver

Native and Docker both execute workloads as host processes (directly, or
inside a container sharing the host kernel). Firecracker executes
workloads inside a guest kernel on a virtual machine. That changes the
failure surface in ways process drivers never face: guest boot, guest
agent liveness, VM teardown, and image provenance. F4 is therefore gated
on a validation environment and a guest contract, not just on code.

## 2. Execution environment (prerequisite P1)

Firecracker requires Linux with KVM (`/dev/kvm`). Consequences verified
against the live repository and host:

- The Apple Silicon Mac used for development has no `/dev/kvm` and
  cannot serve as the integration-test host.
- GitHub-hosted runners do not expose nested virtualization, so the
  standard CI matrix cannot run Firecracker integration tests. Any
  Firecracker test that runs there must probe for `/dev/kvm` and skip
  honestly when absent, following the existing Landlock probe pattern.
- F4 implementation beyond a probe stub requires a KVM-capable Linux
  host: a self-hosted runner or a provisioned cloud VM with nested
  virtualization enabled. **Stop condition: without such a host, F4
  stays Not started and no backend code is merged.**

## 3. Isolation boundary (decision)

The backend owns the full VM lifecycle and delegates nothing to an
external orchestrator:

- Launch through Firecracker's own `jailer` (chroot, cgroup, network
  namespace setup, privilege drop), matching the repository's
  zero-orchestrator posture. No containerd, no Kubernetes, no sidecar
  runtime dependency.
- Drive the VMM over its Unix-socket REST API from the SDK's backend
  glue, the same way the Docker backend shells out to the `docker` CLI.
- Teardown is SIGKILL-equivalent at the VMM process level: killing the
  VMM ends the entire guest, so cancellation and timeout have a total,
  unambiguous mechanism. This is strictly stronger than process-tree
  reaping and needs no descendant discovery inside the guest.

## 4. Guest contract (decision)

All workload IO crosses the VM boundary through one channel:

- A minimal in-guest agent, baked into the guest root filesystem at
  build time, speaks to the host over `vsock`. Commands, stdin,
  stdout/stderr streams, exit status, and the workspace file protocol
  all travel this channel. There is exactly one agent protocol, versioned
  with the backend, and the host never assumes a newer guest than the
  image it booted.
- Workspace files transfer over the same channel (or a per-sandbox
  block device attached at boot); the VFS containment semantics
  (traversal, absolute-path, and symlink-escape rejection) are enforced
  at the SDK layer before bytes cross, unchanged from the current
  contract.
- Exit status comes from the agent's wait report. Agent silence, agent
  crash, or VM death is reported as a failed execution with an explicit
  cause, never as success and never as a zero exit.
- Streaming and the 16 MiB retained-output bound apply at the SDK layer
  exactly as today; the transport being a socket changes nothing about
  the retention contract or the `truncated` flag.
- Resource limits map to static VM sizing (`vcpu_count`, `mem_size` at
  boot), which is a different semantic from the sampling enforcement the
  Native backend reports. Per-execution overrides are not assumed: they
  require either a second VM or a proven hot path, so the initial
  backend reports static per-sandbox sizing only, documented as such.

## 5. Networking and storage (decisions)

- Root filesystem and kernel images are inputs, and the repository
  contains zero guest assets today. Binaries are never vendored into the
  repo. The prerequisite is a provenance pipeline: pinned upstream image
  references with SHA256 verification and license review, fetched at
  test time. **Stop condition: without that pipeline, no guest boots.**
- Default network posture is deny: no TAP device is attached unless a
  network policy requires one, and any `networkIsolation: true` claim
  waits for the same adversarial leak suite the Native backend passed.
  TAP setup needs host privileges, so the jailer-owned path is the only
  accepted one; host-scripted TAP plumbing outside the jailer is
  rejected.
- Snapshot and restore are explicitly out of scope for F4. They are not
  in the contract today, and no capability flag is added for them.

## 6. Capability mapping (honest initial values)

Every flag starts at its deny value and flips only on evidence, per the
capability negotiation principle:

- `filesystem`: `true` only when workspace transfer works end to end
  through the agent channel under test.
- `networkIsolation`: `false` until the leak suite passes against the
  TAP/jailer configuration.
- `cpuLimits`, `memoryLimits`: `false` until the static-sizing mapping
  is tested and its semantic difference from sampling enforcement is
  documented. Do not conflate the two.
- `streaming`: `true` only when vsock streaming is tested, including
  the unbounded-producer case the retention contract exists for.
- `osFilesystemIsolation`: `unknown` until guest-side escape-suite
  equivalents pass. The guest kernel boundary is likely to satisfy the
  contract, but likelihood is not evidence.
- `remoteExecution`: `false`. F4 does not change the deployment
  boundary; that is F6.
- `cpuQuotaLimits`: `false` until proven. Static vCPU sizing may turn
  out to be the mechanism, but the claim waits for tests either way.

## 7. Spec gap verdict: no specification change

The `BackendEngine` interface (`init`, `exec`, `readFile`, `writeFile`,
`uploadFile`, `downloadFile`, `destroy`, plus `capabilities`) already
covers a VM-backed driver: every guest interaction in section 4 fits
inside an existing method. The schemas need no new field, and no new
capability is proposed. If implementation later surfaces a genuine gap
(something a VM backend must express that no method or flag can carry),
it is escalated as a spec question rather than answered unilaterally,
following the F1/F2/F3 precedent.

## 8. Test strategy and release gate

- `compliance/backends/firecracker.test.js` mirrors the Docker backend's
  gate: KVM probe first, honest skip without it, full lifecycle,
  failure, timeout, cancellation, and capability assertions with it.
- A consumer lifecycle (create, write, exec, stream, result, destroy)
  runs against a real VM on the KVM host.
- Reference TypeScript SDK first. Rust, Go, and Python consume the same
  backend through their own glue later; no SDK work is part of F4.
- Docs (`docs/api.md` backend section, `SECURITY.md` boundary table,
  `AGENTS.md` capability matrix) update in the same change as the flip
  of any flag, never before.

## 9. Explicit non-goals

- No snapshot/restore support or capability.
- No guest image building infrastructure beyond the pinned-asset
  provenance pipeline.
- No orchestrator integration (containerd, Kubernetes, hosted VM APIs).
- No GraphQL, Redis, or Kafka. The backend uses the existing
  `BackendEngine` interface plus Firecracker's local REST API; execution
  state lives in-process per sandbox and guest messages travel the
  versioned vsock channel directly. Those technologies answer to a
  future distributed control plane, not to F4.
- No changes to the Native or Docker backends, any SDK, or the spec.
- No placeholder or stub backend merged to "reserve" the name. The
  `firecracker` registry entry appears together with a working,
  tested driver or not at all.

## 10. F4 completion gate

```text
KVM-capable Linux host available (P1)
    ↓
guest asset provenance pipeline (P2)
    ↓
jailer-owned lifecycle + vsock agent backend
    ↓
compliance suite green on the KVM host
    ↓
consumer lifecycle on a real VM
    ↓
honest capability reporting
    ↓
docs updated with flags
```

## 11. Deferral record (2026-10-14)

- **Decision**: F4 deferred. Prerequisite P1 is unsatisfied and not
  satisfiable from the development host, so implementation does not
  start, not even a stub.
- **Survey evidence**: local `/dev/kvm` absent (verified); Lima, Colima,
  and Docker Desktop excluded as KVM-hosting paths on Apple Silicon
  (Hypervisor.framework exposes no KVM interface to guests); no remote
  Linux host identified; no cloud CLI or account available locally. The
  blocker is infrastructure, not a missing local tool.
- **Asset pipeline**: remains a proposal. The manifest plus
  checksum-verification design in section 5 is unvalidated: no upstream
  artifact, license, or reproducibility claim is verified.
- **Resume conditions**: verify host architecture, `/dev/kvm` presence
  and permissions, and a successful real Firecracker boot on the new
  host first; then establish the self-hosted runner and
  integration-test path; then begin backend implementation. Runner
  registration alone does not prove Firecracker can boot.

## 12. Lifecycle resolution (deeper review, decided)

Killing the VMM is a reliable whole-guest termination mechanism, but it
cannot by itself preserve execution-level cancellation in a reusable
sandbox. The resolution separates the two operations permanently:

- **Execution cancellation is per command, inside the guest.** The host
  sends a cancellation request naming the execution ID. The guest agent
  terminates that command and its descendants, reaps them, and reports a
  terminal result. The sandbox stays usable whenever the guest is
  otherwise healthy.
- **VMM termination is reserved for sandbox destruction and
  unrecoverable guest failure.** Destroy rejects new work, settles every
  outstanding execution, stops the guest, awaits VMM process exit, and
  releases host-side resources. Teardown is idempotent and safe after
  partial initialization, unexpected VMM exit, or concurrent execution
  failure.

Terminal precedence follows the cross-SDK rule already established for
cancellation: the first terminal outcome observed by the host guard wins
for each execution, and contradictory terminal events are never emitted.
A cancellation acknowledgement from the agent is not proof of
termination; the host treats cancellation as complete only after
termination is confirmed or the entire guest has been terminated.
Cancel-after-terminal is a no-op, and repeated cancellation is
idempotent.

Concurrency policy: one VM per sandbox, with the agent multiplexing
concurrent commands. The contract's existing concurrency expectations
apply, so serialization is not an acceptable simplification. Destroy
racing command startup resolves deterministically: queued commands that
never started settle as failed without starting, and no command remains
indefinitely pending or escapes cleanup.

Required behaviors:

| Event | Required behavior |
|---|---|
| One command is cancelled | Stop that command; keep the sandbox alive if healthy |
| Command reaches its wall-clock timeout | Terminate that command, report timeout, retain sandbox usability when possible |
| Sandbox is destroyed during execution | Reject new work, stop the guest, settle every outstanding execution |
| Guest agent becomes silent | Treat the execution as failed, not successful |
| VMM exits unexpectedly | Mark the sandbox unhealthy; do not silently restart and continue with lost state |
| Destroy races with command startup | No command may escape cleanup or remain indefinitely pending |
| Cancellation races with normal exit | Produce one terminal outcome; never emit contradictory terminal events |

The wall-clock deadline is owned by a host-side monotonic timer from
exec acceptance, covering agent startup and protocol delays exactly as
spawn time counts against the deadline on process drivers. A VMM death
settles outstanding executions as failed with an infrastructure cause
(distinct from workload failure under the existing error model), and
only destroy is valid on that sandbox afterwards.

## 13. Deferred design tracks (track 1 decided in section 14, rest open)

The deeper review surfaced six further tracks. Track 1 reached a
decision, recorded in section 14; tracks 2 through 6 remain open, in
this order, with no design decisions recorded for them yet:

1. Guest protocol contract: decided in section 14 (framing, versioning,
   identity and dedup, ordering barrier, cancellation wire behavior,
   disconnect recovery, memory budget).
2. Resource control mapping: decided in section 15 (layer split,
   cgroup accounting, aggregate memory policy, transfer-boundary quota,
   honest quota-override rejection).
3. Filesystem transfer invariants: containment on both boundaries,
   symlink races, partial transfers, size bounds, atomic completion.
4. Asset manifest completion: provenance, checksums, licenses, and
   compatibility before any artifact source is chosen.
5. Failure and capability states for unavailable agents, crashed VMMs,
   and unestablished guarantees.
6. Test matrix: ordinary contract tests kept distinct from tests that
   require a real KVM host.

Section 9 stands unchanged: none of this work alters the public spec,
any SDK, or the infrastructure gate.

## 14. Guest-agent protocol (decided 2026-10-14)

Design decision only. No implementation, provisioning, SDK contract
change, capability promotion, or P1 movement. Real-VM conformance is not
established by this section. All numeric bounds below are provisional
design defaults, unvalidated until measured on a real KVM host.

### Transport and session

The agent dials out to the host (host CID 2, well-known port); the host
cannot dial into the guest. The host issues an epoch token in
`HELLO_ACK`; every frame on every connection carries it, and
prior-epoch frames are rejected outright. Session state dies with the
session. On disconnect the agent terminates and reaps that session's
commands; the host settles old-session executions as failed regardless,
so host settlement never depends on agent proof. Reconnect
re-handshakes from `HELLO`; commands are never resumed across sessions.

### Handshake and versioning

`HELLO {protocol_version, agent_version}`, then `HELLO_ACK` or explicit
`REJECT`, then `READY`. Init completes only at `READY`, within an
absolute init deadline. Protocol versioning is independent of SDK
versions, starting at 1, with exact major match required. Unknown
message types are ignored with a logged warning, preserving forward
compatibility for future minor versions. Corrupt framing (bad length,
truncated header, invalid control JSON, oversize frames) closes the
session and fails all nonterminal executions without overwriting
terminal results.

### Framing and channels

Frames carry a 4-byte big-endian length of type plus payload, then a
1-byte type, then the payload. One control connection per session
carries JSON control frames only, maximum 16 MiB including type and
payload. One data connection per execution carries both stdout and
stderr as raw bytes after a `BIND {epoch, id, stream}` frame; unknown
bindings are closed. Data frames max 64 KiB including type and payload;
a larger data frame is rejected as malformed even though below the
general limit. Length is validated before allocation, with one
in-progress frame per connection at its channel cap.

### Control independence

The agent must service the control connection independently of bulk
writes, through nonblocking I/O with an event loop or per-execution
writer tasks separate from the control loop. Application spooling is
bounded (1 MiB per stream, provisional); beyond it a writer blocks its
own task only. Cancellation preempts a blocked writer by closing its
data connection and terminating the command. Conformance requires a
stalled data consumer to leave cancel processing within deadline while
a second execution proceeds unaffected.

### Execution identity and dedup

The host generates every execution ID plus a per-session monotonic
sequence number. The guest holds a fixed slab of 4096 slots of 128
bytes; a slot is claimed at `START` acceptance and transitions active
to terminal in place. Each record holds session sequence (`u32`),
bounded ID bytes (max 64), status (`u8`), exit code (`i32`), and
per-stream final sequence plus totals (`u64` pairs), totaling 105 bytes
logical against the 128-byte encoded cap. Duplicate `START` for an
active ID re-acknowledges current state; for a terminal ID it replays
the full stored outcome (status, code, totals). New `START` beyond the
cap is rejected with `SESSION_FULL` as honest failure. The host
re-sends `START` only when it received no response and only within the
same session; cross-session retry is prohibited with enforcement at the
host. Sessions past the cap drain normally; further work needs destroy
and recreate, since automatic rotation is deferred.

### Ordering, completion, and retention

Per-stream sequence numbers with independent spaces. `EXIT` carries
per-stream byte totals and final sequence numbers, where totals mean
bytes successfully written by the agent, including bytes the host later
discards through retention: truncation is a host retention policy,
never transport loss. The host completion barrier compares received
counts against totals; mismatch, gaps, or duplicates fail closed as
infrastructure failure. A replayed terminal outcome supplies
expectations only and never recovers missing bytes.

### Cancellation and failure

First terminal outcome per execution wins; `CANCEL_ACK` in-progress is
not confirmation; settlement occurs only on a valid terminal event or
confirmed whole-guest termination. Cancel deadline expiry falls back to
VMM termination: all running executions settle consistently as failed
with infrastructure cause, the sandbox is marked unhealthy, and only
destroy is valid afterwards. Cancel-after-terminal is a no-op;
cancellation is idempotent. The wall-clock deadline is host-side
monotonic from exec acceptance, covering startup and protocol delays;
timeout reports -1 and signal deaths map to 128 plus signum from raw
wait status at the host. Vsock close mid-command fails affected
executions, never exit zero; heartbeats bound silence detection with
the deadline resetting on any valid frame, and backoff never extends
failed deadlines.

### Stdin and transfers

`stdin` crosses inline in `START`, base64-encoded, with the ceiling
defined in decoded input bytes (1 MiB, provisional) and explicit
rejection above, so encoding overhead never moves the contract.
Streaming stdin is deferred. The `TRANSFER_*` message range is reserved
for track 3; nothing about transfers is decided here.

### Memory budget (host-side configured protocol budget)

| Term | Bound | Basis |
|---|---|---|
| Application spool | 64 MiB | 32 concurrent executions × 2 streams × 1 MiB, lazy, budget-enforced |
| Data reassembly | 2 MiB | 32 connections × 64 KiB, one partial frame each |
| Control reassembly | 16 MiB | 1 connection × 16 MiB, one partial frame |
| Host socket buffers | 16.5 MiB | 33 connections × 256 KiB × send and receive, configured |
| Terminal slab | 0.5 MiB | 4096 × 128 B fixed slab |
| Fixed overhead allowance | 64 KiB | Control state (epoch token, handshake state, connection table, slab bitmap) plus all framing prefixes (33 × 4 B) |

The listed components sum to 99 MiB; the 64 KiB allowance brings the
configured-budget total to 99.0625 MiB, reported as a 100 MiB
conservative ceiling. This arithmetic is a configured-budget model, not
a resident-memory measurement: kernels may report less, and the figure
covers only the host side. Guest-endpoint socket memory uses identical
configured values but is accounted by the guest kernel and stated
alongside, outside the host figure. The allowance is a defensible
design bound provided the implementation later verifies that all
protocol-owned allocations fit within it.

### Open questions carried

Minor-version required semantics; all numeric defaults above;
each unvalidated until real-VM testing.

## 15. Resource semantics (decided 2026-10-14)

Design decision only. No implementation, provisioning, SDK contract
change, capability promotion, or P1 movement. Real-VM conformance is not
established by this section. All numeric bounds below are provisional
design defaults, unvalidated until measured on a real KVM host.

### Layer split

Two enforcement layers, never conflated. The host layer (outside the
guest) owns wall-clock deadlines, VMM process throttling via host
cgroups, static VM sizing, and VMM kill; it sees the guest only as one
process tree and cannot attribute CPU or memory to individual commands.
The guest layer (inside the guest, via the agent) owns per-command
accounting and enforcement. Anything the host cannot see is
agent-enforced; anything the agent cannot isolate is host-sized.

### Wall-clock timeout

Host-side monotonic timer from exec acceptance, covering agent startup
and protocol delays. Expiry cancels through the control channel with
VMM termination as backstop. Fully enforceable per execution.

### CPU time budget (kill on breach)

Authoritative measurement is the per-command guest cgroup's cumulative
CPU accounting (`cpu.stat`), which follows descendants by membership
instead of PID discovery; `/proc` tree-walking is at most a fallback,
never the foundation. Enforcement loop interval is provisional (100 ms
proposed, unvalidated). Breach kills the cgroup's contents and reports
`ERR_CPU_EXCEEDED`. Missing accounting fails closed with `EXEC_FAILED`
rather than running unenforced under a true `cpuLimits` flag.

Overshoot residual: enforcement latency is at least one polling
interval plus enforcement and scheduling delay (agent stalls, delayed
cgroup reads). No exact bound is claimed. Real-VM tests measure
observed overshoot rather than assuming it.

Fallback termination drains the cgroup until empty: read the member
set, kill, repeat. A single process-list snapshot is insufficient
because descendants can fork mid-termination. Bounded rounds apply; if
the set never empties, settle the execution as infrastructure failure
and mark the sandbox unhealthy rather than leaving unkillable work
behind.

### CPU quota (throttle, never kill)

Firecracker expresses no fractional vCPU rate cap, so quota maps to a
host cgroup rate cap applied to the VMM process tree, with `vcpu_count`
kept as a separate static sizing knob. Throttle-never-kill semantics
hold exactly; the kill path is never involved. A separately configured
wall-clock timeout can still terminate a throttled command, and timeout
values under quota must be sized with throttling in mind.

Per-execution `cpuQuota` overrides that cannot be honored are rejected
honestly with `EXEC_FAILED`, reusing the existing apply-failure code
path. Silent acceptance under a true `cpuQuotaLimits` flag is the least
honest option and is not used. Open compatibility item, recorded
without changing the schema: `exec.schema.json` describes the per-exec
override as working, a description written against backends where the
true flag implies the override dance. F4 documents the deviation as
backend-specific pending spec clarification or future per-exec
granularity.

### Memory: per-execution ceilings plus aggregate policy

Each command tree gets its own guest cgroup with a memory ceiling.
Breach confirmed by that cgroup's `memory.events` `oom_kill` delta maps
to `ERR_OOM_EXCEEDED`. The agent runs outside workload cgroups with
minimum OOM score plus reserved headroom accounted in VM sizing; this
reduces but cannot guarantee agent survival. If the guest-global OOM
killer takes a different process, or counters leave the victim
ambiguous, the result stays infrastructure failure. If the agent
disappears, non-terminal executions become infrastructure failures
while already-terminal results stand under first-terminal-wins.

Per-exec ceilings may sum past guest RAM (oversubscription allowed and
documented). Sizing guidance, not enforcement: size guest RAM at or
above expected concurrent ceilings plus agent and kernel headroom.
Sandbox-wide bound comes from static `mem_size_mib` at boot. Limits
describe guest-visible memory; host VMM overhead is backend overhead
excluded from limit accounting.

### Disk quota at the transfer boundary

Guest-local writes are ephemeral and outside the host workspace quota;
guest child processes writing to guest-local scratch are not
automatically visible to the host, and visibility begins only at
explicit transfer. Transfers into the workspace pass host-side quota
enforcement before the write is committed; only materialized files are
visible through `downloadFile`. Failed or over-quota transfers leave no
partially committed workspace state, matching the reference backend's
existing rollback behavior on quota breach.

### Concurrency and capabilities

Per-execution cgroup isolation holds within the 32-concurrent-execution
session bound; static VM sizing is shared. Each capability flips only
on real-VM tests: `cpuLimits` on tested budget enforcement,
`memoryLimits` on tested ceilings plus OOM attribution,
`cpuQuotaLimits` on tested host-cgroup throttling with the documented
sandbox granularity and honest-rejection semantics. No new capability
is proposed.
