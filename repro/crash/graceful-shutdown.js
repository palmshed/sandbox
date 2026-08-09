/**
 * Demonstrates: graceful host shutdown cleans up sandboxes and workloads.
 * POSIX-only
 *
 * A host process embedding the SDK receives SIGTERM while a sandboxed
 * workload is running. The crash-recovery hooks (RFC 0005, G1) must kill the
 * workload process group and remove the sandbox temp directory before the
 * host exits.
 *
 * Expected: after SIGTERM the host exits, the workload is gone, and the
 * sandbox dir is removed. Exit 0.
 * Violated: the workload survives, the dir remains, or the host hangs. Exit 1.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  const stateFile = path.join(os.tmpdir(), `crash-graceful-${process.pid}-${Date.now()}.json`);
  const host = spawn(process.execPath, [fixture, stateFile, 'workload'], { stdio: 'ignore' });
  let state;
  try {
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
      throw new Error('workload not running before shutdown');
    }
    if (!fs.existsSync(state.dir)) {
      throw new Error('sandbox dir missing before shutdown');
    }

    host.kill('SIGTERM');
    await new Promise((resolve) => host.once('exit', resolve));

    if (fs.existsSync(state.dir)) {
      throw new Error('sandbox dir not removed on graceful shutdown');
    }
    if (pidAlive(state.workloadPid)) {
      throw new Error('workload survived graceful shutdown');
    }

    console.log('PASS: graceful SIGTERM shutdown cleaned up sandbox and workload');
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
