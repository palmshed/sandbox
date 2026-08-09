/**
 * production/lib/residue.mjs
 *
 * Residue detection for the Production Validation Suite.
 *
 * A scenario only counts as a PASS when the system returned to its prior
 * state: no palmshed sandbox temp dirs, no registry entries, and no live
 * processes still holding a sandbox directory (including a deleted one) as
 * their working directory. These scans read observable filesystem and process
 * state, which is exactly what an operator can inspect after running a
 * service that uses the SDK.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const SANDBOX_DIR_PREFIX = 'palmshed-sandbox-';
const REGISTRY_PATH = path.join('palmshed-sandbox', '.registry');

/** Absolute prefix that every Native sandbox temp dir starts with. */
export function sandboxDirPrefix() {
  return path.join(os.tmpdir(), SANDBOX_DIR_PREFIX);
}

/** Names of palmshed sandbox dirs currently present in os.tmpdir(). */
export function listSandboxDirs() {
  let names = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    names = [];
  }
  return names.filter((n) => n.startsWith(SANDBOX_DIR_PREFIX)).sort();
}

/** Names of registry entry files currently present under os.tmpdir(). */
export function listRegistryEntries() {
  const reg = path.join(os.tmpdir(), REGISTRY_PATH);
  let names = [];
  try {
    names = fs.readdirSync(reg);
  } catch {
    names = [];
  }
  return names.filter((n) => n.endsWith('.json')).sort();
}

/**
 * Live processes holding a sandbox directory as their working directory.
 * Best-effort and platform-specific; the directory-level and registry scans
 * are the primary signals on every platform.
 *
 * Linux: /proc/<pid>/cwd realpath (catches a workload whose sandbox dir was
 * already unlinked, since the cwd inode survives). macOS has no /proc, but
 * `lsof +L1` lists files with zero link count, which includes a process that
 * keeps a deleted sandbox dir as cwd.
 */
export function listProcessHolders() {
  const prefix = sandboxDirPrefix();
  const holders = [];
  if (process.platform === 'linux') {
    let procs = [];
    try {
      procs = fs.readdirSync('/proc');
    } catch {
      procs = [];
    }
    for (const entry of procs) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cwd = fs.realpathSync(`/proc/${entry}/cwd`);
        if (cwd.startsWith(prefix)) holders.push({ pid: Number(entry), cwd });
      } catch {
        // process exited or cwd unreadable
      }
    }
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const out = execFileSync('lsof', ['-n', '-P', '+L1'], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\n')) {
        if (!line.includes('palmshed-sandbox')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[1], 10);
        if (!Number.isNaN(pid)) holders.push({ pid, line });
      }
    } catch {
      // lsof unavailable; not fatal
    }
  }
  return holders;
}

/** Full snapshot of the observable residue surface. */
export function scanResidue() {
  return {
    dirs: listSandboxDirs(),
    registry: listRegistryEntries(),
    processHolders: listProcessHolders(),
  };
}

/** Residue that appeared after `before` (i.e. introduced by a scenario). */
export function diffResidue(before, after) {
  const leakedDirs = after.dirs.filter((d) => !before.dirs.includes(d));
  const leakedRegistry = after.registry.filter((r) => !before.registry.includes(r));
  const beforePids = new Set(before.processHolders.map((h) => h.pid));
  const leakedProcessHolders = after.processHolders.filter((h) => !beforePids.has(h.pid));
  return { leakedDirs, leakedRegistry, leakedProcessHolders };
}

/** One-line description of a residue diff, or '' when clean. */
export function formatResidue(leak) {
  const parts = [];
  if (leak.leakedDirs.length) parts.push(`leaked dirs: ${leak.leakedDirs.join(', ')}`);
  if (leak.leakedRegistry.length) parts.push(`leaked registry entries: ${leak.leakedRegistry.join(', ')}`);
  if (leak.leakedProcessHolders.length) {
    parts.push(`processes holding sandbox dirs: ${leak.leakedProcessHolders.map((h) => h.pid).join(', ')}`);
  }
  return parts.join('; ');
}

/**
 * Snapshot of the workload roots currently recorded in the registry. The
 * registry is a documented, observable mechanism (RFC 0005), so a production
 * operator can read it too. Scenarios use these pids to assert that every
 * workload they started was actually terminated.
 */
export function snapshotRegistryPgids() {
  const reg = path.join(os.tmpdir(), REGISTRY_PATH);
  const pgids = new Set();
  for (const name of listRegistryEntries()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(reg, name), 'utf-8'));
      if (Array.isArray(raw.pgids)) {
        for (const p of raw.pgids) {
          if (Number.isInteger(p)) pgids.add(p);
        }
      }
    } catch {
      // unreadable entry
    }
  }
  return [...pgids];
}

/** Subset of `pids` that are still alive (signal 0; EPERM counts as alive). */
export function liveProcesses(pids) {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  });
}
