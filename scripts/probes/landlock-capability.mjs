#!/usr/bin/env node
/**
 * Landlock filesystem-isolation capability probe (RFC 0006, issue #3).
 *
 * Empirically verifies the exact assumptions RFC 0006 depends on BEFORE any
 * implementation is chosen:
 *
 *   1. The Landlock ABI is available on this kernel.
 *   2. The filesystem rights required by the RFC-style guarantee are
 *      supported by that ABI (read/write/execute, make/remove, and REFER for
 *      hardlink/rename semantics on ABI >= 2).
 *   3. An unprivileged process can create and apply the ruleset.
 *   4. The ruleset is inherited by a descendant process.
 *   5. Access outside the allowlist is denied, including a workspace symlink
 *      that points outside it.
 *   6. The probe cleanly distinguishes supported / unsupported / unknown.
 *
 * This probe is NOT the SDK sandbox path. Passing it proves the kernel
 * mechanism is available and behaves; it does NOT justify marking
 * `osFilesystemIsolation: supported`. That flag becomes supported only after
 * the actual sandbox path passes the RFC 0006 escape suite.
 *
 * Usage: node scripts/probes/landlock-capability.mjs [--json]
 */

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = {
  probe: 'landlock',
  platform: process.platform,
  arch: os.arch(),
  user: os.userInfo().username,
  euid: process.getuid?.() ?? null,
  results: {},
};

const record = (key, value) => {
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  OUT.results[key] = str;
  const pfx = value === true ? 'PASS' : value === false ? 'FAIL' : 'INFO';
  if (!process.argv.includes('--json')) console.log(`  [${pfx}] ${key}: ${str}`);
};

if (process.platform !== 'linux') {
  OUT.results['landlock.apply'] = 'skipped';
  record('platform support', `probe is Linux-only (running on ${process.platform})`);
  record('verdict', 'unknown');
  if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
  process.exit(0);
}

// ── build and run the C helper ──────────────────────────────────────────
let ccAvailable = true;
try {
  execFileSync('cc', ['--version'], { stdio: 'ignore' });
} catch {
  ccAvailable = false;
  record('cc', 'not available');
  record('verdict', 'unknown');
  record('reason', 'no cc to compile the landlock probe helper');
  if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
  process.exit(0);
}

const probeDir = path.join(os.tmpdir(), `palmshed-landlock-${process.pid}-${Date.now()}`);
const srcPath = new URL('./landlock-probe.c', import.meta.url);
const binPath = path.join(probeDir, 'landlock-probe');
fs.mkdirSync(probeDir, { recursive: true });
fs.copyFileSync(srcPath, path.join(probeDir, 'landlock-probe.c'));

let compileOk = false;
try {
  execFileSync('cc', ['-O2', '-o', binPath, path.join(probeDir, 'landlock-probe.c')], { stdio: 'ignore' });
  compileOk = true;
  record('cc', 'ok');
} catch (e) {
  record('cc.compile', `failed: ${String(e.stderr ?? e.message).trim()}`);
}
if (!compileOk) {
  record('verdict', 'unknown');
  record('reason', 'probe helper failed to compile');
  fs.rmSync(probeDir, { recursive: true, force: true });
  if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
  process.exit(0);
}

try {
  const stdout = execFileSync(binPath, [probeDir], { encoding: 'utf-8' });
  let jsonLine = null;
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (line.trimStart().startsWith('{')) {
      jsonLine = line; // trailing JSON verdict line
      continue;
    }
    OUT.results[key] = value;
    if (!process.argv.includes('--json')) console.log(`  [INFO] ${key}: ${value}`);
  }
  if (jsonLine) {
    const parsed = JSON.parse(jsonLine);
    OUT.results['verdict'] = parsed.verdict;
    OUT.results['abi'] = String(parsed.abi);
    OUT.results['refer_supported'] = parsed.refer;
  }
} catch (e) {
  record('probe.run', `helper exited ${e.status ?? '?'} (${String(e.stdout ?? e.message).trim().slice(0, 200)})`);
  record('verdict', 'unknown');
  record('reason', 'probe helper did not complete cleanly');
} finally {
  fs.rmSync(probeDir, { recursive: true, force: true });
}

if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));