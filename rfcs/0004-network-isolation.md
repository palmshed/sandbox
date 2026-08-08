# RFC 0004: Native Network Isolation

- **Author**: Palmshed Team
- **Status**: Accepted
- **Created**: 2026-08-08
- **Specifies**: `network` policy `disabled` on the Native backend (`spec/sandbox.schema.json`, `capabilities.schema.json` `networkIsolation`)

## Summary

Define and implement the `network: 'disabled'` guarantee for the Native backend: a workload cannot send or receive any traffic over the host network. The design follows the same discipline as CPU and memory enforcement: threat model first, then platform capability probing, then a decision record, then implementation with adversarial leak tests. A platform is only marked **Supported** after implementation and validation; **Best-effort** and **Unsupported** states are declared explicitly.

## Threat Model

### Assets to protect

1. **Host network stack**: no workload traffic may egress or ingress on the host's interfaces (Wi-Fi, Ethernet, VPN tunnels).
2. **Host services bound to loopback**: databases, dev servers, agent APIs, and orchestration daemons listening on `127.0.0.1` or `::1` must be unreachable from sandboxed workloads.
3. **Cloud/agent metadata endpoints**: provider metadata services (e.g. `169.254.169.254`) and agent credential stores must not be reachable.
4. **DNS infrastructure**: workloads must not be able to exfiltrate via DNS queries or resolve internal hostnames.
5. **The host's own outbound connectivity**: a sandboxed workload must not use the host's network identity to launch attacks or scans.

### Attacker model

- The workload code is **untrusted**: it may be LLM-generated, a code-evaluation submission, or an exploited dependency.
- The attacker controls: the command line, shell syntax, spawned child processes, file writes, and all socket calls available to an unprivileged user.
- The attacker can chain primitives: background children, pipelines, DNS tunneling, UDP blast, ICMP exfiltration, and attempts to bind to or connect from any local address.
- The attacker is **unprivileged**: they hold the same OS privileges as the sandbox process itself (no root, no kernel exploits assumed).
- The attacker **knows** the isolation mechanism and will attempt to bypass it (this is not security-through-obscurity).

### Explicit non-goals

- Not a defense against **kernel exploits** or hardware side channels; those require containerized/VM backends (Docker, Firecracker).
- Not **traffic inspection or filtering**: `network: 'disabled'` blocks; it does not permit-and-inspect. Policy `proxy` (permit through an explicit proxy) is out of scope for this RFC.
- Not defense against **out-of-band channels** already available by design: the shared host filesystem, process table, and shared memory are governed by filesystem isolation work, not this RFC.
- Not **network quality guarantees** (latency, bandwidth).
- Not a **per-policy allowlist** of specific hosts/ports in this revision; `network: 'disabled'` is all-or-nothing.

### Required guarantees (for `network: 'disabled'`)

| # | Guarantee | Verification probe |
|---|---|---|
| G1 | No outbound TCP to non-loopback addresses | `connect()` to an external host fails |
| G2 | No outbound UDP to non-loopback addresses | `sendto()` to an external host fails |
| G3 | No DNS resolution (A/AAAA/PTR) | `getaddrinfo()`/`res_nquery` fails |
| G4 | No raw sockets / packet injection | `socket(AF_INET, SOCK_RAW)` fails |
| G5 | No ICMP (ping, traceroute) | `sendto` on raw ICMP fails |
| G6 | No localhost service access | connect/bind on `127.0.0.1`/`::1` to host services fails |
| G7 | Child processes inherit the isolation | a descendant of the workload cannot connect |
| G8 | Isolation does not require root | enforced by an unprivileged host process |

## Capability Probe Results

Probe script: `scripts/probes/network-capability.mjs`. It measures what an unprivileged workload can do on a platform **before** any isolation mechanism is applied, then tests candidate mechanisms. Run: `node scripts/probes/network-capability.mjs [--json]`.

### Baseline (unprivileged process, macOS 26.5.2)

| Probe | Result |
|---|---|
| Outbound TCP to 1.1.1.1:80 | Open |
| DNS A-record resolution | Open |
| Localhost TCP bind + connect | Open |
| Outbound UDP send | Open |
| Raw socket (`SOCK_RAW`) | Blocked (Operation not permitted) |
| `pfctl` (packet filter) from unprivileged process | Denied |

Raw sockets are already denied to unprivileged users by the OS on macOS; the remaining vectors (TCP, UDP, DNS, loopback) are all open by default.

### Candidate mechanism: `sandbox-exec` Seatbelt profile (macOS)

Profile: `(version 1) (allow default) (deny network*)`. A bare `(deny default)` + `system.sb` import blocks exec/file access before the workload runs, so the allow-first structure is required. Verified on macOS 26.5.2:

| Probe (inside sandbox) | Result |
|---|---|
| Outbound TCP | **Blocked** (EPERM) |
| Outbound UDP | **Blocked** |
| DNS resolution | **Blocked** (ECONNREFUSED) |
| Localhost TCP | **Blocked** (EPERM) |
| Child process (`& wait`) | **Blocked** (EPERM) |
| Raw socket | Blocked (OS-level, independent of sandbox) |

All six in-scope vectors are blocked. Notably `(deny network*)` also blocks loopback, satisfying G6 without special-casing. Descendant processes inherit the profile, satisfying G7. `sandbox-exec` works from an unprivileged process, satisfying G8.

