# RFC 0012: Firecracker Backend Feasibility and Architecture Gate (F4)

- **Status**: Accepted as the F4 Phase 1 gate. No implementation yet.
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
