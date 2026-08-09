/**
 * production/run.mjs
 *
 * Runs the Production Validation Suite against the installed
 * `@palmshed/sandbox` package and reports a summary with a per-scenario
 * timing budget and residue checks.
 *
 * Usage:
 *   node production/run.mjs                 # run every scenario
 *   node production/run.mjs --list          # list scenarios without running
 *   node production/run.mjs --only ci-runner
 *   node production/run.mjs --verbose
 *
 * Exit code: 0 when every scenario passed and left no residue, 1 otherwise.
 * The suite must run against the packed release artifact, not the workspace
 * source: see production/README.md for the pack + install step.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { resolveSandboxPackage, createContext } from './lib/harness.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(root, 'scenarios');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const listOnly = args.includes('--list');
const onlyIds = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;

function log(msg = '') {
  process.stdout.write(`${msg}\n`);
}

async function loadScenarios() {
  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.mjs')).sort();
  const scenarios = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(scenariosDir, file)).href);
    const scenario = mod.default;
    if (!scenario || typeof scenario.run !== 'function') continue;
    scenarios.push({
      file,
      id: scenario.id ?? file.replace(/\.mjs$/, ''),
      title: scenario.title ?? file,
      // Windows runners are materially slower at process spawn/teardown; give
      // the platform its own headroom so the scenario asserts behavior rather
      // than wall-clock speed.
      timeoutMs: (scenario.timeoutMs ?? 60000) * (process.platform === 'win32' ? 1.5 : 1),
      platforms: scenario.platforms ?? ['darwin', 'linux', 'win32'],
      run: scenario.run,
    });
  }
  return scenarios;
}

function pad(text, width) {
  return String(text).padEnd(width);
}

async function main() {
  const { version, entry, Sandbox } = resolveSandboxPackage();
  const scenarios = await loadScenarios();
  const selected = onlyIds ? scenarios.filter((s) => onlyIds.includes(s.id)) : scenarios;

  log(`@palmshed/sandbox v${version}  (resolved: ${entry})`);
  log(`platform ${process.platform} / node ${process.version}`);
  log('');

  if (listOnly) {
    for (const s of scenarios) {
      log(`  ${pad(s.id, 20)} ${s.title}`);
    }
    return;
  }

  const results = [];
  for (const scenario of selected) {
    const label = pad(scenario.id, 20);
    if (!scenario.platforms.includes(process.platform)) {
      results.push({ id: scenario.id, status: 'SKIP', ms: 0, note: 'platform not supported' });
      log(`SKIP  ${label} ${scenario.title}  (not supported on ${process.platform})`);
      continue;
    }

    const started = Date.now();
    const { ctx, getSteps } = createContext({ Sandbox, log });
    ctx.log = (msg) => {
      if (verbose) log(`       ${msg}`);
    };
    const baseline = ctx.scanResidue();
    let failed = null;

    try {
      await Promise.race([
        scenario.run(ctx),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`exceeded timing budget of ${scenario.timeoutMs}ms`)), scenario.timeoutMs);
        }),
      ]);
    } catch (err) {
      failed = err;
    }

    const cleanupFailures = await ctx.cleanup();
    let residueNote = '';
    if (!failed) {
      try {
        ctx.assertNoResidue(baseline, scenario.id);
      } catch (err) {
        failed = err;
      }
    } else {
      const leak = ctx.diffResidue(baseline, ctx.scanResidue());
      const formatted = ctx.formatResidue(leak);
      if (formatted) residueNote = ` (also left residue: ${formatted})`;
    }

    const ms = Date.now() - started;
    const status = failed ? 'FAIL' : 'PASS';
    results.push({ id: scenario.id, status, ms, note: failed ? failed.message : '' });

    if (failed) {
      log(`FAIL  ${label} ${scenario.title}${residueNote}`);
      log(`       after ${ms}ms (budget ${scenario.timeoutMs}ms)`);
      log(`       ${failed.message}`);
      if (cleanupFailures > 0) {
        log(`       cleanup had ${cleanupFailures} destroy failure(s)`);
      }
    } else {
      const steps = getSteps();
      const stepSummary = steps.length ? `; steps: ${steps.map((s) => `${s.name}=${s.ms}ms`).join(', ')}` : '';
      log(`PASS  ${label} ${scenario.title}${stepSummary}`);
    }
  }

  log('');
  log('┌──────────────────────┬────────┬──────────┐');
  log('│ scenario             │ status │  time    │');
  log('├──────────────────────┼────────┼──────────┤');
  for (const r of results) {
    log(`│ ${pad(r.id, 20)} │ ${pad(r.status, 6)} │ ${pad(`${r.ms}ms`, 8)} │`);
  }
  log('└──────────────────────┴────────┴──────────┘');

  const passed = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const failedResults = results.filter((r) => r.status === 'FAIL');
  log('');
  log(`Suite: ${passed} passed, ${skipped} skipped, ${failedResults.length} failed`);
  if (failedResults.length) {
    log('Failed scenarios:');
    for (const r of failedResults) {
      log(`  - ${r.id}: ${r.note}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log(`Production suite failed to start: ${err.message}`);
  process.exitCode = 1;
});
