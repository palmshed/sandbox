import { spawn } from 'child_process';
import * as fssync from 'fs';
import * as path from 'path';

/**
 * cgroups v2 CPU hard quota helpers (RFC 0007, Linux only).
 *
 * Pure mechanism, no enforcement policy: the native backend owns lifecycle
 * (per-sandbox cgroup create/move/remove, override dance, capability flag).
 * Every helper that touches the filesystem is synchronous and narrowly
 * scoped; callers decide honesty (throw versus degrade) per call site.
 * All functions are safe to call on non-Linux platforms (they fail closed
 * and callers gate on platform first).
 */

/** Default CFS period in microseconds (kernel default for cpu.max). */
export const CGROUP_PERIOD_US = 100000;

/** A delegated cgroup parent that accepts per-sandbox children. */
export interface CgroupDelegation {
  parentDir: string;
}

/** Render cpu.max contents for a core quota (fractional allowed). */
export function quotaToCpuMax(cores: number): string {
  return `${Math.max(1, Math.round(cores * CGROUP_PERIOD_US))} ${CGROUP_PERIOD_US}`;
}

/** Render cpu.max contents for unconstrained (matches kernel default). */
export function unlimitedCpuMax(): string {
  return `max ${CGROUP_PERIOD_US}`;
}

/**
 * Enable the cpu controller for children of dir by adding +cpu to its
 * cgroup.subtree_control (no-op when already present). Required before any
 * child cpu.max write: availability flows downward. Enabling availability
 * throttles nothing by itself. dir MUST hold no member processes (use the
 * distributor pattern below): a cgroup with both members and enabled
 * controllers violates the no-internal-process constraint, after which
 * moves into its children are refused. Throws on failure.
 */
export function enableCpuController(dir: string): void {
  const controlFile = path.join(dir, 'cgroup.subtree_control');
  const current = fssync.readFileSync(controlFile, 'utf-8');
  if (!current.split(/\s+/).includes('cpu')) {
    fssync.writeFileSync(controlFile, '+cpu');
  }
}

/**
 * Candidate delegated parents, in probe order: the SDK host's own cgroup
 * first (a live move downward from the workloads' origin cgroup is what the
 * kernel permits; cross-branch moves into a shared provisioned parent are
 * denied), then the operator escape hatch, then the systemd user delegation
 * path, then the cgroup root itself (writable on permissive hosts and inside
 * containers). Deduplicated, non-probeable entries skipped.
 */
export function candidateParents(): string[] {
  const candidates: string[] = [];
  const own = ownCgroupDir();
  if (own !== null) candidates.push(own);
  if (process.env.PALMSHED_CGROUP_PARENT) {
    candidates.push(process.env.PALMSHED_CGROUP_PARENT);
  }
  if (typeof process.getuid === 'function') {
    candidates.push(`/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice`);
  }
  candidates.push('/sys/fs/cgroup');
  return [...new Set(candidates)];
}

/**
 * The SDK host's own cgroup v2 directory, or null when unreadable (non-Linux
 * hosts, cgroup v1 hierarchies which list one line per controller instead of
 * the unified `0::` entry, or locked-down containers).
 */
export function ownCgroupDir(): string | null {
  try {
    const content = fssync.readFileSync('/proc/self/cgroup', 'utf-8');
    const unified = content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('0::'));
    if (!unified) return null;
    const rel = unified.slice(3) || '/';
    return `/sys/fs/cgroup${rel}`;
  } catch {
    return null;
  }
}

/**
 * Wait for a child to be reaped (bounded, never rejects). A SIGKILLed child
 * lingers as a zombie inside its cgroup until the runtime processes SIGCHLD,
 * so removing its cgroup must wait for the exit event: rmdir on a non-empty
 * cgroup throws, and cleanup throwing past a proven result would discard it.
 */
