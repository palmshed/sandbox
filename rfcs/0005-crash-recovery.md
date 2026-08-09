# RFC 0005: Crash Recovery

- **Author**: Palmshed Team
- **Status**: Accepted
- **Created**: 2026-08-09
- **Specifies**: Native backend lifecycle guarantees: cleanup after host-process crash or unexpected backend disconnection (`ROADMAP.md` Phase 6, issue `#10`)

## Summary

Define and implement the crash-recovery guarantee for the Native backend: when the host process running the SDK dies unexpectedly (crash, `SIGKILL`, OOM-killer, power loss) or a sandbox is abandoned mid-execution, the sandbox's workload processes are terminated and its temporary directories are eventually removed, without any manual intervention and without ever corrupting a live sandbox owned by a still-running host. The design follows the same discipline as network isolation (RFC 0004): a failure model first, then a decision record, then implementation with cross-platform failure/recovery tests. This RFC deliberately excludes OS-level filesystem isolation (issue `#3`).

## Failure Model

### What "crash recovery" means here

The SDK is an in-process library: sandboxes, process groups, and temp directories are owned by the host process. When that process dies, **no library code runs**. There is no daemon watching over the workload. Crash recovery therefore has two distinct phases:

1. **In-process (graceful)**: the host receives a terminal but catchable event (`SIGTERM`, `SIGINT`, `SIGHUP`, uncaught exception, unhandled rejection, normal exit while sandboxes are live). The library must run its normal `destroy()` path for every live sandbox: kill workload process groups and remove temp directories.
2. **Cross-process (post-mortem)**: the host dies without running any cleanup (`SIGKILL`, `SIGSEGV`, kernel OOM-kill, power loss). No code in the dead host runs. The next sandbox creation on the same machine must detect the abandoned sandbox (by its recorded metadata), terminate any surviving workload processes, and remove the temp directory.

### Assets to protect

1. **Host process table**: a crashed host must not leave runaway workload processes (LLM-generated code, CI builds, long-running eval jobs) consuming CPU/memory indefinitely.
2. **Host temp storage**: abandoned `palmshed-sandbox-*` directories must not accumulate across crashes (each carries a full virtual workspace).
3. **Live sandboxes**: a reaper must never kill or delete a sandbox whose host process is still alive (recovery must not corrupt reusable sandboxes).
4. **Reusability after recovery**: a reaped sandbox must be fully removed and must never be reused by a new host as if it were a fresh workspace.

### Attacker model

- The workload is **untrusted** (the same code from RFC 0004). It may fork background children, detach from the process group, or try to survive the parent.
- The attacker does **not** control the host crash itself in the crash-recovery threat model; the crash is an accident. What matters is that crash recovery behaves correctly even when the workload is deliberately trying to outlive its host (background jobs, `nohup`, `setsid`, double-forking).

### Explicit non-goals

- **Immediate cleanup at the instant of a hard crash**: without a persistent out-of-process daemon, a `SIGKILL`ed host cannot clean up synchronously. Cleanup is eventual, on the next sandbox creation. (A daemon-based model was rejected; see Design Decision.)
- **Not a general supervisor**: crash recovery does not restart crashed workloads or backends; it only contains the blast radius.
- **Not a defense against a malicious host process**: a hostile host can simply kill workload processes itself or leave junk in `/tmp` by design; recovery is best-effort hygiene against accidents, not an integrity boundary.
- **Not filesystem isolation** (issue `#3`): crash recovery reaps abandoned sandboxes; it does not confine a live sandbox to a namespace/chroot.
- **Not data preservation**: abandoned sandbox contents are destroyed, not quarantined or journaled.

### Required guarantees (for the Native backend)

| # | Guarantee | Verification probe |
|---|---|---|
| G1 | Graceful host shutdown cleans up all live sandboxes | send `SIGTERM`/`SIGINT` to a host with an active workload; workload process group gone and temp dir removed |
| G2 | A hard host crash does not leak the workload forever | `SIGKILL` a host with an active background workload; on next sandbox creation the workload process is terminated and the temp dir removed |
| G3 | Orphaned workloads cannot escape reaping via backgrounding | workload uses `nohup`/`&`/double-fork; still reaped (Linux/macOS process-group kill, Windows tree kill) |
| G4 | Recovery never touches a live sandbox | create a sandbox, record metadata; run the reaper in a second host; live sandbox survives intact and reusable |
| G5 | PID reuse cannot cause false reaping | reaper verifies host PID **and** host process start-time token before reaping |
| G6 | Reaped sandboxes are never resurrected | after reaping, the temp dir is gone and a new sandbox creates a fresh dir |
| G7 | Recovery does not require elevated privileges | reaper runs as the same unprivileged user as the crashed host |
| G8 | Reusable sandboxes remain healthy after a reaper pass | after any reaper run, `exec()` still works and `destroy()` still succeeds |

## Design Decision

### Selected mechanisms

| Mechanism | Purpose |
|---|---|
| In-process exit/signal hooks (`SIGTERM`, `SIGINT`, `SIGHUP`, `uncaughtException`, `unhandledRejection`, `exit`) | G1: run the normal destroy path on graceful terminal events |
| Per-sandbox metadata file inside the temp dir | G4/G5: record `hostPid`, host process start-time token, and workload process-group id(s) so the reaper can identify ownership unambiguously |
| Stale-sandbox sweep at `init()`/first sandbox creation | G2/G3/G6: scan `os.tmpdir()/palmshed-sandbox-*`; for each, if the recorded host is dead or the start token mismatches, kill the recorded process groups and remove the directory |

