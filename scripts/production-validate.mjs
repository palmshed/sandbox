#!/usr/bin/env node
/**
 * scripts/production-validate.mjs
 *
 * Real-world production scenarios against the packed release artifact:
 *
 *   1. build + pack + install the artifact into the repo-root node_modules,
 *   2. run the entire production suite (production/run.mjs),
 *   3. run a soak smoke (override with PRODUCTION_SOAK_MINUTES /
 *      PRODUCTION_SOAK_SANDBOXES).
 *
 * CI (production.yml) and the `npm run production:validate` local command
 * invoke this same script. The suite always resolves the packed artifact,
 * never the workspace dist.
 *
 * --soak-only: skip the scenario suite and run only the soak (the nightly
 *   sustained-endurance run in scheduled-tests.yml uses this).
 * --verbose:   pass through to the soak driver.
 */
import * as fss from 'fs';
import * as path from 'path';
import { REPO_ROOT, ensureArtifact, run, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();
const soakOnly = process.argv.includes('--soak-only');
const soakVerbose = process.argv.includes('--verbose');

function main() {
  try {
    const tgz = ensureArtifact();
    const installed = requireArtifactVersion();
    report.check('pack + install artifact', true, `${installed ?? '?'} (${path.basename(tgz)})`);
  } catch (err) {
    report.check('pack + install artifact', false, err.message);
    process.exit(report.finish());
  }

  if (!soakOnly) {
    const suite = run('node', ['production/run.mjs'], { cwd: REPO_ROOT, timeoutMs: 1500000 });
    const passed = (suite.stdout.match(/^PASS\s/gm) ?? []).length;
    const failed = (suite.stdout.match(/^FAIL\s/gm) ?? []).length;
    report.check(
      'production suite',
      suite.ok && failed === 0,
      `${passed} scenarios passed, ${failed} failed`
    );
    if (!suite.ok) {
      // Dump the scenario detail so CI logs carry the root cause (which
      // scenario, which step, and any residue) instead of only the summary.
      console.log('\n--- production suite output (failed) ---');
      console.log(suite.stdout.trim());
      if (suite.stderr.trim()) console.error(suite.stderr.trim());
      console.log('--- end production suite output ---\n');
    }
  }

  const soakMinutes = process.env.PRODUCTION_SOAK_MINUTES ?? '1';
  const soakSandboxes = process.env.PRODUCTION_SOAK_SANDBOXES ?? '5';
  const soakArgs = ['production/soak/soak.mjs', '--minutes', soakMinutes, '--sandboxes', soakSandboxes];
  if (soakVerbose) soakArgs.push('--verbose');
  const soak = run('node', soakArgs, { cwd: REPO_ROOT, timeoutMs: 900000 });
  const soakOk = soak.ok && /failures\s+: 0/.test(soak.stdout);
  const soakSummary = (soak.stdout.match(/iterations\/s\s+: [0-9.]+/) ?? [])[0] ?? '';
  report.check(
    `soak smoke (${soakMinutes} min × ${soakSandboxes})`,
    soakOk,
    soakOk ? soakSummary : soak.stdout.split('\n').filter((l) => l.includes('failure')).slice(0, 3).join(' ')
  );

  process.exit(report.finish());
}

function requireArtifactVersion() {
  try {
    return JSON.parse(
      fss.readFileSync(path.join(REPO_ROOT, 'node_modules', '@palmshed', 'sandbox', 'package.json'), 'utf-8')
    ).version;
  } catch {
    return null;
  }
}

main();
