#!/usr/bin/env node
/**
 * scripts/verify-sdk.mjs
 *
 * TypeScript reference SDK gate: install deps, typecheck, build, and run the
 * unit/integration/stress suite. CI (ci.yml build-and-test and node-lts) and
 * `npm run preflight` invoke this same script.
 */
import { SDK_DIR, ensureNpmInstall, npmRun, nodeTestCounts, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();

function main() {
  const typecheckOnly = process.argv.includes('--typecheck-only');

  const install = ensureNpmInstall(SDK_DIR, 'typescript');
  if (!install.ok) {
    report.check('SDK deps install', false, install.stderr.trim());
    process.exit(report.finish());
  }

  const typecheck = npmRun(SDK_DIR, 'typecheck', { timeoutMs: 300000 });
  report.check(
    'SDK typecheck',
    typecheck.ok,
    typecheck.ok ? '' : typecheck.stderr.trim().split('\n').slice(-3).join(' ')
  );
  if (!typecheck.ok || typecheckOnly) process.exit(report.finish());

  const build = npmRun(SDK_DIR, 'build', { timeoutMs: 300000 });
  report.check('SDK build', build.ok, build.ok ? '' : build.stderr.trim().split('\n').slice(-3).join(' '));
  if (!build.ok) process.exit(report.finish());

  const test = npmRun(SDK_DIR, 'test', { timeoutMs: 600000 });
  const counts = nodeTestCounts(test.stdout + '\n' + test.stderr);
  const summary = counts && counts.tests != null ? `${counts.pass}/${counts.tests} tests` : 'no test summary';
  report.check(
    'SDK unit/integration/stress tests',
    test.ok && counts?.fail === 0,
    summary
  );

  process.exit(report.finish());
}

main();
