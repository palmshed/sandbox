#!/usr/bin/env node
/**
 * scripts/verify-gitstate.mjs
 *
 * Working-tree and generated-file checks:
 *
 *   1. the checkout is a git repository,
 *   2. generated build/documentation artifacts (sdk/typescript/dist and
 *      sdk/typescript/typedoc) are never tracked,
 *   3. with --clean: the working tree is clean (used by release mode), so a
 *      release is cut from exactly what preflight verified.
 */
import * as fss from 'fs';
import * as path from 'path';
import { REPO_ROOT, SDK_DIR, run, gitPorcelain, gitTrackedFiles, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();
const clean = process.argv.includes('--clean');

function main() {
  const isGit = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT });
  report.check('git repository present', isGit.ok && isGit.stdout.trim() === 'true', REPO_ROOT);

  const trackedDist = gitTrackedFiles(path.join('sdk', 'typescript', 'dist'));
  const trackedTypedoc = gitTrackedFiles(path.join('sdk', 'typescript', 'typedoc'));
  const generatedOk = trackedDist.length === 0 && trackedTypedoc.length === 0;
  report.check(
    'generated artifacts untracked',
    generatedOk,
    generatedOk
      ? 'dist/ and typedoc/ not tracked'
      : `tracked: ${[...trackedDist, ...trackedTypedoc].join(', ')}`
  );

  const distDir = path.join(SDK_DIR, 'dist');
  const typedocDir = path.join(SDK_DIR, 'typedoc');
  const residue = ['dbg-ai', 'dbg-'].filter((prefix) =>
    fss.readdirSync(REPO_ROOT).some((f) => f.startsWith(prefix))
  );
  report.check('no scratch files at repo root', residue.length === 0, residue.length ? residue.join(', ') : '');

  if (clean) {
    const porcelain = gitPorcelain();
    // Untracked build output (dist, typedoc, tgz) is ignored, so a clean tree
    // here means nothing stray was left behind by the verification run.
    report.check('working tree clean', porcelain === '', porcelain ? porcelain.split('\n').slice(0, 5).join('; ') : '');
  }

  process.exit(report.finish());
}

main();