### Metadata file contract

Each sandbox temp dir contains `palmshed.meta.json` with:

- `hostPid`: PID of the host process that created the sandbox.
- `hostStart`: process start-time token of the host (Linux: `/proc/<pid>/stat` field 22 starttime; macOS: `ps -o lstart= -p <pid>`; Windows: best-effort via process creation time). Combined with `hostPid`, this distinguishes a live host from a recycled PID.
- `pgids`: process-group IDs of workloads currently/ever spawned by this sandbox, appended on `exec()`. On reaping, each `pgid` is killed (`kill(-pgid, SIGKILL)` on POSIX, `taskkill /T /F` on Windows).
- `createdAt`: ISO timestamp for diagnostics and for bounded retention.

### Stale-sandbox reaper algorithm

On `init()` (and on every `create()`), after creating the new sandbox:

1. List `os.tmpdir()` entries matching `palmshed-sandbox-*`.
2. Skip the directory just created by this host (it is live).
3. For each candidate, read `palmshed.meta.json`. If missing/unreadable, treat as stale only if the directory is older than a conservative grace period (avoids racing a host that just created the dir and has not yet written metadata).
4. If `hostPid` is alive **and** `hostStart` matches the current start token of that PID, skip (live sandbox, G4).
5. Otherwise reap: kill each recorded `pgid` (best-effort), then remove the directory recursively (G6).
6. Log a `backend.reap` debug event with the number of reaped sandboxes.

PID-reuse safety (G5): the start-time token is read from the OS, not from the metadata author's memory. A recycled PID whose start time differs from the token is treated as dead.

### Why alternatives were rejected

- **Out-of-process supervisor daemon**: a persistent daemon (or `systemd`/LaunchAgent helper) watching host PIDs would give near-immediate cleanup, but adds a system dependency, lifecycle management, privilege questions, and a second crash domain. The zero-dependency, per-sandbox reaper delivers the guarantee with no new deploy surface. Rejected for this revision.
- **`prctl(PR_SET_PDEATHSIG)` / parent-death polling inside the workload**: the workload is untrusted and its shell chain can discard or bypass a helper; enforcing it would require a shim around every child, which the workload can kill. Rejected; process-group kill from the reaper is authoritative and does not depend on workload cooperation.
- **Reaping at random intervals**: without a daemon there is no scheduler; tying the reaper to sandbox creation gives a deterministic trigger with zero background cost.
- **Lock files (flock)**: PID + start token already identify ownership unambiguously and are simpler than coordinating advisory locks across hosts. Rejected for this revision.

## Platform Matrix (target after implementation)

| Platform | In-process cleanup | Cross-process reaping | PID-liveness check | Notes |
|---|---|---|---|---|
| Linux | Supported (signals + exit hooks) | Supported (`kill(-pgid)`, `/proc` start token) | `/proc/<pid>/stat` | Full guarantee |
| macOS | Supported | Supported (`kill(-pgid)`, `ps lstart`) | `ps -o lstart= -p <pid>` | Full guarantee |
| Windows | Supported (best-effort; no `SIGHUP`) | Supported (`taskkill /T /F` tree kill) | process creation time via `tasklist`/WMI | No POSIX process groups; tree kill by root PID; start-time token best-effort |

## Failure / Recovery Tests (to implement)

1. **Graceful shutdown (G1)**: host spawns workload, receives `SIGTERM`, exits; assert workload gone and dir removed. macOS/Linux.
2. **Hard crash (G2)**: host with active background workload is `SIGKILL`ed; a second host creates a sandbox; assert workload process gone and dir removed.
3. **Escape attempt (G3)**: workload uses `nohup` and double-fork; still reaped.
4. **Live-sandbox immunity (G4)**: two hosts; reaper in host B must not reap host A's live sandbox.
5. **PID-reuse safety (G5)**: simulate by rewriting metadata with a bogus start token; sandbox is reaped only when token mismatches the (live) PID.
6. **No resurrection (G6)**: reaped dir absent; fresh sandbox gets a new dir.
7. **Privilege (G7)**: whole suite runs unprivileged.
8. **Reusability (G8)**: after reaper passes, normal `exec()`/`destroy()` still work.
9. **Realistic scenarios**: AI-agent runner and CI-runner hosts crashing mid-execution (see Phase 6).
10. **Repro lab**: `repro/crash/*` standalone repros wired into `repro/run.js` (hard-crash repro auto-skips on Windows if `taskkill` semantics cannot be validated in the CI environment).

## Gate Checklist (crash recovery)

- [ ] Threat model recorded (this RFC)
- [ ] Metadata contract implemented and written on sandbox creation
- [ ] In-process graceful cleanup hooks (G1)
- [ ] Stale-sandbox reaper with PID + start-token verification (G2-G5)
- [ ] Failure/recovery tests above passing on Linux and macOS; Windows covered as far as `taskkill` allows
- [ ] Repro lab entries (`repro/crash/`) present and green
- [ ] `docs/api.md`, `ROADMAP.md` (Phase 6 closeout), and the Gist updated
