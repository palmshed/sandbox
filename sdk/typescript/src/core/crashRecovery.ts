import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logDebug } from './log.js';

/**
 * Crash recovery for the Native backend (RFC 0005).
 *
 * The SDK is an in-process library: when the host process dies (SIGKILL,
 * segfault, OOM-kill, power loss) no library code runs, so sandbox workloads
 * and temp directories would leak. Recovery works in two phases:
 *
 *  1. Graceful: signal/exit hooks run the normal cleanup path for every live
 *     sandbox when the host receives a terminal but catchable event.
 *  2. Post-mortem: every sandbox is registered in a shared registry directory
 *     (outside any sandbox workspace) with the owning host PID, the host's
 *     process start-time token (guards against PID reuse), and the workload
 *     process-group IDs. On each new sandbox creation, `reapStaleSandboxes()`
 *     kills the workloads of sandboxes whose recorded host is dead and removes
 *     their directories.
 *
 * Non-goals (documented in RFC 0005): immediate cleanup at the instant of a
 * hard crash (no daemon), data preservation, and tamper-proof metadata (the
 * Native backend has no OS-level filesystem isolation yet, issue #3).
 */

/** Container directory under os.tmpdir() holding the shared registry. */
const CONTAINER_DIR = 'palmshed-sandbox';
const REGISTRY_DIR = 'palmshed-sandbox/.registry';

/** Prefix of per-sandbox temp dirs, matching NativeBackend.init(). */
const SANDBOX_DIR_PREFIX = 'palmshed-sandbox-';

/** Fallback GC: entryless sandbox dirs older than this are removed. */
const ENTRYLESS_GRACE_MS = 60 * 60 * 1000;

/** Maximum recorded process-group ids per sandbox (deduped). */
const MAX_PGIDS = 200;

interface SandboxEntry {
  dir: string;
  token: string;
  hostPid: number;
  hostStart: string;
  pgids: number[];
  createdAt: string;
}

export function registryDir(): string {
  return path.join(os.tmpdir(), REGISTRY_DIR);
}

