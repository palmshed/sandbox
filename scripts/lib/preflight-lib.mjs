/**
 * scripts/lib/preflight-lib.mjs
 *
 * Shared helpers for the repository verification scripts. CI workflows and
 * `npm run preflight` invoke the same scripts, so a green local run predicts a
 * green repository-level gate.
 *
 * All helpers are cross-platform (Node, no shell), mirroring how GitHub-hosted
 * runners behave on Windows, macOS, and Ubuntu.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SDK_DIR = path.join(REPO_ROOT, 'sdk', 'typescript');
export const SPEC_DIR = path.join(REPO_ROOT, 'spec');
export const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/** Run a command synchronously; returns { code, stdout, stderr, ok }. */
export function run(command, args, options = {}) {
  const spawnOpts = {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...(options.env ?? {}), CI: '1' },
    shell: process.platform === 'win32',
  };
  if (options.timeoutMs) spawnOpts.timeout = options.timeoutMs;
  const res = spawnSync(command, args, spawnOpts);
  return {
    ok: res.status === 0,
    code: res.status,
    signal: res.signal,
    stdout: (res.stdout ?? '').toString(),
    stderr: (res.stderr ?? '').toString(),
  };
}

/** Run an npm lifecycle command inside a directory. */
export function npmRun(cwd, script, options = {}) {
  return run('npm', ['run', script], { ...options, cwd });
}

/** `npm ci` inside a directory when node_modules is missing or incomplete. */
export function ensureNpmInstall(dir, marker = 'typescript', options = {}) {
  const nm = path.join(dir, 'node_modules');
  if (fs.existsSync(path.join(nm, marker))) {
    return { ok: true, skipped: true, stdout: '', stderr: '' };
  }
  const hasLockfile = fs.existsSync(path.join(dir, 'package-lock.json'));
  const cmd = hasLockfile ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
  const res = run('npm', cmd, { ...options, cwd: dir, timeoutMs: 600000 });
  return { ...res, skipped: false, installedWith: hasLockfile ? 'ci' : 'install' };
}

/** True when the root dev dependencies (ajv, yaml) are installed. */
export function rootDepsInstalled() {
  return (
    fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'yaml')) &&
    fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'ajv'))
  );
}

/** Version string from sdk/typescript/package.json. */
export function sdkVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SDK_DIR, 'package.json'), 'utf-8'));
  return pkg.version;
}

