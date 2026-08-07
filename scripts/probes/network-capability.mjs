#!/usr/bin/env node
/**
 * Network isolation capability probe.
 *
 * Empirically verifies what an unprivileged workload can do on the current
 * platform BEFORE any isolation mechanism is chosen. The probe does not
 * attempt to bypass anything; it establishes a baseline of what the OS
 * permits from a normal user process.
 *
 * Usage: node scripts/probes/network-capability.mjs [--json]
 */

import { createConnection } from 'node:net';
import * as net from 'node:net';
import { resolve, lookup } from 'node:dns/promises';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const OUT = { platform: process.platform, arch: os.arch(), user: os.userInfo().username, euid: process.getuid?.() ?? null, results: {} };

const record = (key, value) => {
  OUT.results[key] = value;
  const pfx = value === true ? 'PASS' : value === false ? 'FAIL' : typeof value === 'string' ? 'INFO' : 'INFO';
  if (!process.argv.includes('--json')) console.log(`  [${pfx}] ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
};

const probe = async (key, fn) => {
  try {
    const r = await fn();
    record(key, r);
  } catch (err) {
    record(key, `${err.code ?? ''} ${err.message}`);
  }
};

// --- Outbound TCP ---
await probe('outbound TCP (host reachable)', async () => {
  await new Promise((res, rej) => {
    const s = createConnection({ host: '1.1.1.1', port: 80, timeout: 3000 });
    s.once('connect', () => { s.destroy(); res(); });
    s.once('error', rej);
    s.once('timeout', () => { s.destroy(); rej(new Error('connect timeout')); });
  });
  return true;
});

// --- DNS resolution ---
await probe('DNS A-record resolution', async () => {
  await resolve('example.com');
  return true;
});

// --- Localhost access ---
await probe('localhost TCP bind+connect', async () => {
  await new Promise((res, rej) => {
    const srv = net.createServer((c) => c.end());
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const c = net.createConnection({ host: '127.0.0.1', port });
      c.once('connect', () => { c.destroy(); srv.close(() => res()); });
      c.once('error', rej);
    });
  });
  return true;
});

// --- Outbound UDP ---
await probe('outbound UDP send', async () => {
  await new Promise((res, rej) => {
    const sock = dgram.createSocket('udp4');
    sock.send(Buffer.from('probe'), 53, '1.1.1.1', (err) => {
      sock.close();
      err ? rej(err) : res();
    });
  });
  return true;
});

// --- Raw sockets (packet-level) ---
await probe('raw socket creation (SOCK_RAW)', async () => {
  // Node cannot create SOCK_RAW sockets; delegate to a small C compile if cc exists.
  let ccAvailable = true;
  try { execFileSync('cc', ['--version'], { stdio: 'ignore' }); } catch { ccAvailable = false; }
  if (!ccAvailable) return 'skipped (no cc)';
  const src = '/tmp/palmshed-rawsock.c';
  const bin = '/tmp/palmshed-rawsock';
  const fs = await import('node:fs');
  fs.writeFileSync(src, `#include <sys/socket.h>\n#include <netinet/in.h>\n#include <stdio.h>\nint main(){int s=socket(AF_INET,SOCK_RAW,IPPROTO_RAW); if(s<0){perror("raw");return 1;} return 0;}\n`);
  try { execFileSync('cc', [src, '-o', bin]); } catch (e) { return `compile failed: ${e.message}`; }
  try { execFileSync(bin, { stdio: 'ignore' }); return true; }
  catch (e) { return `blocked (${e.status})`; }
});

