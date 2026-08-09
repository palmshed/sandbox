# RFC 0006: OS-Level Filesystem Isolation

- **Author**: Palmshed Team
- **Status**: Draft (awaiting implementation validation)
- **Created**: 2026-08-09
- **Specifies**: new capability `osFilesystemIsolation` (`spec/capabilities.schema.json`); interacts with the existing VFS boundary (RFC 0003) and `network: 'disabled'` (RFC 0004)

## Summary

Define what "host filesystem isolation" means for the Native backend: a workload cannot read or write anything on the host filesystem except its own sandbox workspace and the minimal read-only runtime paths it needs to execute. This is a different guarantee from the VFS boundary in RFC 0003 (which isolates the *sandbox API surface* from the workload) and from network isolation in RFC 0004 (which blocks sockets). This RFC records the threat model, the precise guarantee, the escape cases we must prevent, a new capability flag distinct from `filesystem`, a per-platform mechanism strategy, and the adversarial test plan. **No implementation is proposed here; implementation starts after this design is accepted and validated per-platform**, following the same discipline used for RFC 0004 (threat model first, probe evidence, selected mechanism, adversarial tests, then capability promotion).

## Threat Model

### Assets to protect

1. **User secrets outside the workspace**: SSH keys (`~/.ssh`), shell history, `.aws/.gcloud/.npmrc` credentials, browser/keyring data, dotfiles, and any other host file reachable by the unprivileged host user.
2. **System files**: `/etc`, `/etc/passwd`, `/etc/shadow` (where world-readable), crontabs, `/var`, bootloader config, and anything a read or write could damage or exfiltrate.
3. **Other projects and repositories** on disk: a workload given one workspace must not read or modify sibling directories belonging to other tenants of the same host account.
4. **The sandbox workspace itself**: the workload's own workspace is the only path hierarchy it may freely use; the workspace must not double as a host-accessible zone that leaks into the same physical paths used by the host process.
5. **Proc/sys surfaces where applicable**: `/proc` and `/sys` can expose process memory maps, environment/argv of other processes, kernel parameters, and device nodes. Where the platform mechanism can restrain them, it should; where it cannot, the residual access is declared.

### Attacker model

- The workload code is **untrusted**: LLM-generated, a code-evaluation submission, or an exploited dependency.
- The attacker controls the command line, shell syntax, spawned child processes, symlink/hardlink creation, and every filesystem syscall their privileges allow.
- The attacker is **unprivileged**: same OS user as the sandbox process; no root, no kernel exploits, no setuid escalation assumed.
- The attacker **knows the isolation mechanism** and attempts to bypass it; this is not security-through-obscurity.
- The attacker may chain primitives: create a symlink in the workspace pointing at `/etc/shadow`, spawn a subprocess with inherited file descriptors, or abuse `/proc/self/fd`.

### Explicit non-goals

- Not a defense against **kernel exploits**, device-node attacks requiring privileged caps, or hardware side channels; those require the Docker/Firecracker backends.
- Not **full yet-another-OS**: the workload still runs as the host user with process-, IPC-, and signal-level visibility unless scoped further by separate future work (RFC 0004 covers network; process/IPC scoping is out of scope here).
- Not a **host-filesystem access API**: sandboxes never get opt-in host paths in this revision. `--mount`/bind-style host mounts are a possible future capability, not part of this guarantee.
- Not a promise about **temp-directory hygiene** beyond the sandbox's own workspace, beyond the declarations below.
- Not **encryption or at-rest protection**.

## Guarantee: What "OS-level filesystem isolation" means

The guarantee for a Native sandbox with `osFilesystemIsolation: true` is:

| # | Guarantee | Notes |
|---|---|---|
| G1 | The workload process tree may only **read** files under the sandbox workspace and under an explicit, minimal runtime allowlist (interpreter + shared libraries + loader paths) | Runtime allowlist is read-only; everything else is read-denied |
| G2 | The workload process tree may only **write/create/modify/delete** files under the sandbox workspace | No writes (create, truncate, rename, link, chmod, setxattr) outside it |
| G3 | Execution of files is confined to the workspace and the runtime allowlist | `EXECUTE` is denied everywhere else, closing `exec`-based read gadgets |
| G4 | Symlink and hardlink escapes are denied at the mechanism level | A symlink inside the workspace pointing at a host path cannot be followed out when the target is not granted |
| G5 | Descendant processes inherit the same ruleset | A child spawned by the workload is equally confined |
| G6 | The confinement is **irrevocable** for the lifetime of the process tree | No API inside the sandbox can loosen it once applied |
| G7 | The workspace remains fully read/write/execute for the workload | Normal workloads run unchanged inside it |
| G8 | Isolation is enforced without elevated privileges | No root, no `sudo`, no setuid requirement at runtime |

