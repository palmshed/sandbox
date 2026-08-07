/**
 * Runs every repro in the laboratory and reports a summary.
 *
 * Usage: node repro/run.js [--verbose]
 *
 * Network repros always run. With RFC 0004 implemented (networkIsolation: true),
 * they are real pass/fail assertions, not expected failures.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const verbose = process.argv.includes('--verbose') || process.argv.includes('--network');
const dirs = ['cpu', 'memory', 'process', 'disk', 'network'];

let passed = 0;
let unexpectedFailures = 0;
const failures = [];

for (const dir of dirs) {
  const dirPath = path.join(root, dir);
  for (const file of fs.readdirSync(dirPath).filter((f) => f.endsWith('.js')).sort()) {
    const script = path.join(dirPath, file);
    const label = `${dir}/${file}`;
    try {
      execFileSync(process.execPath, [script], {
        stdio: verbose || dir !== 'network' ? ['ignore', 'inherit', 'inherit'] : 'pipe',
      });
      passed += 1;
      console.log(`PASS  ${label}`);
    } catch (e) {
      if (!verbose) {
        console.error(`  exit code: ${e.status}`);
        console.error(e.stderr ? e.stderr.toString().split('\n').filter(l => l.trim()).slice(-3).join('\n') : '');
      }
      console.error(`FAIL  ${label}`);
      unexpectedFailures += 1;
      failures.push(label);
    }
  }
}

console.log(`\n${passed} passed, ${unexpectedFailures} failures`);
if (failures.length) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
process.exit(0);
