#!/usr/bin/env node
/**
 * scripts/verify-workflows.mjs
 *
 * Structural validation of every GitHub Actions workflow under .github/workflows:
 *
 *   1. each file parses as YAML,
 *   2. each declares name, a non-empty `on` trigger, and at least one job,
 *   3. each job has runs-on and at least one step,
 *   4. each step has exactly one of `uses` or `run`,
 *   5. every `uses:` reference is pinned to an owner/repo@ref,
 *   6. least-privilege policy: an explicit `permissions` block is present
 *      (release.yml may add id-token: write).
 *
 * Requires the repo-root dev dependency (yaml): `npm ci` at the repo root.
 */
import * as fs from 'fs';
import * as path from 'path';
import { WORKFLOWS_DIR, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();

const { default: YAML } = await import('yaml').catch(() => {
  console.error('yaml is not installed at the repo root. Run: npm ci');
  process.exit(2);
});

function main() {
  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

  let parseOk = true;
  let structuralOk = true;
  const details = [];

  for (const file of files) {
    const abs = path.join(WORKFLOWS_DIR, file);
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(abs, 'utf-8'));
    } catch (err) {
      parseOk = false;
      details.push(`${file}: YAML parse error: ${err.message.split('\n')[0]}`);
      continue;
    }

    const problems = [];
    if (!doc || typeof doc !== 'object') {
      problems.push('not a YAML mapping');
    } else {
      if (!doc.name) problems.push('missing name');
      if (!doc.on || (typeof doc.on === 'object' && Object.keys(doc.on).length === 0)) problems.push('missing/empty on');
      if (!doc.jobs || typeof doc.jobs !== 'object' || Object.keys(doc.jobs).length === 0) problems.push('missing jobs');
      if (!doc.permissions) problems.push('missing permissions (least-privilege policy)');

      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        if (!job || typeof job !== 'object') {
          problems.push(`job ${jobName}: not a mapping`);
          continue;
        }
        if (!job['runs-on']) problems.push(`job ${jobName}: missing runs-on`);
        const steps = job.steps;
        if (!Array.isArray(steps) || steps.length === 0) {
          problems.push(`job ${jobName}: missing steps`);
        } else {
          for (const [i, step] of steps.entries()) {
            const hasUses = typeof step?.uses === 'string';
            const hasRun = typeof step?.run === 'string';
            if (hasUses === hasRun) {
              problems.push(`job ${jobName} step ${i + 1}: must have exactly one of uses/run`);
            }
            if (hasUses && !/^[^/\s]+\/[^/\s]+@[^/\s]+$/.test(step.uses)) {
              problems.push(`job ${jobName} step ${i + 1}: uses not pinned (owner/repo@ref): ${step.uses}`);
            }
          }
        }
      }
    }

    if (problems.length) {
      structuralOk = false;
      details.push(`${file}: ${problems.join('; ')}`);
    }
  }

  report.check('workflow YAML parses', parseOk, `${files.length} files`);
  report.check('workflow structure', structuralOk, structuralOk ? '' : details.join(' | '));
  process.exit(report.finish());
}

main();
