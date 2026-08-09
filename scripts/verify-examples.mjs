#!/usr/bin/env node
/**
 * scripts/verify-examples.mjs
 *
 * Runs all four usage examples against the packed release artifact (never the
 * workspace build). The examples import the '@palmshed/sandbox' package name,
 * so the artifact must first be packed and installed into the repo-root
 * node_modules, exactly as examples.yml does.
 */
import * as path from 'path';
import { REPO_ROOT, ensureArtifact, run, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();

const EXAMPLES = [
  'examples/quickstart.mjs',
  'examples/ai-agent-runner.mjs',
  'examples/code-evaluator.mjs',
  'examples/ci-runner.mjs',
];

function main() {
  try {
    ensureArtifact();
  } catch (err) {
    report.check('pack + install artifact', false, err.message);
    process.exit(report.finish());
  }

  let allOk = true;
  for (const rel of EXAMPLES) {
    const res = run('node', [rel], { cwd: REPO_ROOT, timeoutMs: 300000 });
    if (!res.ok) allOk = false;
    const tail = (res.stderr || res.stdout).trim().split('\n').slice(-2).join(' ');
    report.check(rel, res.ok, res.ok ? '' : tail);
  }

  report.check('all examples', allOk, `${EXAMPLES.length}/${EXAMPLES.length}`);
  process.exit(report.finish());
}

main();