async function ensureRegistryDir(): Promise<string> {
  const dir = registryDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function entryPath(dir: string): string {
  return path.join(registryDir(), `${path.basename(dir)}.json`);
}

/** Whether a process with `pid` exists. EPERM still means it is alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
/**
 * Read the OS start-time token of `pid`, used with the recorded hostStart to
 * detect PID reuse. Linux: /proc/<pid>/stat field 22 (starttime), which is the
 * 20th field after the ")" slice (state=0, ppid=1, ..., starttime=19); it is
 * constant for the lifetime of a process, unlike vsize/utime fields which
 * change and would cause false reaping. macOS: `ps -o lstart=`. Windows:
 * process creation time (best-effort).
 */
export function readHostStartToken(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = fssync.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen === -1) return null;
      const fields = stat.slice(closeParen + 2).split(' ');
      return fields[19] ?? null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execSync(`ps -o lstart= -p ${pid}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      return out || null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    try {
      const script = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('yyyyMMddHHmmssfff')`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      return out || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Read a registry entry, or null when missing/unreadable. */
async function readEntry(sandboxDir: string): Promise<SandboxEntry | null> {
  try {
    const raw = await fs.readFile(entryPath(sandboxDir), 'utf-8');
    const parsed = JSON.parse(raw) as SandboxEntry;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.dir !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Atomically write a registry entry (temp file + rename). */
async function writeEntry(sandboxDir: string, entry: SandboxEntry): Promise<void> {
  const target = entryPath(sandboxDir);
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(entry));
  await fs.rename(tmp, target);
}

/** Delete a registry entry, ignoring missing-file errors. */
async function removeEntry(sandboxDir: string): Promise<void> {
  try {
    await fs.unlink(entryPath(sandboxDir));
  } catch {
    // entry already gone
  }
}

/**
 * Kill one recorded workload root: the process group on POSIX, the process
 * tree on Windows. On POSIX, after killing the group leader, any surviving
 * group members are enumerated and killed individually, so backgrounded
 * descendants (`nohup`, `&`) are reaped even if the leader already exited.
 */
function killWorkloadRoot(pgid: number): void {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pgid} /T /F`, { stdio: 'ignore' });
    } catch {
      // workload already gone
    }
    return;
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // process group may already be gone
  }
  try {
    const out = execSync('ps -e -o pid=,pgid=', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const pid = parseInt(parts[0], 10);
        const grp = parseInt(parts[1], 10);
        if (grp === pgid && !isNaN(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    }
  } catch {
    // ps unavailable
  }
}

const RM_RETRY_INTERVAL_MS = 100;
const RM_MAX_WAIT_MS = 15000;

/**
 * Remove a sandbox directory, retrying transient failures. On Windows a
 * directory cannot be removed while a terminating workload still holds it as
 * its current directory, so the kill + rm must tolerate EBUSY/EPERM until the
 * process tree is actually gone. On POSIX the first attempt normally succeeds.
 */
async function removeSandboxDir(dir: string): Promise<void> {
  const deadline = Date.now() + RM_MAX_WAIT_MS;
  for (;;) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, RM_RETRY_INTERVAL_MS));
    }
  }
}

/** Sync variant of removeSandboxDir, safe inside signal/exit handlers. */
function removeSandboxDirSync(dir: string): void {
  const deadline = Date.now() + RM_MAX_WAIT_MS;
  for (;;) {
    try {
      fssync.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (Date.now() >= deadline) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RM_RETRY_INTERVAL_MS);
    }
  }
}

/**
 * Register a newly created sandbox in the shared registry.
 * Best-effort: failure to register weakens recovery but never breaks exec.
 */
export async function registerSandbox(sandboxDir: string, hostStart: string): Promise<void> {
  // Unpredictable per-sandbox token, kept in the registry only. Unknown
  // entries are never reaped, so a forged entry cannot make a live sandbox
  // look stale to the reaper.
  const entry: SandboxEntry = {
    dir: sandboxDir,
    token: Math.random().toString(36).slice(2) + Date.now().toString(36),
    hostPid: process.pid,
    hostStart,
    pgids: [],
    createdAt: new Date().toISOString(),
  };
  try {
    await ensureRegistryDir();
    await writeEntry(sandboxDir, entry);
  } catch {
    logDebug('recovery.register.failed', { backend: 'native' });
  }
}

/**
 * Record a workload root PID (POSIX process-group id, Windows tree root) for
 * the reaper to terminate if the host dies. Fire-and-forget best-effort.
 */
export function recordSandboxPgid(sandboxDir: string, pgid: number): void {
  if (!Number.isInteger(pgid)) return;
  void readEntry(sandboxDir)
    .then((entry) => {
      if (!entry || entry.hostPid !== process.pid) return;
      if (!entry.pgids.includes(pgid)) {
        entry.pgids.push(pgid);
        if (entry.pgids.length > MAX_PGIDS) entry.pgids.splice(0, entry.pgids.length - MAX_PGIDS);
        return writeEntry(sandboxDir, entry).catch(() => undefined);
      }
      return undefined;
    })
    .catch(() => undefined);
}

/** Remove the registry entry on normal sandbox destruction. */
export async function unregisterSandbox(sandboxDir: string): Promise<void> {
  await removeEntry(sandboxDir);
}

/**
 * Sweep the registry and reap sandboxes whose recorded host is dead (or whose
 * PID was reused, detected via the start-time token). Also garbage-collects
 * entryless sandbox dirs older than the grace period (hosts that crashed
 * between mkdtemp and registry write). Returns the number of reaped dirs.
 */
export async function reapStaleSandboxes(skipDir?: string): Promise<number> {
  let reaped = 0;

  const reg = registryDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(reg);
  } catch {
    entries = [];
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const entryPathFile = path.join(reg, name);
    let entry: SandboxEntry;
    try {
      entry = JSON.parse(await fs.readFile(entryPathFile, 'utf-8')) as SandboxEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.dir !== 'string') continue;
    if (entry.dir === skipDir) continue;

    const hostPid = Number(entry.hostPid);
    const alive = Number.isInteger(hostPid) && pidAlive(hostPid);
    let tokenOk = false;
    if (alive && typeof entry.hostStart === 'string') {
      const current = readHostStartToken(hostPid);
      // When the token cannot be read, treat the sandbox as live: bias toward
      // never reaping a live sandbox (G4) over reaping a stale one (G2).
      tokenOk = current === null || current === entry.hostStart;
    }
    if (alive && tokenOk) continue;

    for (const pgid of entry.pgids) {
      if (Number.isInteger(pgid)) killWorkloadRoot(pgid);
    }
    await removeSandboxDir(entry.dir);
    await removeEntry(entry.dir);
    reaped++;
  }

  // Fallback GC: sandbox dirs without a registry entry, only when older than
  // the grace period so a host still writing its entry is never disturbed.
  if (process.platform !== 'win32') {
    const tmp = os.tmpdir();
    let names: string[] = [];
    try {
      names = await fs.readdir(tmp);
    } catch {
      names = [];
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith(SANDBOX_DIR_PREFIX)) continue;
      const dir = path.join(tmp, name);
      if (dir === skipDir) continue;
      const entryFile = entryPath(dir);
      let hasEntry = true;
      try {
        await fs.access(entryFile);
      } catch {
        hasEntry = false;
      }
      if (hasEntry) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(dir)).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs < ENTRYLESS_GRACE_MS) continue;
      await removeSandboxDir(dir);
      reaped++;
    }
  }

  if (reaped > 0) {
    logDebug('recovery.reap', { backend: 'native', reaped });
  }
  return reaped;
}

/**
 * Sync cleanup for one live backend, safe inside signal/exit handlers.
 * Kills every recorded workload root and removes the sandbox directory.
 */
export function cleanupSandboxSync(sandboxDir: string, workloadRoots: Iterable<number>): void {
  for (const pid of workloadRoots) {
    if (Number.isInteger(pid)) killWorkloadRoot(pid);
  }
  if (sandboxDir) {
    removeSandboxDirSync(sandboxDir);
  }
  void removeEntry(sandboxDir);
}

const liveCleanups = new Set<() => void>();
let hooksInstalled = false;

/**
 * Install process-wide graceful shutdown hooks once per process. Each call
 * appends a cleanup callback invoked on exit and on terminal signals. The
 * signal handler runs cleanups, then re-raises the signal after removing
 * itself so the process still terminates with the default behavior.
 */
export function installCrashHooks(cleanup: () => void): void {
  liveCleanups.add(cleanup);
  if (hooksInstalled) return;
  hooksInstalled = true;

  process.on('exit', () => {
    for (const c of liveCleanups) c();
  });

  const runAll = () => {
    for (const c of liveCleanups) c();
  };

  const signals: NodeJS.Signals[] =
    process.platform === 'win32'
      ? ['SIGINT', 'SIGBREAK']
      : ['SIGTERM', 'SIGINT', 'SIGHUP'];

  for (const sig of signals) {
    const handler = () => {
      runAll();
      process.removeListener(sig, handler);
      try {
        process.kill(process.pid, sig);
      } catch {
        // signal may not be deliverable on this platform
      }
    };
    process.on(sig, handler);
  }
}

/** Remove a cleanup callback (used when a backend is destroyed). */
export function uninstallCrashHooks(cleanup: () => void): void {
  liveCleanups.delete(cleanup);
}
