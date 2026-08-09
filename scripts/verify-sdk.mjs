#!/usr/bin/env node
/**
 * scripts/verify-sdk.mjs
 *
 * TypeScript reference SDK gate: install deps, typecheck, build, and run the
 * unit/integration/stress suite. CI (ci.yml build-and-test and node-lts) and
 * `npm run preflight` invoke this same script.
 */
import * as path from 'path';
import { SDK_DIR, REPO_ROOT, ensureNpmInstall, npmRun, nodeTestCounts, run, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();

function main() {
  const typecheckOnly = process.argv.includes('--typecheck-only');

  // RFC 0006: the embedded Landlock runner source (landlockRunnerSource.ts)
  // must stay byte-identical to scripts/probes/landlock-run.c. Regenerate with
  // `node scripts/gen-osfs-source.mjs`; this gate catches drift on every OS CI.
  const drift = run(process.execPath, [path.join(REPO_ROOT, 'scripts', 'gen-osfs-source.mjs'), '--check'], { cwd: REPO_ROOT });
  report.check(
    'OSFS runner source drift',
    drift.ok,
    drift.ok ? '' : drift.stderr.trim().split('\n').slice(-1)[0]
  );
  if (!drift.ok) process.exit(report.finish());

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