### What remains accessible (explicitly)

- **The sandbox workspace tree** (full access): read, write, execute, create.
- **A minimal runtime allowlist** (read + execute only, no writes), tailored to the interpreter in use. For the reference SDK's `node`/`sh` workloads on Linux this is typically `/usr/bin` executables needed plus the shared-library directories they resolve (`/usr/lib`, `/lib`, `/lib64` as configured); the precise list is determined by the platform probe, not hardcoded.
- **Open file descriptors inherited across the sandbox boundary**: descriptors the SDK process holds at confinement time remain usable by the confined tree. The SDK must therefore only confine after closing/not-passing anything sensitive. This is both a guarantee and an escape case to manage (E4 below).
- **Everything the OS exposes to an unprivileged process that the chosen mechanism does not cover**: on platforms where `/proc` or `/sys/kernel` cannot be hidden without namespaces, reads there remain possible, and that residual is declared in the platform matrix rather than silently implied.
- **The host's own process/ipc/network picture** except where RFC 0004 (network) and future process-scoping work apply.

### Escape cases we must prevent

| # | Escape | How the mechanism must stop it |
|---|---|---|
| E1 | Direct path access: `cat /etc/shadow`, `head ~/.ssh/id_rsa` | Path-beneath rules deny access outside workspace + runtime allowlist |
| E2 | Symlink escape: `ln -s /etc, write etc/passwd` | Denied-by-default path rules resolve the target and check its grant |
| E3 | Hardlink escape: `link("/host/file", ws/hardlink)` | Hardlink creation requires access rights on both source and target; an ungranted host file cannot be linked |
| E4 | FD inheritance: a workload `exec`s a subprocess that inherits an open host FD and reads it | Confinement is applied before spawning the tree; only workspace/runtime FDs exist to inherit |
| E5 | Proc/fd-walk: `/proc/self/fd/N` pointing at a host file opened before confinement | Same as E4: no outside FDs are held in the tree; declared residual if mechanism cannot hide `/proc` |
| E6 | Parent-directory walk: `../../` relative paths outside the workspace resolved against a host-relative cwd | The sandbox is confined with a fixed workspace root; traversal still lands in a denied subtree |
| E7 | Subprocess escape: `bash -c '...'`, pipelines, `system()` | Ruleset is inherited (G5); every descendant is equally confined |
| E8 | Rename/move gadget: `rename()` a host file into the workspace | Rename requires the same access rights; outside paths are ungranted |
| E9 | Device nodes / `/dev` access where granted by the base OS | Explicitly declared per-platform residual; not a core claim on platforms where `/dev` reads may succeed for the host user |
| E10 | Absolute-path shell access: `shutil.rmtree('/home/other')` etc. | Path rules are path-based; the absolute path resolves outside the grant and is denied |

## Capability Model: `osFilesystemIsolation`

The new capability flag is **distinct from the existing `filesystem` flag** and the two must never be conflated:

- `filesystem` (existing, RFC 0003): the sandbox **API surface** (`readFile`/`writeFile`/`uploadFile`/`downloadFile`/`workDir`) is virtualized and contained to the workspace. It says nothing about what the *executed process* can do on the host OS.
- `osFilesystemIsolation` (new): the **executed process tree** cannot access host filesystem paths beyond its workspace and the runtime allowlist. This is the RFC 0003 "post-v1.0 hardening" item made concrete.

Schema shape (proposal to `spec/capabilities.schema.json`):

```jsonc
{
  "filesystem": {              // existing: VFS API isolation (RFC 0003)
    "type": "boolean"
  },
  "osFilesystemIsolation": {   // new: host-filesystem confinement of the process tree
    "type": "string",
    "enum": ["supported", "unsupported", "unknown"]
  }
}
```

Usage contract:

