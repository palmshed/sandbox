/**
 * src/osfs/confinement.ts
 *
 * RFC 0006 OS-level filesystem isolation: compiles the Landlock confinement
 * trampoline, derives the runtime allowlist, and probes the real mechanism on
 * this host. The result is a tri-state capability:
 *
 *   supported   the trampoline compiled, the allowlist derived, and a real
 *               confined self-test passed (shell + node run inside the
 *               workspace, outside reads denied). Only then does the Native
 *               backend route exec() through the runner.
 *   unsupported this platform/kernel cannot provide the confinement (e.g.
 *               Windows, or Landlock ABI < 2 on Linux).
 *   unknown     the platform was not probed or setup failed (e.g. no `cc`,
 *               missing `ldd`, allowlist derivation failed) so no definitive
 *               answer can be made. Callers must treat this as "no guarantee"
 *               and must not build security policy on it.
 *
 * The runner is compiled from the embedded LANDLOCK_RUN_C source (single
 * source of truth: scripts/probes/landlock-run.c, guarded by
 * scripts/gen-osfs-source.mjs --check). The compiled binary is cached per
 * process under os.tmpdir()/palmshed-osfs-* (deliberately NOT the
 * `palmshed-sandbox-` prefix so the crash-recovery reaper never sweeps it).
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LANDLOCK_RUN_C } from './landlockRunnerSource.js';
import { deriveRuntimeAllowlist, defaultRuntimeBins } from './allowlist.js';

export type OsFilesystemIsolationStatus = 'supported' | 'unsupported' | 'unknown';

export interface OsFilesystemProbe {
  status: OsFilesystemIsolationStatus;
  reason?: string;
  runnerPath?: string;
  allowlistFile?: string;
}

/**
 * The exact confinement chain the Native backend uses at exec time:
 *   unshare --user --map-root-user -- <runner> <ws> <allowlist> -- <cmd...>
 * landlock_restrict_self requires CAP_SYS_ADMIN, which an unprivileged process
 * only holds inside a fresh user namespace, so the runner is ALWAYS launched
 * behind `unshare --user --map-root-user` (RFC 0006). The smoke validated this
 * composition on CI. The probe self-test must exercise the same chain, not a
 * straight runner invocation, or it would "pass" a mode the backend never uses.
 */
function composeChain(ws: string, allowlistFile: string, cmd: string[]): { shell: string; args: string[] } {
  return {
    shell: 'unshare',
    args: ['--user', '--map-root-user', '--', 'landlock-run', ws, allowlistFile, '--', ...cmd],
  };
}

interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runRunner(runnerPath: string, ws: string, allowlistFile: string, cmd: string[], cwd?: string): RunnerResult {
  const { shell, args } = composeChain(ws, allowlistFile, cmd);
  const argv = args.map((a) => (a === 'landlock-run' ? runnerPath : a));
  const res = spawnSync(shell, argv, {
    cwd: cwd ?? ws,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: res.status ?? -1, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/** Version-keyed cache key so a changed ABI/source rebuilds the runner. */
function cacheKey(includeUnshare: boolean): string {
  const src = LANDLOCK_RUN_C.length;
  return `${process.arch}-abi-${src}-${includeUnshare ? 'u' : 'n'}`;
}

/** Module-level per-process caches: compile and allowlist derivation are
 *  expensive (spawn `cc` / `ldd`); the inputs are constant per process. */
let runnerCache: { key: string; runnerPath: string } | null = null;
let allowlistCache: { key: string; allowlistFile: string; lines: string[] } | null = null;
let probeCache: OsFilesystemProbe | null = null;

function findCompiler(): string | null {
  for (const cand of [process.env.CC, 'cc', 'gcc', 'clang'].filter(Boolean) as string[]) {
    try {
      execFileSync(cand, ['--version'], { stdio: 'ignore' });
      return cand;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Create a per-process working dir under os.tmpdir() that the reaper ignores. */
function workDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'palmshed-osfs-'));
}

function compileRunner(): { runnerPath: string } {
  if (runnerCache) return runnerCache;
  const dir = workDir();
  const srcPath = path.join(dir, 'landlock-run.c');
  const runPath = path.join(dir, 'landlock-run');
  fs.writeFileSync(srcPath, LANDLOCK_RUN_C);
  const compiler = findCompiler();
  if (!compiler) {
    throw new Error('no C compiler (cc/gcc/clang) available to build the confinement runner');
  }
  const res = spawnSync(compiler, ['-O2', '-Wall', '-Wextra', '-o', runPath, srcPath], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`confinement runner compile failed: ${(res.stderr || res.stdout || '').slice(0, 400)}`);
  }
  runnerCache = { key: cacheKey(true), runnerPath: runPath };
  return { runnerPath: runPath };
}

function ensureAllowlistFile(includeUnshare: boolean): { allowlistFile: string; lines: string[] } {
  const key = cacheKey(includeUnshare);
  if (allowlistCache && allowlistCache.key === key) {
    return { allowlistFile: allowlistCache.allowlistFile, lines: allowlistCache.lines };
  }
  const derived = deriveRuntimeAllowlist(defaultRuntimeBins(includeUnshare));
  if (derived.missing.length > 0 && derived.lines.length === 0) {
    throw new Error(`runtime allowlist derivation failed: ${derived.missing.join('; ')}`);
  }
  const dir = workDir();
  const allowlistFile = path.join(dir, 'allowlist.txt');
  fs.writeFileSync(allowlistFile, derived.lines.join('\n') + '\n');
  allowlistCache = { key, allowlistFile, lines: derived.lines };
  return { allowlistFile, lines: derived.lines };
}

/** Create a scratch workspace, write a secret outside it, and verify the
 *  runner confines: shell+node run, outside read denied. */
function selfTest(runnerPath: string, allowlistFile: string): { ok: boolean; detail: string } {
  const base = workDir();
  const ws = path.join(base, 'ws');
  const secret = path.join(base, 'secret.txt');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(secret, 'TOP-SECRET-DO-NOT-READ\n');

  const shell = runRunner(runnerPath, ws, allowlistFile, ['/bin/sh', '-c', 'echo confined-ok']);
  if (shell.code !== 0 || !shell.stdout.includes('confined-ok')) {
    return { ok: false, detail: `shell under confinement failed: exit ${shell.code} ${shell.stderr.trim() || shell.stdout.trim()}` };
  }

  const node = runRunner(runnerPath, ws, allowlistFile, ['node', '-e', "process.stdout.write('node-'+process.version)"]);
  if (node.code !== 0 || !/node-v\d+/.test(node.stdout)) {
    return { ok: false, detail: `node under confinement failed: exit ${node.code} ${node.stderr.trim() || node.stdout.trim()}` };
  }

  // Outside read must be denied (E1/G1) via allowlisted node against a path
  // that is granted to nothing.
  const outside = runRunner(runnerPath, ws, allowlistFile, [
    'node',
    '-e',
    "require('fs').readFileSync(process.argv[1])",
    secret,
  ]);
  if (outside.code === 0 && outside.stdout.includes('TOP-SECRET')) {
    return { ok: false, detail: 'outside read was NOT denied under confinement' };
  }

  // Workspace write must succeed (G7).
  const write = runRunner(runnerPath, ws, allowlistFile, ['/bin/sh', '-c', 'echo in-ws > ws.txt && [ -s ws.txt ]'], ws);
  if (write.code !== 0) {
    return { ok: false, detail: `workspace write under confinement failed: exit ${write.code}` };
  }

  return { ok: true, detail: 'self-test passed (shell, node, workspace rw, outside denied)' };
}

/**
 * Probe OS-filesystem isolation for this host. Cached per process; callers
 * that need a definitive per-instance answer should call after ensuring the
 * result is representative (platform cannot change mid-process).
 */
export function probeOsFilesystemIsolation(): OsFilesystemProbe {
  if (probeCache) return probeCache;

  if (process.platform !== 'linux') {
    // macOS: Seatbelt filesystem profile is a pending candidate, not an
    // enforced guarantee, so there is no definitive answer yet (unknown).
    // Windows: no unprivileged native mechanism (unsupported).
    probeCache = process.platform === 'darwin'
      ? { status: 'unknown', reason: 'macOS Seatbelt filesystem profile is pending validation (RFC 0006)' }
      : { status: 'unsupported', reason: `no OS-filesystem isolation on ${process.platform} (RFC 0006)` };
    return probeCache;
  }

  let runnerPath: string;
  try {
    runnerPath = compileRunner().runnerPath;
  } catch (err) {
    probeCache = { status: 'unknown', reason: String((err as Error).message) };
    return probeCache;
  }

  let allowlistFile: string;
  try {
    allowlistFile = ensureAllowlistFile(true).allowlistFile;
  } catch (err) {
    probeCache = { status: 'unknown', reason: String((err as Error).message) };
    return probeCache;
  }

  // Distinguish kernel-provided unsupported from setup failure: a compiled
  // runner that exits non-zero because Landlock is unavailable/too old means
  // the platform cannot provide the mechanism; a confusing failure (runner
  // missing, wrong binary) is a probe/setup problem (unknown). The dry run
  // must use an allowlisted binary (/bin/sh) so a working host actually
  // succeeds instead of failing with EACCES before the real self-test.
  const dry = runRunner(runnerPath, fs.mkdtempSync(path.join(os.tmpdir(), 'palmshed-osfs-')), allowlistFile, ['/bin/sh', '-c', 'true']);
  const stderr = dry.stderr || '';
  if (dry.code !== 0 && /Landlock (unavailable|ABI \d+ is too old)/.test(stderr)) {
    probeCache = {
      status: 'unsupported',
      reason: stderr.trim(),
      runnerPath,
      allowlistFile,
    };
    return probeCache;
  }

  const test = selfTest(runnerPath, allowlistFile);
  if (!test.ok) {
    probeCache = { status: 'unknown', reason: test.detail, runnerPath, allowlistFile };
    return probeCache;
  }

  probeCache = {
    status: 'supported',
    reason: test.detail,
    runnerPath,
    allowlistFile,
  };
  return probeCache;
}

/** Reset caches (test isolation only). */
export function resetOsFilesystemProbeCache(): void {
  probeCache = null;
  runnerCache = null;
  allowlistCache = null;
}