function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Probe for a delegated parent by demonstrating a REAL live-PID move (not a
 * bogus-PID writability check: a nonexistent PID fails with ESRCH before the
 * kernel's migration permission checks, so it proves writability but never
 * provability of an actual move). Settles the topology first: the SDK host
 * relocates itself into `<parent>/palmshed-self`, then `+cpu` is enabled in
 * the parent (now member-free with respect to us, satisfying the
 * no-internal-process constraint that enabling controllers in a
 * member-holding cgroup would violate and after which moves into its
 * children are refused), then a test child proves a live move. First
 * candidate with a successful live move wins. Never throws: null means
 * unavailable. Side effects on success are the intended setup (host stays
 * relocated and unthrottled; empty dirs vanish with the scope); on failure
 * the host is left where it is or relocated-but-unthrottled, both harmless.
 *
 * Async because cleanup must await the reaped child: removing a cgroup that
 * still holds the (SIGKILLed but unreaped) sleeper throws, and that cleanup
 * failure must never cancel an already-proven result.
 */
export async function probeCpuQuotaDelegation(): Promise<CgroupDelegation | null> {
  for (const parent of candidateParents()) {
    const selfDir = path.join(parent, 'palmshed-self');
    const testDir = path.join(parent, `palmshed-probe-${process.pid}`);
    try {
      // Relocate ourselves first: moves below only work downward from here,
      // and the parent must be member-free (of us) before it distributes.
      fssync.mkdirSync(selfDir, { recursive: true });
      fssync.writeFileSync(path.join(selfDir, 'cgroup.procs'), String(process.pid));
      enableCpuController(parent);
      fssync.mkdirSync(testDir);
      fssync.writeFileSync(path.join(testDir, 'cpu.max'), unlimitedCpuMax());
      const child = spawn('sleep', ['10'], { stdio: 'ignore' });
      child.on('error', () => {
        // spawn failure surfaces as a missing PID below
      });
      if (child.pid === undefined) {
        try {
          fssync.rmdirSync(testDir);
        } catch {
          // best effort
        }
        continue;
      }
      try {
        fssync.writeFileSync(path.join(testDir, 'cgroup.procs'), String(child.pid));
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
        try {
          fssync.rmdirSync(testDir);
        } catch {
          // best effort
        }
        continue;
      }
      // Proven: clean up, await the reaping first, and never let cleanup
      // failures cancel the proof.
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
      await waitForChildExit(child, 5000);
      try {
        fssync.rmdirSync(testDir);
      } catch {
        // best effort; an empty test dir is harmless residue
      }
      return { parentDir: parent };
    } catch {
      continue;
    }
  }
  return null;
}

/** Create a per-sandbox cgroup; throws on failure (caller decides honesty). */
export function createSandboxCgroup(parentDir: string, name: string): string {
  const dir = path.join(parentDir, name);
  fssync.mkdirSync(dir);
  return dir;
}

/** Write the quota (cores) or unlimited (null) into cpu.max; throws on failure. */
export function setCpuMax(cgroupPath: string, cores: number | null): void {
  fssync.writeFileSync(
    path.join(cgroupPath, 'cpu.max'),
    cores === null ? unlimitedCpuMax() : quotaToCpuMax(cores)
  );
}

/** Move a PID (whole thread group) into the cgroup; throws on failure. */
export function movePidToCgroup(cgroupPath: string, pid: number): void {
  fssync.writeFileSync(path.join(cgroupPath, 'cgroup.procs'), String(pid));
}

/** Read back cpu.max contents (trimmed), or null when unreadable. */
export function readCpuMax(cgroupPath: string): string | null {
  try {
    return fssync.readFileSync(path.join(cgroupPath, 'cpu.max'), 'utf-8').trim();
  } catch {
    return null;
  }
}

/** Remove a sandbox cgroup; best effort, never throws. */
export function removeSandboxCgroup(cgroupPath: string): void {
  try {
    fssync.rmdirSync(cgroupPath);
  } catch {
    // lingering threads or lost delegation; the reaper-independent
    // empty-dir residue is harmless and retried on next destroy
  }
}

/** True when a PID currently exists (kill signal 0 probe). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
