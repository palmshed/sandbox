#!/usr/bin/env node
/**
 * scripts/verify-consumer.mjs
 *
 * Isolated consumer integration test: examples/consumer-test/run.sh builds,
 * packs, and installs the artifact into an isolated consumer project, then
 * runs the consumer suite against the packed package (not the workspace
 * source). The consumer fixture files are restored afterward so the working
 * tree stays clean. Requires bash (present on every GitHub-hosted runner).
 */
import * as fss from 'fs';
import * as path from 'path';
import { REPO_ROOT, run, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();
const CONSUMER_DIR = path.join(REPO_ROOT, 'examples', 'consumer-test');

function main() {
  const backup = {};
  for (const file of ['package.json', 'package-lock.json']) {
    const abs = path.join(CONSUMER_DIR, file);
    backup[file] = fss.existsSync(abs) ? fss.readFileSync(abs, 'utf-8') : null;
  }

  let res;
  try {
    res = run('bash', ['examples/consumer-test/run.sh'], { cwd: REPO_ROOT, timeoutMs: 600000 });
  } catch (err) {
    report.check(
      'consumer integration test',
      false,
      `bash unavailable (${err.message}); required, matches GitHub-hosted runners`
    );
    process.exit(report.finish());
  } finally {
    for (const file of Object.keys(backup)) {
      const abs = path.join(CONSUMER_DIR, file);
      if (backup[file] === null) {
        fss.rmSync(abs, { force: true });
      } else {
        fss.writeFileSync(abs, backup[file]);
      }
    }
  }

  report.check(
    'consumer integration test',
    res.ok,
    res.ok ? 'passed' : res.stdout.split('\n').filter((l) => l.trim()).slice(-3).join(' ') || res.stderr.trim().slice(-200)
  );
  process.exit(report.finish());
}

main();
