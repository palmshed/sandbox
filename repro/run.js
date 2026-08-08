/**
 * Runs every repro in the laboratory and reports a summary.
 *
 * Usage: node repro/run.js [--verbose] [--all-network]
 *
 * Network repros assert real isolation only when the active backend reports
 * `networkIsolation: true` for this instance (macOS with sandbox-exec, or
 * Linux where the unshare --user probe succeeds). When the capability is
 * unavailable (Windows, or Linux CI where user namespaces are restricted),
 * network repros are SKIPPED -- they are a measurement, not a guarantee, on
 * such hosts. Use --all-network to force-run them regardless (they will
 * likely fail where the capability is off, which is expected).
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const verbose = process.argv.includes('--verbose');
const forceNetwork = process.argv.includes('--all-network');
const dirs = ['cpu', 'memory', 'process', 'disk', 'network'];

let passed = 0;
let skipped = 0;
let unexpectedFailures = 0;
const failures = [];
const skippedLabels = [];

const networkIsolationAvailable = (() => {
  try {
    const { NativeBackend } = require(path.join(
      root,
      '..',
      'sdk',
      'typescript',
      'dist',
      'backends',
      'native.js'
    ));
    const engine = new NativeBackend();
    // init() runs the Linux unshare probe; on macOS/Windows it is a no-op for
    // the probe and networkIsolation keeps its default. We then re-read the
    // capability, which reflects the probe result.
    return engine.init({}).then(() => engine.capabilities.networkIsolation);
  } catch {
    return Promise.resolve(false);
  }
})();

(async () => {
  const networkAvailable = forceNetwork || (await networkIsolationAvailable);
  if (verbose) {
    console.log(
      `networkIsolation available: ${networkAvailable}${forceNetwork ? ' (forced via --all-network)' : ''}`
    );
  }

  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    for (const file of fs.readdirSync(dirPath).filter((f) => f.endsWith('.js')).sort()) {
      const script = path.join(dirPath, file);
      const label = `${dir}/${file}`;

      if (dir === 'network' && !networkAvailable) {
        skipped += 1;
        skippedLabels.push(label);
        console.log(`SKIP  ${label}  (networkIsolation unavailable on this host)`);
        continue;
      }

      try {
        execFileSync(process.execPath, [script], {
          stdio: verbose ? ['ignore', 'inherit', 'inherit'] : 'pipe',
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

  console.log(
    `\n${passed} passed, ${skipped} skipped (network unavailable), ${unexpectedFailures} failures`
  );
  if (skippedLabels.length) {
    console.log('Skipped:', skippedLabels.join(', '));
  }
  if (failures.length) {
    console.log('Failures:', failures.join(', '));
    process.exit(1);
  }
  process.exit(0);
})();
