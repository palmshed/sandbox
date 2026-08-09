/**
 * Demonstrates: a hard host crash does not leak the workload forever.
 * POSIX-only
 *
 * A host process embedding the SDK is SIGKILLed while a sandboxed workload is
 * running. Nothing can clean up synchronously, so the workload survives and
 * the temp dir remains until the next sandbox creation, whose init-time sweep
 * (RFC 0005, G2/G3) kills the orphaned workload process group and removes the
 * dir.
 *
 * Expected: after SIGKILL the workload is still alive and the dir still
 * exists; after the next Sandbox.create() both are gone. Exit 0.
 * Violated: the workload survives reaping, or the stale dir is never removed.
 * Exit 1.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sandbox } = require('../../sdk/typescript/dist/index.js');

const fixture = path.join(__dirname, 'fixtures', 'host-fixture.js');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function waitUntil(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met within timeout');
}

async function main() {
  const stateFile = path.join(os.tmpdir(), `crash-hard-${process.pid}-${Date.now()}.json`);
  const host = spawn(process.execPath, [fixture, stateFile, 'workload'], { stdio: 'ignore' });
  try {
    let state;
    await waitUntil(() => {
      try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        return true;
      } catch {
        return false;
      }
    });
    fs.unlinkSync(stateFile);

    if (!pidAlive(state.workloadPid)) {
      throw new Error('workload not running before crash');
    }
    host.kill('SIGKILL');
    await new Promise((resolve) => host.once('exit', resolve));

    // After a hard crash nothing has cleaned up yet.
    if (!fs.existsSync(state.dir)) {
      throw new Error('sandbox dir disappeared before reaping');
    }
    if (!pidAlive(state.workloadPid)) {
      throw new Error('workload died before reaping (unexpected)');
    }

    // The next sandbox creation triggers the stale-sandbox sweep.
    const fresh = await Sandbox.create({ backend: 'native', timeout: 5000 });
    await fresh.destroy();

    if (fs.existsSync(state.dir)) {
      throw new Error('crashed sandbox dir was not reaped on next create');
    }
    if (pidAlive(state.workloadPid)) {
      throw new Error('orphaned workload survived reaping');
    }

    console.log('PASS: hard-crash sandbox reaped on next create; workload terminated');
    process.exit(0);
  } finally {
    try {
      host.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

main().catch((e) => {
  console.error('VIOLATED:', e.message ?? e);
  process.exit(1);
});
