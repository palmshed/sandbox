/**
 * src/osfs/allowlist.ts
 *
 * Runtime allowlist derivation for RFC 0006 (OS-level filesystem isolation).
 *
 * This is a TypeScript port of scripts/probes/runtime-allowlist.mjs, kept
 * behaviorally identical so the CI smoke evidence and the SDK runtime derive
 * the same read-only runtime paths for the reference interpreter set (node +
 * sh + unshare when the network-restricted spawn path is composed).
 *
 * Given a set of runtime binaries, derives:
 *   - each binary's dynamic loader (interpreter),
 *   - every link-time shared object resolved by `ldd -v`,
 *   - the directories that must be traversable/readable to reach them,
 *   - the runtime data files libc/OpenSSL/zoneinfo/node need before exec
 *     (ld.so.cache, localtime, zoneinfo, openssl.cnf, locale, node
 *     externalized builtins).
 *
 * Sensitive host/system files (/etc/passwd, /etc/group, /etc/hosts,
 * /etc/resolv.conf, /etc/nsswitch.conf) are intentionally NOT granted: node
 * and sh start and run without them, and granting them would nullify the RFC
 * 0006 E1 read-denial guarantee for world-readable system files. Workloads
 * that call os.userInfo() or resolve hostnames therefore fail those specific
 * lookups with EACCES under confinement (documented residual in RFC 0006).
 *
 * Everything else is denied by the confinement ruleset. The workspace is
 * granted separately (rwx) by the runner, never through this allowlist.
 *
 * Emits the runner's `mode:path` allowlist-file format:
 *   r:  READ_FILE | READ_DIR   (read-only data, config, traversal)
 *   rx: READ_FILE | READ_DIR | EXECUTE  (binaries, loader, shared objects)
 *   rw: READ_FILE | WRITE_FILE (only /dev/null, for backgrounded-job
 *                              stdin/stdout redirection; a discard sink)
 *   x:  EXECUTE                (exec-only)
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface DerivedAllowlist {
  binaries: string[];
  dso: string[];
  interpreter: string | null;
  dirsReadExec: string[];
  dataFiles: string[];
  lines: string[];
  missing: string[];
}

function findInPath(bin: string): string {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    const cand = path.join(dir, bin);
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      // keep searching
    }
  }
  throw new Error(`not found in PATH: ${bin}`);
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && !!(st.mode & 0o111);
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

interface LddEntry {
  type: 'needed' | 'interpreter';
  path: string;
}

/**
 * Parse `ldd -v <bin>`-style output:
 *   "  linux-vdso.so.1 (0x...)"            -> ignored
 *   "  libc.so.6 => /lib/.../libc.so.6 (0x...)"  -> needed
 *   "  /lib64/ld-linux-x86-64.so.2 (0x...)"      -> interpreter
 *   "  libfoo.so.1 => not found"           -> recorded as missing
 */
