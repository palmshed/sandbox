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
  report.check(
    'compliance suite + TCK',
    res.ok && counts?.fail === 0,
    summary
  );

  process.exit(report.finish());
}

main();
