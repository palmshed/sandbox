/**
 * Host-process fixture for crash-recovery repros (RFC 0005). Behaves like an
 * embedding application host: creates a sandbox, starts a long-running
 * workload, records host PID, sandbox temp dir, and workload PID to a state
 * file, then stays alive until terminated by the repro.
 *
 * Usage: node host-fixture.js <stateFile> <mode>
 *   mode 'workload': foreground long-running workload (sh -> sleep 600)
 *   mode 'nohup':    nohup-backgrounded workload trying to outlive its host
 */
'use strict';

const { Sandbox } = require('../../../sdk/typescript/dist/index.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [stateFile, mode] = process.argv.slice(2);

function findOwnSandboxDir() {
  let newest = '';
  let newestMtime = 0;
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('palmshed-sandbox-')) continue;
    const dir = path.join(os.tmpdir(), name);
    if (!fs.existsSync(path.join(dir, 'marker.txt'))) continue;
    const mtime = fs.statSync(dir).mtimeMs;
    if (mtime > newestMtime) {
      newest = dir;
      newestMtime = mtime;
    }
  }
  return newest;
}

function readUntilReady(sandbox, name) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const poll = () => {
      sandbox
        .readFile(name)
        .then((buf) => resolve(buf.toString().trim()))
        .catch((e) => {
          if (++tries > 100) reject(e);
          else setTimeout(poll, 50);
        });
    };
    poll();
  });
}

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 600000 });
  await sandbox.writeFile('marker.txt', 'x');

  let command;
  let pidFile;
  if (mode === 'nohup') {
    command = "nohup sh -c 'sleep 600 & echo $! > sleep.pid; wait' >/dev/null 2>&1 & echo $! > shell.pid; wait";
    pidFile = 'sleep.pid';
  } else if (process.platform === 'win32') {
    command = 'node -e "setInterval(()=>{},1000)"';
    pidFile = '';
  } else {
    command = "sh -c 'sleep 600 & echo $! > sleep.pid; wait'";
    pidFile = 'sleep.pid';
  }

  await sandbox.exec(command, { timeout: 0 });

  const workloadPid = pidFile ? Number(await readUntilReady(sandbox, pidFile)) : 0;
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ pid: process.pid, dir: findOwnSandboxDir(), workloadPid, mode })
  );
  setInterval(() => {}, 1000);
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e));
  process.exit(1);
});
