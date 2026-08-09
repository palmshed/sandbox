#!/usr/bin/env node
/**
 * scripts/verify-repro.mjs
 *
 * Reproducible Guarantee Laboratory: every guarantee and every reported bug
 * has a standalone repro (repro/<area>/*.js). Network repros auto-skip when
 * networkIsolation is unavailable on the host (Windows, or Linux CI where
 * unprivileged user namespaces are restricted). CI (ci.yml, release.yml) and
 * `npm run preflight` invoke this same script.
 */
import { REPO_ROOT, run, reproCounts, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();

function main() {
  const res = run('node', ['repro/run.js'], { cwd: REPO_ROOT, timeoutMs: 600000 });
  const counts = reproCounts(res.stdout + '\n' + res.stderr);
  const summary = counts
    ? `${counts.passed} passed, ${counts.skipped} skipped, ${counts.failures} failures`
    : 'no repro summary';
  report.check('repro laboratory', res.ok && counts?.failures === 0, summary);
  process.exit(report.finish());
}

main();
