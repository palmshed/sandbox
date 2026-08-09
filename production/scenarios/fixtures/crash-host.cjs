/**
 * production/scenarios/fixtures/crash-host.cjs
 *
 * Behaving like an embedding application host for the crash-recovery
 * production scenario. Resolves the installed @palmshed/sandbox package (the
 * same packed artifact the suite validates), creates a sandbox, writes a
 * marker file, starts a long-running workload that records its own pid, then
 * writes host state to a state file and stays alive until it is hard-killed.
 *
 * Usage: node crash-host.cjs <stateFile>
 *   stateFile: path where { pid, dir, workloadPid } is written once ready.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sandbox } = require('@palmshed/sandbox');

const [stateFile] = process.argv.slice(2);

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
          if (++tries > 200) reject(e);
          else setTimeout(poll, 50);
        });
    };
    poll();
  });
}

async function main() {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 600000 });
  await sandbox.writeFile('marker.txt', 'x');

  // Long-running workload that writes its own pid into the sandbox, then
  // stays alive until the reaper kills it.
  await sandbox.writeFile(
    'wl.js',
    "require('fs').writeFileSync('wl.pid', String(process.pid)); setInterval(() => {}, 1000);\n"
  );
  await sandbox.exec('node wl.js', { timeout: 0 });

  const workloadPid = Number(await readUntilReady(sandbox, 'wl.pid'));
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ pid: process.pid, dir: findOwnSandboxDir(), workloadPid })
  );
  setInterval(() => {}, 1000); // stay alive until the scenario hard-kills this host
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e));
  process.exit(1);
});