- **supported**: the backend enforces G1-G8 for the configured runtime on this platform, with the documented residual accesses, and the adversarial tests pass.
- **unsupported**: the backend does not (yet) enforce any host-filesystem confinement; workloads run with the host user's ambient filesystem rights (today's v1.0 behavior). No Silent partial enforcement.
- **unknown**: the platform was not probed (e.g. an exotic kernel or an OS release where the mechanism is untested); callers must treat this as "no guarantee" and not build security policy on it.

The tri-state is intentional just like RFC 0004's probing: we refuse to pretend equivalent isolation exists where it does not. The Docker backend reports `osFilesystemIsolation: unsupported` (its real isolation comes from the container runtime and is governed by backend-parity work, not this flag). The flag must not be marked `supported` until the implementation and integration tests exist, mirroring the existing capability rules.

Fallback behavior contract:

- When `osFilesystemIsolation: unsupported` or `unknown`, the backend behaves exactly as today (ambient filesystem rights) and must say so. No silent downgrade.
- When `supported`, the backend applies the confinement automatically at exec time; there is no per-exec opt-out in this revision (avoiding an "I asked for the secure thing but really I didn't" trap). An opt-in host-mount feature is future work only.

## Platform Strategy

Same discipline as RFC 0004: investigate, probe, then decide. No pretending equivalent isolation exists across platforms.

### Linux: Landlock first

**Primary candidate: Landlock LSM** (kernel 5.13+).

- **Why**: in-kernel, unprivileged, no external daemon, no CAP_SYS_ADMIN, rules are inherited by descendants (G5), irrevocable per process tree (G6), works for `node` and any spawned shell without wrapping (the confinement applies to the process tree the SDK spawns, kernel-enforced for native syscalls, native addons, and static binaries).
- **Enforcement point**: the SDK process would build a Landlock ruleset (allow r/w/x on the workspace, allow read+execute on the runtime allowlist, deny everything else), then apply it via `restrictSelf` at exec time, before spawning the workload tree. On write access, deny by default and grant only the workspace.
- **Precedent**: the `nono`, `island`, and `sandlock` tooling use exactly this pattern under Node/agent runtimes; Landlock ABI 1 already covers read/write/execute/make/remove; ABI 2 adds file-refer (needed for hardlink/rename semantics E3/E8).
- **Probe plan**: determine Landlock ABI availability on the target kernel (`landlock_create_ruleset` version query), confirm the SDK can apply a ruleset to its own process without privileges, and enumerate the runtime allowlist the workload actually needs under `/usr`, `/lib`, `/lib64` (derive from `ldd`/`patchelf`/strace, not guesswork).
- **Residuals to declare**: `/proc` and `/sys` are not hidden (Landlock is path-based, no mount namespace); reads of `/proc/self` and `/sys` remain unless combined with a network/user namespace (a possible later tightening). Also declare that rules apply per path, not per inode after open; a workload that opened a host file *before* confinement via an inherited FD is covered by E4 management, not by Landlock.

**Rejected alternatives (Linux)**:

- **chroot**: requires root (or a user namespace to fake it), and chroot is bypassable by a process that holds an open FD to a directory outside. Rejected for an unprivileged runtime.
- **Mount namespaces + bind mount**: requires CAP_SYS_ADMIN or unprivileged user namespaces (which are restricted on many CI hosts; RFC 0004 measured this); heavier and changes the filesystem picture for the SDK host. Rejected for v1 of this feature; possible later as a `chroot`-equivalent upgrade.
- **seccomp alone**: filters syscalls, not paths; cannot express "deny `/etc`". Rejected as the mechanism (could be a defense-in-depth layer later).
- **`firejail`**: external system dependency; the runtime targets zero system dependencies. Rejected for now (matches RFC 0004).

### macOS: Seatbelt (feasibility evaluation)

**Candidate: Seatbelt profile via `sandbox-exec`** (the same mechanism RFC 0004 already proven for network isolation).

