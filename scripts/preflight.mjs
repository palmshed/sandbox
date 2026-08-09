#!/usr/bin/env node
/**
 * scripts/preflight.mjs
 *
 * Repository preflight: reproduces the deterministic repository-level gates
 * that GitHub Actions performs, using the SAME underlying scripts. If
 * `npm run preflight` passes locally, the repository checks CI performs
 * should pass too.
 *
 * Modes:
 *   npm run preflight:quick   developer feedback in seconds
 *   npm run preflight         everything deterministic (default)
 *   npm run preflight:release everything + release-readiness + clean tree
 *
 * Real-world production scenarios (packed artifact, concurrency, recovery,
 * soak) run separately via: npm run production:validate
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import { run, ensureNpmInstall, sdkVersion, REPO_ROOT, SDK_DIR, gitPorcelain } from './lib/preflight-lib.mjs';

const SCRIPT = (name) => path.join(REPO_ROOT, 'scripts', name);
const NODE = process.execPath;

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'normal';
if (!['quick', 'normal', 'release'].includes(mode)) {
  console.error(`unknown mode: ${mode} (use quick | normal | release)`);
  process.exit(2);
}

function time(fn) {
  const started = Date.now();
  const result = fn();
  return { ...result, ms: Date.now() - started };
}

/** Run a gate script; returns { ok, detail, ms }. */
function gate(label, script, extraArgs = [], opts = {}) {
  const res = time(() => run(NODE, [SCRIPT(script), ...extraArgs], { cwd: REPO_ROOT, ...opts }));
  const matches = [...res.stdout.matchAll(/^\s*(PASS|FAIL|SKIP)\s+.+?\((.*)\)\s*$/gm)];
  const last = matches[matches.length - 1];
  const detail = res.ok
    ? (last?.[2] ?? '')
    : res.stdout.split('\n').filter((l) => /FAIL|Error|assertion/.test(l)).slice(0, 2).join(' ') ||
      res.stderr.trim().split('\n').slice(-1)[0] ||
      '';
  results.push({ label, ok: res.ok, detail, ms: res.ms });
  return res;
}

const results = [];

// ── 0. dependency verification ────────────────────────────────────────
function depsGate() {
  const started = Date.now();
  const root = ensureNpmInstall(REPO_ROOT, 'ajv');
  const sdk = ensureNpmInstall(SDK_DIR, 'typescript');
  const ok = root.ok && sdk.ok;
  results.push({
    label: 'Deps',
    ok,
    detail: ok
      ? `${root.skipped ? 'root cached' : 'root installed'}, ${sdk.skipped ? 'sdk cached' : 'sdk installed'}`
      : `${root.stderr || sdk.stderr}`.trim().slice(0, 120),
    ms: Date.now() - started,
  });
  return ok;
}

// ── gate registry ──────────────────────────────────────────────────────
const gates = {
  quick: [
    ['Git state', 'verify-gitstate.mjs', []],
    ['Punctuation', 'punctuation-check.mjs', []],
    ['Documentation', 'verify-docs.mjs', ['--no-typedoc']],
    ['SDK typecheck', 'verify-sdk.mjs', ['--typecheck-only']],
  ],
  normal: [
    ['SDK', 'verify-sdk.mjs', []],
    ['Compliance/TCK', 'verify-conformance.mjs', []],
    ['Repro', 'verify-repro.mjs', []],
    ['Examples', 'verify-examples.mjs', [], { timeoutMs: 600000 }],
    ['Consumer', 'verify-consumer.mjs', [], { timeoutMs: 600000 }],
    ['Punctuation', 'punctuation-check.mjs', []],
    ['Schemas', 'verify-schemas.mjs', [], { timeoutMs: 120000 }],
    ['Documentation', 'verify-docs.mjs', []],
    ['Workflows', 'verify-workflows.mjs', []],
    ['Package', 'verify-package.mjs', []],
    ['Git state', 'verify-gitstate.mjs', []],
  ],
  release: [],
};

let order;
if (mode === 'quick') order = gates.quick;
else if (mode === 'normal') order = gates.normal;
else {
  order = [...gates.normal, ['Release readiness', 'verify-release.mjs', []]];
}

// ── run ────────────────────────────────────────────────────────────────
console.log('Palmshed Sandbox Preflight');
console.log(`mode ${mode} / ${process.platform} / node ${process.version} / SDK v${sdkVersion()}`);
console.log('');

const depsOk = depsGate();
if (!depsOk && mode !== 'quick') {
  // Continuing would produce misleading failures; surface the install error.
}

let cleanCheckAfter = false;
for (const [label, script, extra, opts = {}] of order) {
  if (mode === 'release' && label === 'Git state') {
    // Release mode additionally requires a clean working tree at the end.
    cleanCheckAfter = true;
    gate(label, script, ['--clean'], opts);
    continue;
  }
  gate(label, script, extra, opts);
}

if (cleanCheckAfter) {
  const started = Date.now();
  const porcelain = gitPorcelain();
  const clean = porcelain === '';
  results.push({
    label: 'Working tree clean',
    ok: clean,
    detail: clean ? '' : porcelain.split('\n').slice(0, 4).join('; '),
    ms: Date.now() - started,
  });
}

// ── summary ────────────────────────────────────────────────────────────
const width = Math.max(...results.map((r) => r.label.length)) + 2;
console.log('');
for (const r of results) {
  const icon = r.ok ? '✓' : '✗';
  const padded = r.label.padEnd(width);
  console.log(`  ${icon} ${padded}${r.detail ? ` ${r.detail}` : ''}   (${(r.ms / 1000).toFixed(1)}s)`);
}

const failed = results.filter((r) => !r.ok);
const totalSec = (results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1);
console.log('');
if (failed.length === 0) {
  console.log(`Preflight: PASS (${results.length} checks, ${totalSec}s)`);
  process.exitCode = 0;
} else {
  console.log(`Preflight: FAIL (${failed.length}/${results.length} checks failed)`);
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail || 'failed'}`);
  process.exitCode = 1;
}
