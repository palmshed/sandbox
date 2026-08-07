/**
 * Runs every repro in the laboratory and reports a summary.
 *
 * Usage: node repro/run.js [--network]
 *
 * Network repros always run. Because networkIsolation is not yet
 * implemented on the Native backend, their failures are classified as
 * expected failures. Pass --network for verbose output on network repros.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const verboseNetwork = process.argv.includes('--network');

const dirs = ['cpu', 'memory', 'process', 'disk', 'network'];

let passed = 0;
let expectedFailures = 0;
let unexpectedFailures = 0;
const failures = [];

for (const dir of dirs) {
  const dirPath = path.join(root, dir);
  for (const file of fs.readdirSync(dirPath).filter((f) => f.endsWith('.js')).sort()) {
    const script = path.join(dirPath, file);
    const label = `${dir}/${file}`;
    try {
      execFileSync(process.execPath, [script], {
        stdio: verboseNetwork || dir !== 'network' ? ['ignore', 'inherit', 'inherit'] : 'pipe',
      });
      passed += 1;
      console.log(`PASS  ${label}`);
    } catch (e) {
      if (dir === 'network') {
        expectedFailures += 1;
        console.log(`FAIL  ${label} (expected)`);
      } else {
        unexpectedFailures += 1;
        failures.push(label);
        console.log(`FAIL  ${label}`);
      }
    }
  }
}

console.log(`\n${passed} passed, ${expectedFailures} expected failures, ${unexpectedFailures} unexpected failures`);
if (failures.length) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
process.exit(0);