- **Feasibility**: Seatbelt supports filesystem filters (`(deny file-read*)` / `(allow file-read* (subpath "/usr"))` etc.), which is exactly the allowlist/denylist structure we need for G1-G3. It is applied per-process, inherited by descendants, and unprivileged.
- **Precedent**: RFC 0004 already uses `sandbox-exec` in production for `network: 'disabled'`; applying a filesystem profile is the same API. The `nono` tooling uses Seatbelt for macOS filesystem sandboxing.
- **Caveats/risks**: `sandbox-exec` is deprecated by Apple and could break on a future macOS; Seatbelt profiles are additive and a `(deny default)` profile must still allow the essential exec/read paths for the runtime allowlist. The macOS filesystem rules cannot hide `/proc` (no `/proc` on macOS) but `/dev` and other pseudo-filesystems are accessible to the host user; declared residual.
- **Decision gate**: probe the profile on macOS 26.x, confirm `node` and `sh` workloads run under a strict workdir-only filesystem profile (allow the runtime allowlist, deny everything else), and confirm the adversarial tests pass. If the profile support degrades, mark `unknown`.

### Windows: AppContainer (evaluate or mark unsupported)

**Candidate: Windows AppContainer sandbox.**

- **Feasibility**: AppContainer is the modern Windows isolation primitive (used by Edge, UWP); it provides per-app data isolation via a restricted token and profile, including filesystem redirection and denial of host-user paths. However, creating an AppContainer and assigning a process to it programmatically from an unprivileged process is non-trivial; the patterns involve `CreateAppContainerProfile`, restricted SIDs, `GetAppContainerNamedObjectPath`, and lowbox token creation, which historically require care and often designed-for-it binaries.
- **Alternative: restricting token with explicit file ACLs**: build a restricted token (no groups, no write access) and run the workload token with ACLs that allow only the workspace; this is closer to what the Native backend already does for process isolation and may be achievable without a full AppContainer, but its filesystem confinement is weaker (default-allow outside the workspace unless the token strips general access) and needs dedicated validation.
- **Honest default**: until one of the two paths is probed and the adversarial tests pass, **Windows must be marked `unsupported` with no implied equivalent**. RFC 0004's precedent is to prefer an honest `unsupported` over a pretending `supported`. This RFC commits only to evaluating AppContainer/restricted-token as a later work item and declaring the outcome, not to a date.

### Platform matrix (target declarations)

| Platform | Primitive | Declared OS-filesystem isolation |
|---|---|---|
| Linux (kernel 5.13+, Landlock LSM enabled) | Landlock ruleset (workspace rwx + runtime read/exec allowlist, else deny) | **supported** (pending probe + adversarial tests) |
| Linux (pre-5.13 or Landlock unavailable) | None | **unknown** (fallback to ambient rights, declared) |
| macOS | Seatbelt filesystem profile via `sandbox-exec` | **pending validation**; `supported` only after adversarial tests pass |
| Windows | AppContainer / restricted token (non-trivial) | **unsupported** until evaluated and validated |

## Adversarial Test Plan (to implement)

Each test runs under the confinement and asserts the attempt **fails** while the sandbox remains healthy and reusable. Tests align to guarantees G1-G8 and escapes E1-E10:

1. **Read `/etc`/`/etc/passwd`/`/etc/shadow`** (world-readable target): read must fail (E1, G1).
2. **Read `$HOME` material**: `~/.ssh`, `~/.aws`, dotfiles, another tenant's project: read must fail (E1, G1).
3. **Write outside workspace**: append/create in `/tmp` (outside the workspace), `/var`, `/etc`, `$HOME`: must fail (G2, E1).
4. **Symlink escape**: workspace symlink → `/etc` or `$HOME`: follow must fail (E2, G4).
5. **Hardlink escape**: link a host file into the workspace: must fail (E3).
6. **FD inheritance**: open a host file, then spawn a child that reads it: must fail (E4, E5, G5). Also serve as the SDK-side management check (no out-of-tree FDs held at confinement).
7. **Subprocess inheritance**: `sh -c 'cat /etc/shadow'`, piped background children: must fail (E7, G5).
8. **Path traversal**: `../../etc/passwd` from a workspace-relative cwd: must fail (E6).
9. **`/proc` read** (Linux, where applicable): `cat /proc/self/environ` or walked FDs: attempt must not expose host paths outside the declared residual; if the mechanism cannot hide `/proc`, the test records the declared residual rather than pretending (E5, E9).
10. **Absolute path access**: `python -c open('/home/...')`, `node -e fs.readFileSync('/etc/...')`: must fail across interpreters (E10, G5).
11. **Execution outside allowlist**: `exec` a script outside workspace + runtime allowlist: must fail (G3).
12. **Runtime allowlist works**: a normal `node -v`, `sh -c 'echo hi'`, and workspace-heavy workload (writes, reads, build tool) succeed unchanged (G7) with only the declared runtime paths granted.
13. **Irrevocability**: after confinement, attempt to loosen (chmod, mount, re-exec a helper that writes elsewhere): must fail (G6).
14. **Recovery/reuse**: after every failed attempt, a normal `exec()` completes and the sandbox destroys cleanly with zero residue (matching the production-suite discipline).
15. **Cross-process crash recovery reuse (RFC 0005 interplay)**: the confinement holds inside a hard-crashed host's orphaned workload too, and reaping still works (the reaper, which runs in the SDK host, is unaffected because confinement is applied to the workload tree only).

