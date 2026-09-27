/**
 * src/osfs/seatbelt.ts
 *
 * RFC 0006 OS-level filesystem isolation for macOS: a Seatbelt profile
 * applied via `sandbox-exec`, the same mechanism RFC 0004 already uses for
 * network isolation. Architecture (validated by PoC): allow-default with
 * targeted denies, NOT deny-default with an allowlist. Deny-default aborts
 * processes inside dyld load (the shared-cache closure lives scattered
 * across Cryptexes paths with zero diagnostics), while targeted denies
 * enforce cleanly with EPERM failures.
 *
 * Seatbelt rules are last-match-wins, so each broad denial is followed by
 * the narrow workspace re-allow. Filters match resolved vnode paths, so
 * symlink escapes into denied subtrees are denied (E2). Confinement is
 * inherited by descendants (E7). FDs opened before confinement are not
 * revoked (same residual class as Landlock E4); the SDK holds no
 * out-of-tree FDs at spawn, which the escape suite covers.
 *
 * HOME tuning (deliberate): reads stay allowed except sensitive subpaths
 * (.ssh, .aws, .gnupg, .docker, .kube, .azure, gcloud config) so ordinary
 * npm/git dotfile reads keep working; writes to $HOME are denied wholesale
 * (matching Linux strictness). $HOME reads outside the sensitive set are a
 * declared macOS residual, recorded per-escape-test, not pretended away.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** User-secret subpaths denied for read (relative to $HOME). */
const SENSITIVE_HOME_SUBPATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
  '.azure',
  '.config/gcloud',
];

/**
 * Build the Seatbelt profile text for a workspace. networkDisabled appends
 * the same network denial the existing macOS network path uses, so one
 * sandbox-exec invocation enforces both.
 */
export function buildSeatbeltProfile(
  workspaceRealDir: string,
  homeDir: string,
  networkDisabled: boolean
): string {
  const q = (p: string) => `"${p}"`;
  const lines = ['(version 1)', '(allow default)'];
  // Read denials: system secrets.
  lines.push(`(deny file-read* (subpath ${q('/etc')}) (subpath ${q('/private/etc')}))`);
  // Read denials: user secrets (tuned set; ordinary dotfiles stay readable).
  lines.push(
    `(deny file-read* ${SENSITIVE_HOME_SUBPATHS.map((s) => `(subpath ${q(path.join(homeDir, s))})`).join(' ')})`
  );
  // Read denials: foreign temp, then the workspace re-allow.
  lines.push(
    `(deny file-read* (subpath ${q('/tmp')}) (subpath ${q('/private/tmp')}) (subpath ${q('/private/var/folders')}))`
  );
  lines.push(`(allow file-read* (subpath ${q(workspaceRealDir)}))`);
  // Write denials: everything outside the workspace, then re-allow it.
  lines.push(
    `(deny file-write* (subpath ${q('/tmp')}) (subpath ${q('/private/tmp')}) (subpath ${q('/private/var/folders')}) (subpath ${q('/etc')}) (subpath ${q('/private/etc')}) (subpath ${q('/Users')}))`
  );
  lines.push(`(allow file-write* (subpath ${q(workspaceRealDir)}))`);
  // Traction literals: node and other runtimes lstat ancestor dirs at
  // startup (TMPDIR resolution), so every ancestor of the workspace up to
  // / must be stata ble/traversable. Literals match exactly those dirs
  // (sibling names visible, sibling contents still denied by the subpath
  // denies above); this mirrors the Linux traction-dir grants. Neither
  // /etc nor /tmp themselves are listed here, so G3/E-denials keep biting.
  const ancestors: string[] = [];
  let dir = path.dirname(workspaceRealDir);
  while (true) {
    ancestors.unshift(dir);
    if (dir === '/') break;
    dir = path.dirname(dir);
  }
  lines.push(`(allow file-read* ${ancestors.map((d) => `(literal ${q(d)})`).join(' ')})`);
  // Standard sinks stay usable.
  lines.push(`(allow file-read* (literal ${q('/dev/null')}) (literal ${q('/dev/urandom')}))`);
  lines.push(`(allow file-write* (literal ${q('/dev/null')}))`);
  if (networkDisabled) lines.push('(deny network*)');
  return lines.join('\n');
}

export interface SeatbeltProbe {
  ok: boolean;
  detail: string;
}

function runProfile(profile: string, cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, cmd, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return {
    code: res.status ?? 1,
    stdout: (res.stdout ?? '').toString(),
    stderr: (res.stderr ?? '').toString(),
  };
}

/**
 * Self-test the Seatbelt mechanism on this host: shell and node run inside
 * a temp workspace, an outside read is denied, a workspace write works.
 * Mirrors the Landlock selfTest contract (ok/detail) so the probe can
 * promote the capability on a pass.
 */
export function selfTestSeatbelt(): SeatbeltProbe {
  if (process.platform !== 'darwin') {
    return { ok: false, detail: 'Seatbelt confinement is macOS-only' };
  }
  try {
    spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/true'], {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch {
    return { ok: false, detail: 'sandbox-exec is unavailable on this host' };
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'palmshed-seatbelt-'));
  try {
    // Profile is built against this probe workspace for validation only;
    // the backend rebuilds it per sandbox at exec time.
    const profile = buildSeatbeltProfile(fs.realpathSync(ws), os.homedir(), false);
    const shell = runProfile(profile, '/bin/sh', ['-c', 'echo confined-ok']);
    if (shell.code !== 0 || !shell.stdout.includes('confined-ok')) {
      return { ok: false, detail: `shell under Seatbelt failed: exit ${shell.code}` };
    }
    const node = runProfile(profile, '/usr/bin/env', ['node', '-e', 'console.log("node-ok")']);
    if (node.code !== 0 || !node.stdout.includes('node-ok')) {
      return { ok: false, detail: `node under Seatbelt failed: exit ${node.code} ${node.stderr.trim()}` };
    }
    const outside = runProfile(profile, '/bin/cat', ['/etc/passwd']);
    if (outside.code === 0 && outside.stdout.length > 0) {
      return { ok: false, detail: 'outside read was NOT denied under Seatbelt' };
    }
    const write = runProfile(profile, '/bin/sh', ['-c', `echo data > ${path.join(ws, 'probe.txt')}`]);
    if (write.code !== 0) {
      return { ok: false, detail: `workspace write under Seatbelt failed: exit ${write.code}` };
    }
    return { ok: true, detail: 'shell+node run, outside read denied, workspace write works' };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}
