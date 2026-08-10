/**
 * Host-process fixture for crash-recovery tests (RFC 0005).
 *
 * Runs as a standalone Node process that behaves like an application host
 * (AI agent runner, CI runner) embedding the SDK: it creates a sandbox,
 * starts a long-running workload, records its own PID, the sandbox temp dir,
 * and the workload PIDs to a state file, then stays alive until the test
 * terminates it (SIGTERM for the graceful path, SIGKILL for the hard-crash
 * path).
 *
 * Usage: node host-crash-fixture.js <stateFile> <mode>
 *   mode 'workload':  foreground long-running workload (sh -> node, idle)
 *   mode 'nohup':     backgrounded workload trying to outlive its host
 *
 * The long-running workload is node (not sleep/nohup): the RFC 0006 runtime
 * allowlist only grants the SDK runtime binaries (node, sh, unshare) plus the
 * workspace, so coreutils exec is correctly denied under confinement. An idle
 * node process is the allowlisted long-running workload the reaper targets.
 */
import { Sandbox } from '../../index.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const [stateFile, mode] = process.argv.slice(2);

function findOwnSandboxDir(): string {
  const candidates: string[] = [];
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('palmshed-sandbox-')) continue;
    const dir = path.join(os.tmpdir(), name);
    if (fs.existsSync(path.join(dir, 'marker.txt'))) candidates.push(dir);
  }
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? '';
}

async function readSandboxFileUntilReady(
  sandbox: import('../../index.js').Sandbox,
  name: string
): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const content = await sandbox.readFile(name);
      return content.toString().trim();
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`workload pid file ${name} never appeared`);
}

async function main(): Promise<void> {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 600000 });
  await sandbox.writeFile('marker.txt', 'x');

  let command: string;
  let pidFile: string;
  if (mode === 'nohup') {
    // Background a node workload that outlives its host. node writes its own
    // pid; the outer background keeps the sandbox exec alive until the host
    // is terminated, after which the reaper must still find and kill the
    // orphaned node by the recorded process group.
    command =
      "sh -c 'node -e \"require(\\\"fs\\\").writeFileSync(\\\"workload.pid\\\", String(process.pid)); setInterval(()=>{},1000)\" & wait' & echo $! > shell.pid; wait";
    pidFile = 'workload.pid';
  } else if (process.platform === 'win32') {
    command = 'node -e "setInterval(()=>{},1000)"';
    pidFile = '';
  } else {
    command =
      "sh -c 'node -e \"require(\\\"fs\\\").writeFileSync(\\\"workload.pid\\\", String(process.pid)); setInterval(()=>{},1000)\" & wait'";
    pidFile = 'workload.pid';
  }

  await sandbox.exec(command, { timeout: 0 });

  const workloadPid = pidFile ? Number(await readSandboxFileUntilReady(sandbox, pidFile)) : 0;
  const state = {
    pid: process.pid,
    dir: findOwnSandboxDir(),
    workloadPid,
    mode,
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));

  if (mode === 'exit') {
    // Graceful terminal event that is cross-platform: process.exit() runs the
    // 'exit' hook, which must clean up every live sandbox. (On Windows,
    // SIGTERM cannot be caught by JS handlers, so the suite uses this path.)
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // Keep the event loop alive so the workload keeps running until the test
  // terminates this host process.
  setInterval(() => {}, 1000);
}

main().catch((err) => {
  process.stderr.write(`fixture error: ${err.stack ?? err}\n`);
  process.exit(1);
});