// --- Platform-specific isolation mechanisms ---
if (process.platform === 'darwin') {
  // sandbox-exec: deprecated by Apple but the classic Seatbelt wrapper.
  // Working profile: (allow default) then (deny network*). A bare
  // (deny default)+system.sb import blocks exec/file access before the
  // workload can run, so keep the allow-first structure.
  const prof = '/tmp/palmshed-net.sb';
  const fs = await import('node:fs');
  fs.writeFileSync(prof, '(version 1)\n(allow default)\n(deny network*)\n');

  const sandboxRun = (script) => {
    try {
      const out = execFileSync('sandbox-exec', ['-f', prof, '/bin/sh', '-c', script], { stdio: 'pipe', encoding: 'utf-8' });
      return `exit 0 -> ${out.trim().slice(0, 120)}`;
    } catch (e) {
      return `blocked (${String(e.stdout ?? '').trim() || e.status})`;
    }
  };

  await probe('sandbox-exec available (deny network* profile runs)', () =>
    Promise.resolve(sandboxRun('node -e "process.exit(0)"'))
  );

  await probe('sandbox-exec (deny network*) outbound TCP', () =>
    Promise.resolve(sandboxRun('node -e "require(\'net\').createConnection({host:\'1.1.1.1\',port:80,timeout:2000}).on(\'connect\',()=>{console.log(\'CONNECTED\');process.exit(0)}).on(\'error\',e=>{console.log(\'BLOCKED\',e.code);process.exit(1)})"'))
  );

  await probe('sandbox-exec (deny network*) outbound UDP', () =>
    Promise.resolve(sandboxRun('node -e "const d=require(\'dgram\').createSocket(\'udp4\');d.send(Buffer.from(\'x\'),53,\'1.1.1.1\',e=>{console.log(e?(\'BLOCKED\'+e.code):\'SENT\');process.exit(0)})"'))
  );

  await probe('sandbox-exec (deny network*) DNS', () =>
    Promise.resolve(sandboxRun('node -e "require(\'dns\').resolve(\'example.com\',(e,a)=>{console.log(e?(\'BLOCKED\'+e.code):a);process.exit(0)})"'))
  );

  await probe('sandbox-exec (deny network*) localhost TCP', () =>
    Promise.resolve(sandboxRun('node -e "require(\'net\').createConnection({host:\'127.0.0.1\',port:80,timeout:1000}).on(\'connect\',()=>{console.log(\'CONNECTED\');process.exit(0)}).on(\'error\',e=>{console.log(\'BLOCKED\'+e.code);process.exit(1)})"'))
  );

  await probe('sandbox-exec (deny network*) child process', () =>
    Promise.resolve(sandboxRun('node -e "require(\'net\').createConnection({host:\'1.1.1.1\',port:80,timeout:2000}).on(\'connect\',()=>{console.log(\'CONNECTED\');process.exit(0)}).on(\'error\',e=>{console.log(\'BLOCKED\',e.code);process.exit(1)})" & wait $!'))
  );

  await probe('pfctl (packet filter) requires root', async () => {
    try { execFileSync('pfctl', ['-s', 'info'], { stdio: 'ignore' }); return true; }
    catch (e) { return `denied (${e.status})`; }
  });
}

if (process.platform === 'linux') {
  await probe('unshare user namespace', async () => {
    execFileSync('unshare', ['--user', '--map-root-user', 'true'], { stdio: 'ignore' });
    return true;
  }).catch(() => record('unshare user namespace', 'denied'));
  await probe('unshare network namespace', async () => {
    execFileSync('unshare', ['--net', 'true'], { stdio: 'ignore' });
    return true;
  }).catch(() => record('unshare network namespace', 'denied'));
  await probe('cgroup v2 mount', async () => {
    const fs = await import('node:fs');
    return fs.existsSync('/sys/fs/cgroup/cgroup.controllers');
  });
}

if (process.platform === 'win32') {
  await probe('netsh firewall query', async () => {
    execFileSync('netsh', ['advfirewall', 'show', 'allprofiles'], { stdio: 'ignore' });
    return true;
  }).catch(() => record('netsh firewall query', 'denied'));
  await probe('netstat socket list', async () => {
    execFileSync('netstat', ['-ano'], { stdio: 'ignore' });
    return true;
  }).catch(() => record('netstat socket list', 'denied'));
}

if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
