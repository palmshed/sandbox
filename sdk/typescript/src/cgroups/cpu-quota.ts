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
 * Candidate delegated parents, in probe order: the operator escape hatch,
 * then the systemd user delegation path, then the cgroup root itself
 * (writable on permissive hosts and inside containers).
 */
export function candidateParents(): string[] {
  const candidates: string[] = [];
  if (process.env.PALMSHED_CGROUP_PARENT) {
    candidates.push(process.env.PALMSHED_CGROUP_PARENT);
  }
  if (typeof process.getuid === 'function') {
    candidates.push(`/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice`);
  }
  candidates.push('/sys/fs/cgroup');
  return candidates;
}

/**
 * Probe for a delegated parent: mkdir a test directory, write cpu.max, and
 * prove cgroup.procs writability by writing a nonexistent PID (ESRCH means
 * writable; anything else means no delegation). Cleans up after itself and
 * never throws: null means unavailable.
 */
export function probeCpuQuotaDelegation(): CgroupDelegation | null {
  for (const parent of candidateParents()) {
    const testDir = path.join(parent, `palmshed-probe-${process.pid}`);
    try {
      fssync.mkdirSync(testDir);
      try {
        fssync.writeFileSync(path.join(testDir, 'cpu.max'), unlimitedCpuMax());
        try {
          fssync.writeFileSync(path.join(testDir, 'cgroup.procs'), '999999999');
        } catch (err) {
          // ESRCH (no such process) proves the file is writable; any other
          // error means this parent is not delegated to us.
          if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
            throw err;
          }
        }
        return { parentDir: parent };
      } finally {
        try {
          fssync.rmdirSync(testDir);
        } catch {
          // best effort; an empty test dir is harmless residue
        }
      }
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
