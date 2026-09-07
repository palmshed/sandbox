#!/usr/bin/env node
/**
 * scripts/verify-conformance.mjs
 *
 * Specification conformance gate: the cross-SDK compliance suite plus the
 * Technology Compatibility Kit. CI (ci.yml, compliance.yml, release.yml) and
 * `npm run preflight` invoke this same script.
 */
import { REPO_ROOT, SDK_DIR, ensureNpmInstall, ensureSdkBuild, run, expandGlob, nodeTestCounts, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();

const PATTERNS = [
  'compliance/sdk/*.test.js',
  'compliance/backends/*.test.js',
  'tck/*/*.test.js',
];

function main() {
  const install = ensureNpmInstall(SDK_DIR, 'typescript');
  if (!install.ok) {
    report.check('SDK deps install', false, install.stderr.trim());
    process.exit(report.finish());
  }
  const build = ensureSdkBuild();
  if (!build.ok) {
    report.check('SDK build', false, build.stderr.trim().split('\n').slice(-3).join(' '));
    process.exit(report.finish());
  }

  // Expanded in-process: the test runner only expands globs on Node 21+, but
  // CI pins Node 20 where bash/cmd globbing is unavailable on Windows.
  const files = expandGlob(PATTERNS);
  const res = run('node', ['--test', ...files], { cwd: REPO_ROOT, timeoutMs: 600000 });
  const counts = nodeTestCounts(res.stdout + '\n' + res.stderr);
  const summary = counts && counts.tests != null ? `${counts.pass}/${counts.tests} tests` : 'no test summary';
  const ok = res.ok && counts?.fail === 0;
  if (!ok) {
    // The captured TAP output never reaches the CI log otherwise, leaving
    // red runs without failing test names. Print the failing sections.
    const lines = (res.stdout + '\n' + res.stderr).split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^not ok\b/.test(lines[i].trim())) {
        out.push(...lines.slice(i, i + 18));
      }
    }
    if (out.length) {
      console.log(`--- failing tests (${out.filter((l) => /^not ok\b/.test(l.trim())).length}) ---`);
      console.log(out.slice(0, 120).join('\n'));
    }
  }
  report.check(
    'compliance suite + TCK',
    ok,
    summary
  );

  process.exit(report.finish());
}

main();
