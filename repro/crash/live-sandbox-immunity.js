/**
 * Demonstrates: the stale-sandbox reaper never touches a live sandbox.
 *
 * A sandbox owned by the current process is registered in the crash-recovery
 * registry (RFC 0005, G4). A reaper pass must leave it intact and reusable,
 * and a reaped/destroyed sandbox must never be resurrected (G6).
 *
 * Expected: after reapStaleSandboxes() the live sandbox still executes, and a
 * fresh Sandbox.create() gets a brand-new directory. Exit 0.
 * Violated: the live sandbox is reaped, becomes unusable, or a fresh create
 * reuses a stale directory. Exit 1.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sandbox } = require('../../sdk/typescript/dist/index.js');
const { reapStaleSandboxes } = require('../../sdk/typescript/dist/core/crashRecovery.js');

function findSandboxDirWithMarker(marker) {
  let newest = '';
  let newestMtime = 0;
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('palmshed-sandbox-')) continue;
    const dir = path.join(os.tmpdir(), name);
    if (!fs.existsSync(path.join(dir, marker))) continue;
    const mtime = fs.statSync(dir).mtimeMs;
    if (mtime > newestMtime) {
      newest = dir;
      newestMtime = mtime;
    }
  }
  return newest;
}

async function main() {
  const marker = `marker-immunity-${process.pid}.txt`;
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
  await sandbox.writeFile(marker, 'keep');
  const dir = findSandboxDirWithMarker(marker);
  if (!dir) {
    throw new Error('live sandbox dir not found');
  }

  await reapStaleSandboxes(dir);

  if (!fs.existsSync(dir)) {
    throw new Error('live sandbox was reaped');
  }
  const content = (await sandbox.readFile(marker)).toString();
  if (content !== 'keep') {
    throw new Error('live sandbox contents were disturbed');
  }
  const exec = await sandbox.exec('echo immune');
  await exec.wait();
  if (exec.exitCode !== 0) {
    throw new Error('live sandbox not usable after reaper pass');
  }

  await sandbox.destroy();
  if (fs.existsSync(dir)) {
    throw new Error('destroyed sandbox dir not removed');
  }

  const fresh = await Sandbox.create({ backend: 'native', timeout: 5000 });
  await fresh.writeFile(marker, 'x');
  const freshDir = findSandboxDirWithMarker(marker);
  await fresh.destroy();
  if (!freshDir || freshDir === dir) {
    throw new Error('fresh create did not allocate a brand-new sandbox dir');
  }

  console.log('PASS: reaper leaves live sandboxes intact; fresh creates are clean');
  process.exit(0);
}

main().catch((e) => {
  console.error('VIOLATED:', e.message ?? e);
  process.exit(1);
});
