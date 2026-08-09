#!/usr/bin/env node
/**
 * scripts/verify-docs.mjs
 *
 * Documentation validation, mirroring docs.yml:
 *
 *   1. every required README / doc file exists (same list as the CI job),
 *   2. the API reference can be generated with Typedoc (fails on broken
 *      exports or unresolved TSDoc) and the output is produced.
 */
import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT, SDK_DIR, ensureNpmInstall, npmRun, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();

const REQUIRED_READMES = [
  'README.md',
  'AGENTS.md',
  'spec/README.md',
  'backends/README.md',
  'sdk/README.md',
  'compliance/README.md',
  'tck/README.md',
  'rfcs/README.md',
  'examples/README.md',
  '.github/workflows/README.md',
  'docs/api.md',
  'docs/errors.md',
  'docs/release-readiness.md',
  'sdk/typescript/README.md',
];

function main() {
  const skipTypedoc = process.argv.includes('--no-typedoc');

  const missing = REQUIRED_READMES.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
  report.check(
    'required READMEs present',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED_READMES.length} docs`
  );

  if (skipTypedoc) process.exit(report.finish());

  const install = ensureNpmInstall(SDK_DIR, 'typedoc');
  if (!install.ok) {
    report.check('SDK deps install', false, install.stderr.trim());
    process.exit(report.finish());
  }

  const docs = npmRun(SDK_DIR, 'docs', { timeoutMs: 300000 });
  report.check(
    'typedoc generation',
    docs.ok && fs.existsSync(path.join(SDK_DIR, 'typedoc', 'index.html')),
    docs.ok ? 'typedoc/index.html produced' : docs.stderr.trim().split('\n').slice(-3).join(' ')
  );

  process.exit(report.finish());
}

main();