The adversarial tests become a new production scenario (`production/scenarios/os-filesystem-isolation.mjs`) run on the packed artifact, plus targeted unit/integration tests in `sdk/typescript/src/test/osfilesystem.test.ts` and repros under `repro/filesystem/`.

## Capability Probe Results

Probe scripts: `scripts/probes/landlock-probe.c` (C helper) and
`scripts/probes/landlock-capability.mjs` (runner). Run:
`node scripts/probes/landlock-capability.mjs [--json]`. The C helper is
compiled with `cc` at probe time, executed as the invoking user, and verifies
the RFC's assumptions directly against the kernel (ABI query, ruleset
create/add/apply, allowlist read/write, outside read/write/create denial,
symlink-escape denial, descendant inheritance, and the unprivileged
requirement). It reports `supported`, `unsupported`, or `unknown` and never
touches the SDK, the sandbox path, or the capability flag.

**Important boundary**: passing this probe does **not** justify
`osFilesystemIsolation: supported`. It proves the kernel mechanism is present
and behaves correctly; the flag becomes `supported` only after the actual
sandbox path passes the adversarial test plan above.

### Baseline probe outcome (Ubuntu 24.04, kernel 6.8.0, unprivileged user)

| Assumption (RFC 0006 dependency) | Result |
|---|---|
| Landlock ABI available | **ABI 4** |
| REFER right (hardlink/rename semantics, E3/E8) supported | yes (ABI >= 2) |
| Ruleset create / add_rule / restrict_self as unprivileged user | ok |
| no_new_privs applied | ok |
| Allowlist read + write (workspace) | ok |
| Outside read (secret file) denied | ok |
| Outside write (append) denied | ok |
| Outside create (new file in parent dir) denied | ok |
| Workspace symlink escaping outside denied | ok |
| Descendant process inherits the denial | ok |
| unprivileged enforcement (no root run) | yes |
| **Verdict** | **supported** (mechanism-level) |

Follow-up probes required before implementation: the same run must be
repeated on the CI Ubuntu image used by `production.yml`/`docs.yml`, and the
runtime allowlist the reference SDK needs (`node`, `sh`) must be enumerated
(`ldd`-derived) so the allowlist in the implementation is evidence-based.

## Design Decision Gate (this RFC does not implement)

Following RFC 0004's discipline, the order is:

1. **Adopt this RFC** (threat model, guarantee, capability model, platform matrix) as the design record.
2. **Probe per platform** (Landlock ABI/ruleset on Linux CI; Seatbelt profile on macOS; AppContainer/restricted-token feasibility on Windows) and record evidence.
3. **Implement** the Linux Landlock path first (strongest practical platform), then macOS after validation, then Windows only if a path passes.
4. **Run the adversarial test plan**; promote `osFilesystemIsolation` to `supported` only after the tests pass on that platform.
5. **Update** `spec/capabilities.schema.json`, `spec/CHANGELOG.md`/`spec/version.md`, `docs/api.md`, `SECURITY.md`, `ROADMAP.md`, and the Gist for each promoted platform.

## Out of Scope (future candidates)

- Bind-mount/`--mount host-path`-style explicit host access.
- Mount-namespace (chroot-equivalent) upgrade of the Linux mechanism (may come later; Landlock is the v1 Linux mechanism).
- Process/IPC/signal scoping (separate from filesystem; RFC 0004 covers network).
- Docker- and Firecracker-backend host-filesystem guarantees (governed by their own models).