export function lddResolve(bin: string, missing: string[]): LddEntry[] {
  let out: string;
  try {
    out = execFileSync('ldd', ['-v', bin], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  const entries: LddEntry[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const notFound = line.match(/^(\S+)\s*=>\s*not found/);
    if (notFound) {
      missing.push(`${bin}: ${notFound[1]} => not found`);
      continue;
    }
    const needed = line.match(/^(\S+)\s*=>\s+(\/\S+) \(0x[0-9a-f]+\)$/);
    if (needed) {
      entries.push({ type: 'needed', path: needed[2] });
      continue;
    }
    const interp = line.match(/^(\/\S+) \(0x[0-9a-f]+\)$/);
    if (interp) {
      entries.push({ type: 'interpreter', path: interp[1] });
    }
  }
  return entries;
}

/**
 * Derive the minimal read-only runtime allowlist for the given runtime
 * binaries (realpath-resolved). Returns `lines` ready to write to the
 * allowlist file consumed by the confinement runner.
 */
export function deriveRuntimeAllowlist(bins: string[]): DerivedAllowlist {
  const missing: string[] = [];

  const resolved: string[] = [];
  for (const b of bins) {
    let p = b;
    if (!path.isAbsolute(p)) {
      try {
        p = findInPath(b);
      } catch (err) {
        missing.push(String((err as Error).message));
        continue;
      }
    }
    try {
      p = fs.realpathSync(p);
    } catch {
      missing.push(b);
      continue;
    }
    if (!resolved.includes(p)) resolved.push(p);
  }

  const dsoSet = new Set<string>();
  const dirSet = new Set<string>();
  const interp: string[] = [];

  for (const b of resolved) {
    if (!isExecutable(b)) {
      missing.push(`${b} (not executable)`);
      continue;
    }
    const dsoCandidates = lddResolve(b, missing);
    for (const entry of dsoCandidates) {
      if (entry.type === 'needed') dsoSet.add(entry.path);
      else if (entry.type === 'interpreter') interp.push(entry.path);
    }
    dirSet.add(path.dirname(b));
  }
  for (const i of interp) {
    dsoSet.add(i);
    dirSet.add(path.dirname(i));
  }

  const dataCandidates = [
    '/etc/ld.so.cache',
    '/etc/ld.so.preload',
    '/etc/localtime',
    '/usr/share/zoneinfo',
    '/usr/lib/ssl/openssl.cnf',
    '/usr/lib/locale',
    // /dev/null: POSIX shells redirect a backgrounded job's stdin (and some
    // shells its stdout) to /dev/null. The open is both read and write, so it
    // must be granted `rw:`. It is a discard sink (no host data), so granting
    // it does not weaken the E1 read-denial guarantees.
    '/dev/null',
    // Node.js "externalized builtins": distro node ships parts of its internal
    // runtime (cjs-module-lexer, undici, ...) as JSON/JS files under
    // /usr/share/nodejs that node reads at startup.
    '/usr/share/nodejs',
  ];
  const dataFiles = dataCandidates.filter((f) => exists(f));

  // actions/setup-node / nvm toolcache layout: <prefix>/lib/node_modules
  // holds node's externalized builtins instead of /usr/share/nodejs.
  for (const b of resolved) {
    const prefix = path.dirname(path.dirname(b)); // <prefix>/bin -> <prefix>
    const nodeModules = path.join(prefix, 'lib', 'node_modules');
    if (exists(nodeModules) && !dataFiles.includes(nodeModules)) {
      dataFiles.push(nodeModules);
    }
  }
  dataFiles.sort();

  const out: DerivedAllowlist = {
    binaries: resolved,
    dso: [...dsoSet].sort(),
    interpreter: interp[0] ?? null,
    dirsReadExec: [...dirSet].sort(),
    dataFiles,
    lines: [],
    missing,
  };

  // Emit in the runner's allowlist-file order (dedup preserves first use).
  // Most data files are read-only (`r:`); /dev/null is the exception and gets
  // `rw:` so backgrounded-job stdin/stdout redirection can open it.
  const all = [
    ...dataFiles.map((f): string => (f === '/dev/null' ? `rw:${f}` : `r:${f}`)),
    ...resolved.map((b): string => `rx:${b}`),
    ...[...dsoSet].sort().map((d): string => `rx:${d}`),
    ...[...dirSet].sort().map((d): string => `r:${d}`),
  ];
  out.lines = all.filter((l, i) => all.indexOf(l) === i);
  return out;
}

/**
 * The runtime binaries the reference Native backend needs: the workload shell,
 * the SDK's own node interpreter, and `unshare` for the network-restricted
 * spawn composition. Missing entries degrade the derivation (the caller decides
 * whether that is fatal for capability reporting).
 */
export function defaultRuntimeBins(includeUnshare: boolean): string[] {
  const bins = [process.execPath, '/bin/sh'];
  if (includeUnshare) bins.push('/usr/bin/unshare');
  return bins;
}