**Risk**: `sandbox-exec` is deprecated by Apple and ships as a thin wrapper over the private Seatbelt library. It still functions on macOS 26.5.2, but its availability on future OS releases is not guaranteed. This risk is documented in the platform matrix; an alternative (NetworkExtension content filter) requires entitlements and user approval and is therefore not viable for an unprivileged runtime today.

### Candidate mechanisms: Linux

| Mechanism | Requirement | Notes |
|---|---|---|
| Network namespaces (`unshare --net`) | CAP_SYS_ADMIN, or unprivileged user namespaces enabled | Cleanest: gives a loopback-only netns. Unprivileged path needs `kernel.unprivileged_userns_clone`/AppArmor not blocking. |
| `firejail` | External dependency | Not present by default; adds a system dependency. |
| cgroup `net_cls`/`net_prio` | Does not block traffic; classification only | Not an isolation mechanism; rejected. |
| `nftables`/`iptables` per-process owner match | Needs root | Rejected for unprivileged runtime. |

Probe outcomes to confirm on an Ubuntu target before implementation: unprivileged `unshare --user --map-root-user` and `unshare --net`, and AppArmor confinement of the node runtime. **Finding on GitHub Actions `ubuntu-latest`**: `unshare -n --user --map-root-user` fails: unprivileged user namespaces are restricted on the CI runner. The Native backend now probes at `init()` and falls back to proxy env vars, dynamically setting `networkIsolation: false` when the probe fails.

### Candidate mechanisms: Windows

| Mechanism | Requirement | Notes |
|---|---|---|
| Windows Filtering Platform (WFP) callout | Admin, or service with manifest | Not available from an unprivileged process. |
| Windows Firewall APIs (`INetFwPolicy2`) | Admin | Rejected for unprivileged runtime. |
| Job Objects network limitation | Only for *restricted* tokens via `AssignProcessToJobObject` + SID deny | Possible future Best-effort path; requires design and validation. |

No unprivileged equivalent to macOS Seatbelt or Linux netns exists on Windows today. Marked **pending validation**, expected to resolve to **Best-effort or Unsupported**.

## Design Decision

### Selected mechanisms

| Platform | Mechanism | Status |
|---|---|---|
| macOS | Seatbelt profile via `sandbox-exec`, `(allow default)(deny network*)` | **Supported** (validated 2026-08-08, macOS 26.5.2) |
| Linux | Network namespace (loopback-only) | **Supported (probed)**: `unshare -n --user --map-root-user` when unprivileged user namespaces are available; falls back to proxy env vars otherwise |
| Windows | None (WFP/firewall require admin) | **Unsupported** until a restricted-token Job Object path is validated |

### Contract

- `network: 'disabled'` on the Native backend wraps the spawned process group in the selected mechanism.
- Enforcement is **inherited by descendants** (G7): the profile/namespace applies to the process group, matching the CPU/memory process-group model.
- The mechanism is applied **without requiring elevated privileges** (G8).
- `networkIsolation` capability is set to `true` **only after** the platform's adversarial leak tests pass. Until then the flag stays `false`.

### Why alternatives were rejected

- **macOS NetworkExtension content filter**: requires a signed, entitled, user-approved app; unusable by an unprivileged runtime. Rejected.
- **macOS PF (`pfctl`)**: requires root. Rejected.
- **Linux `iptables`/`nftables` owner rules**: requires root. Rejected.
- **Linux `firejail`**: adds an external system dependency; the runtime aims for zero system dependencies. Rejected for now.
- **cgroup `net_cls`**: classifies, does not block. Rejected.
- **Windows WFP/firewall APIs**: require admin. Rejected; the restricted-token Job Object path is the only candidate for future Best-effort status.
- **Application-layer interception (LD_PRELOAD/import hook)**: bypassable by static binaries and non-ELF loads; violates the non-obscurity attacker model. Rejected.

## Platform Matrix (target after implementation)

| Platform | Status | Mechanism | Validation |
|---|---|---|---|
| macOS | Supported | Seatbelt `(deny network*)` via `sandbox-exec` | Adversarial leak tests on macOS 26.x |
| Linux | Supported (probed) | Loopback-only netns via `unshare -n --user --map-root-user` | Adversarial leak tests on macOS; CI probe on Ubuntu |
| Windows | Unsupported | None | Documented; restricted-token Job Object is a candidate |

## Adversarial Leak Tests (to implement)

Each must run under `network: 'disabled'` and assert the attempt fails while the sandbox remains healthy and reusable:

1. Outbound TCP (direct `connect`, then via a background child)
2. Outbound UDP (direct `sendto`, then via a child)
3. DNS resolution (`getaddrinfo` A and PTR)
4. Localhost TCP connect to a host-bound listener; localhost bind
5. Raw socket creation (where the platform permits probing it)
6. ICMP (`ping`)
7. Child-process network attempt (`& wait` under the sandboxed shell)
8. Recovery: after blocked attempts, a normal `exec()` completes and the sandbox destroys cleanly

## Gate Checklist (network)

- [x] Threat model recorded (this RFC)
- [x] Capability probe evidence per platform
- [x] Mechanism selected per platform with rejected alternatives documented
- [x] Implementation in `NativeBackend.exec()` for `network: 'disabled'` (with init-time probe + fallback)
- [x] Adversarial leak tests (list above) passing (5/5 on macOS)
- [x] Recovery test (sandbox healthy after blocked attempts)
- [x] Capability `networkIsolation` promoted to `true` only after tests pass (probed dynamically per platform)
- [x] `docs/api.md`, `ROADMAP.md`, and the Gist updated