/** Version string from spec/version.md ('Current Specification Version: **1.0.0**'). */
export function specVersion() {
  const md = fs.readFileSync(path.join(SPEC_DIR, 'version.md'), 'utf-8');
  const m = md.match(/Current Specification Version:\s*\*{1,2}([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?)\*{1,2}/);
  return m ? m[1] : null;
}

/** The git tag pointing at HEAD, or null when HEAD is not tagged. */
export function gitTagAtHead() {
  const res = run('git', ['tag', '--points-at', 'HEAD'], { cwd: REPO_ROOT });
  const tags = res.stdout.split('\n').map((t) => t.trim()).filter(Boolean);
  return tags.length ? tags[0] : null;
}

/** Working-tree porcelain status; '' when clean. */
export function gitPorcelain() {
  const res = run('git', ['status', '--porcelain'], { cwd: REPO_ROOT });
  return res.stdout;
}

/** List files tracked by git matching a path prefix. */
export function gitTrackedFiles(prefix) {
  const res = run('git', ['ls-files', '--', prefix], { cwd: REPO_ROOT });
  return res.stdout.split('\n').filter(Boolean);
}

/**
 * Parse `node --test` output for test counts, regardless of reporter
 * (spec: 'ℹ tests 44'; tap: '# tests 44').
 */
export function nodeTestCounts(output) {
  const last = (re) => {
    const m = [...output.matchAll(re)];
    return m.length ? Number(m[m.length - 1][1]) : null;
  };
  return {
    tests: last(/(?:ℹ|#)\s*tests\s+(\d+)/g),
    pass: last(/(?:ℹ|#)\s*pass\s+(\d+)/g),
    fail: last(/(?:ℹ|#)\s*fail\s+(\d+)/g),
  };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Expand glob patterns (for example 'compliance/sdk/*.test.js' and
 * 'tck'/<area>/'*.test.js') into relative file paths, recursively, with no
 * shell involved. The test runner only expands globs itself on Node 21+, so
 * scripts must expand them for CI to behave identically on Node 20 (which CI
 * pins).
 */
export function expandGlob(patterns) {
  const results = [];
  for (const pattern of patterns) {
    const parts = pattern.split('/');
    const walk = (dir, i) => {
      if (i === parts.length) {
        if (fs.existsSync(dir)) results.push(path.relative(REPO_ROOT, dir).split(path.sep).join('/'));
        return;
      }
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (!/[?*]/.test(part)) {
        walk(path.join(dir, part), i + 1);
        return;
      }
      const re = new RegExp('^' + part.split('*').map(escapeRegExp).join('.*') + '$');
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if ((isLast ? entry.isFile() : entry.isDirectory()) && re.test(entry.name)) {
          walk(path.join(dir, entry.name), i + 1);
        }
      }
    };
    walk(REPO_ROOT, 0);
  }
  return [...new Set(results)].sort();
}

/** Parse repro/run.js summary: '18 passed, 0 skipped (network unavailable), 0 failures'. */
export function reproCounts(output) {
  const m = output.match(/(\d+)\s+passed,\s+(\d+)\s+skipped[^,]*,\s+(\d+)\s+failures?/);
  return m ? { passed: Number(m[1]), skipped: Number(m[2]), failures: Number(m[3]) } : null;
}

/** Build the SDK (tsc) if the compiled output is missing or stale. */
export function ensureSdkBuild(options = {}) {
  const distIndex = path.join(SDK_DIR, 'dist', 'index.js');
  const pkg = path.join(SDK_DIR, 'package.json');
  if (!fs.existsSync(distIndex)) {
    const res = npmRun(SDK_DIR, 'build', options);
    return { ...res, rebuilt: true };
  }
  const srcFiles = gitTrackedFiles(path.join('sdk', 'typescript', 'src')).map((f) =>
    path.join(REPO_ROOT, f)
  );
  const newestSrc = srcFiles.reduce(
    (max, f) => Math.max(max, fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0),
    0
  );
  if (newestSrc > fs.statSync(distIndex).mtimeMs) {
    const res = npmRun(SDK_DIR, 'build', options);
    return { ...res, rebuilt: true };
  }
  return { ok: true, rebuilt: false, stdout: '', stderr: '' };
}

/**
 * Pack the SDK and install the tarball into the repo-root node_modules, so
 * examples, the consumer test, and the production suite resolve the exact
 * package a consumer installs (never the workspace dist). Returns the tarball
 * path. Mirrors examples.yml / production.yml.
 */
export function ensureArtifact(options = {}) {
  const installDeps = ensureNpmInstall(SDK_DIR, 'typescript', options);
  if (!installDeps.ok) throw new Error(`SDK deps install failed: ${installDeps.stderr.trim()}`);
  ensureSdkBuild(options);
  const pack = run('npm', ['pack', '--silent'], { ...options, cwd: SDK_DIR, timeoutMs: 120000 });
  if (!pack.ok) throw new Error(`npm pack failed: ${pack.stderr.trim()}`);
  const tgz = pack.stdout.trim().split('\n').pop().trim();
  const tgzPath = path.join(SDK_DIR, tgz);
  const install = run(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', `./sdk/typescript/${tgz}`],
    { ...options, cwd: REPO_ROOT, timeoutMs: 300000 }
  );
  if (!install.ok) throw new Error(`artifact install failed: ${install.stderr.trim()}`);
  return tgzPath;
}

/** Path to the installed package (node_modules/@palmshed/sandbox), if any. */
export function installedArtifactVersion() {
  const p = path.join(REPO_ROOT, 'node_modules', '@palmshed', 'sandbox', 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')).version;
  } catch {
    return null;
  }
}

/**
 * Tiny result collector for verification scripts. Each script prints a
 * machine-readable trailing line so the preflight orchestrator can build the
 * summary table without re-parsing arbitrary output.
 */
export class Reporter {
  constructor() {
    this.checks = [];
  }
  check(name, ok, detail = '', opts = {}) {
    this.checks.push({ name, ok, detail, ms: opts.ms, skipped: opts.skipped ?? false });
    const icon = opts.skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL';
    console.log(`  ${icon}  ${name}${detail ? `  (${detail})` : ''}`);
    return ok;
  }
  finish() {
    const failed = this.checks.filter((c) => !c.ok && !c.skipped);
    console.log(
      `\n${this.checks.filter((c) => c.ok && !c.skipped).length} passed, ` +
        `${this.checks.filter((c) => c.skipped).length} skipped, ${failed.length} failed`
    );
    return failed.length === 0 ? 0 : 1;
  }
}
