/**
 * Runs every repro in the laboratory and reports a summary.
 *
 * Usage: node repro/run.js [--network]
 *
 * By default the network repros are skipped because they document the open
 * RFC 0004 gap and are expected to fail. Pass --network to include them.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const includeNetwork = process.argv.includes('--network');

const dirs = ['cpu', 'memory', 'process', 'disk'];
if (includeNetwork) dirs.push('network');

let passed = 0;
let failed = 0;
const failures = [];

for (const dir of dirs) {
  const dirPath = path.join(root, dir);
  for (const file of fs.readdirSync(dirPath).filter((f) => f.endsWith('.js')).sort()) {
    const script = path.join(dirPath, file);
    try {
      execFileSync(process.execPath, [script], { stdio: ['ignore', 'inherit', 'inherit'] });
      passed += 1;
      console.log(`PASS  ${dir}/${file}`);
    } catch (e) {
      failed += 1;
      failures.push(`${dir}/${file}`);
      console.log(`FAIL  ${dir}/${file}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
process.exit(0);
