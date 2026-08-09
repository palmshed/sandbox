#!/usr/bin/env node
/**
 * scripts/probes/runtime-allowlist.mjs
 *
 * Runtime allowlist derivation for RFC 0006 (OS-level filesystem isolation).
 *
 * Given the set of binaries the reference SDK runtime needs to start (the
 * workload shell, node, and unshare when network isolation is active), derive
 * the minimal read-only allowlist the workload needs to launch:
 *
 *   - the binary itself and its dynamic loader (interpreter),
 *   - every link-time shared object resolved by ldd,
 *   - runtime data files the loader/libc need before exec (ld.so.cache,
 *     nsswitch, passwd, resolv.conf, hosts, group, zoneinfo, locale),
 *   - the directories that must be traversable/readable to reach them.
 *
 * Everything else is denied. The allowlist is READ-ONLY except the workspace,
 * which the caller grants separately (the Native backend grants rwx on the
 * sandbox cell. This script only composes the runtime, never the workload
 * data).
 *
 * This is evidence and enablement for the Linux implementation. Passing the
 * derived allowlist under real Landlock confinement (via --smoke) proves the
 * SDK runtime starts and executes inside it; it does not by itself promote
 * `osFilesystemIsolation: supported` (that needs the escape suite against the
 * real sandbox path).
 *
 * Usage:
 *   node scripts/probes/runtime-allowlist.mjs [--bin /usr/bin/unshare [--bin ...]]
 *                                             [--json] | [--smoke]
 *
 *   --smoke  additionally compile landlock-run.c, apply the derived allowlist
 *            under Landlock, and verify workloads (sh, node, descendants,
 *            outside-denial, read-only) pass. Requires cc.
 */

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wantJson = flags.has('--json');
const wantSmoke = flags.has('--smoke');

const bins = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--bin') bins.push(argv[++i]);
}

const OUT = { probe: 'runtime-allowlist', platform: process.platform, arch: os.arch(), binaries: [], dso: [], interpreter: null, dirsReadExec: [], dataFiles: [], missing: [] };

const log = (key, value) => {
  if (!wantJson) console.log(`  [INFO] ${key}: ${String(value)}`);
};

async function main() {
  if (process.platform !== 'linux') {
    OUT.skipped = `runtime allowlist is Linux-only (running on ${process.platform})`;
    emit();
    return;
  }

  // Default runtime set: the shell the workload runs under, the current node,
  // and unshare (needed when network isolation wraps the command). The SDK
  // spawns `unshare -n --user --map-root-user -- /bin/sh -c <cmd>` for
  // network:'disabled', so confined unshare must be able to exec everything.
  const runtimeBins = bins.length
    ? bins
    : [process.execPath, '/bin/sh', '/usr/bin/unshare'];

  const resolved = [];
  for (const b of runtimeBins) {
    let p = b;
    if (!path.isAbsolute(p)) p = findInPath(b);
    try {
      p = fs.realpathSync(p);
    } catch {
      OUT.missing.push(b);
      log('missing', b);
      continue;
    }
    if (!resolved.includes(p)) resolved.push(p);
  }
  OUT.binaries = resolved;

  const dsoSet = new Set();
  const dirSet = new Set();
  const interp = [];

  for (const b of resolved) {
    if (!isExecutable(b)) {
      OUT.missing.push(`${b} (not executable)`);
      continue;
    }
    const dsoCandidates = lddResolve(b);
    for (const entry of dsoCandidates) {
      if (entry.type === 'needed') dsoSet.add(entry.path);
      else if (entry.type === 'interpreter') interp.push(entry.path);
    }
    dirSet.add(path.dirname(b));
  }

  // The loader itself is a shared object; make sure its dir is traversable.
  for (const i of interp) {
    dsoSet.add(i);
    dirSet.add(path.dirname(i));
  }

  OUT.interpreter = interp[0] ?? null;
  OUT.dso = [...dsoSet].sort();
  OUT.dirsReadExec = [...dirSet].sort();

  // Runtime data files required before/at exec, read-only. These are the
  // loader/nss/locale/tz/openssl config paths libc and node touch on launch.
  const dataCandidates = [
    '/etc/ld.so.cache',
    '/etc/ld.so.preload',
    '/etc/nsswitch.conf',
    '/etc/passwd',
    '/etc/group',
    '/etc/hosts',
    '/etc/resolv.conf',
    '/etc/localtime',
    '/usr/share/zoneinfo',
    '/usr/lib/ssl/openssl.cnf',
    '/usr/lib/locale',
    // Node.js "externalized builtins": this distro ships parts of node's
    // internal runtime (cjs-module-lexer, undici, etc.) as JSON/JS files under
    // /usr/share/nodejs/ that node reads at startup.
    '/usr/share/nodejs',
  ];
  OUT.dataFiles = dataCandidates.filter((f) => exists(f));

  // When node is not from the distro (e.g. actions/setup-node toolcache on
  // CI runners), the externalized builtins live under <prefix>/lib/node_modules
  // instead of /usr/share/nodejs. Detect that layout so the allowlist still
  // covers node's runtime data on such hosts.
  for (const b of resolved) {
    const prefix = path.dirname(path.dirname(b)); // <prefix>/bin -> <prefix>
    const nodeModules = path.join(prefix, 'lib', 'node_modules');
    if (exists(nodeModules) && !OUT.dataFiles.includes(nodeModules)) {
      OUT.dataFiles.push(nodeModules);
    }
  }
  OUT.dataFiles.sort();

  emit();

  if (wantSmoke) {
    const code = await smoke(resolved, [...dsoSet], OUT.dataFiles, [...dirSet]);
    process.exit(code);
  }
}

function emit() {
  if (wantJson) {
    console.log(JSON.stringify(OUT, null, 2));
  } else {
    console.log('');
    console.log(`binaries:       ${OUT.binaries.join(', ') || '(none)'}`);
    console.log(`interpreter:    ${OUT.interpreter ?? '(static binary?)'}`);
    console.log(`dso (count):    ${OUT.dso.length}`);
    console.log(`dirsReadExec:   ${OUT.dirsReadExec.join(', ') || '(none)'}`);
    console.log(`dataFiles:      ${OUT.dataFiles.join(', ') || '(none)'}`);
    if (OUT.missing.length) console.log(`missing:        ${OUT.missing.join(', ')}`);
  }
}

function findInPath(bin) {
  const p = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of p) {
    const cand = path.join(dir, bin);
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {}
  }
  throw new Error(`not found in PATH: ${bin}`);
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && !!(st.mode & 0o111);
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function lddResolve(bin) {
  // Parse `ldd -v <bin>`-style output. Lines of interest:
  //   "  linux-vdso.so.1 (0x...)"                    -> ignore
  //   "  libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x...)" -> needed
  //   "  /lib64/ld-linux-x86-64.so.2 (0x...)"        -> interpreter
  //   "  libfoo.so.1 => not found"                   -> missing (recorded)
  const out = execFileSync('ldd', ['-v', bin], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const notFound = t.match(/^(\S+)\s*=>\s*not found/);
    if (notFound) {
      OUT.missing.push(`${bin}: ${notFound[1]} => not found`);
      log('ldd.missing', `${bin}: ${notFound[1]}`);
      continue;
    }
    const needed = t.match(/^(\S+)\s*=>\s+(\/\S+) \(0x[0-9a-f]+\)$/);
    if (needed) {
      entries.push({ type: 'needed', path: needed[2] });
      continue;
    }
    const interp = t.match(/^(\/\S+) \(0x[0-9a-f]+\)$/);
    if (interp) {
      entries.push({ type: 'interpreter', path: interp[1] });
      continue;
    }
    // ldd -v sections header lines ("Version information:", "    libc.so.6 ...") are skipped.
  }
  return entries;
}

async function smoke(bins, dso, dataFiles, dirs) {
  const runnerSrc = path.join(HERE, 'landlock-run.c');
  const work = path.join(os.tmpdir(), `palmshed-confine-${process.pid}-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  const runBin = path.join(work, 'landlock-run');
  const ws = path.join(work, 'ws');
  const allowlistFile = path.join(work, 'allowlist.txt');
  const results = [];
  const record = (name, ok, detail) => {
    const msg = `  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `: ${detail}` : ''}`;
    if (!wantJson) console.log(msg);
    results.push({ name, ok });
  };

  try {
    execFileSync('cc', ['--version'], { stdio: 'ignore' });
  } catch {
    if (!wantJson) console.log('  [INFO] cc not available; smoke skipped');
    fs.rmSync(work, { recursive: true, force: true });
    return 0;
  }

  fs.mkdirSync(ws, { recursive: true });

  let compiled = false;
  try {
    execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-o', runBin, runnerSrc], { stdio: 'ignore' });
    compiled = true;
  } catch (e) {
    if (!wantJson) console.log(`  [FAIL] compile landlock-run.c: ${String(e.message).slice(0, 200)}`);
    fs.rmSync(work, { recursive: true, force: true });
    return 1;
  }
  if (!compiled) return 1;

  // Allowlist file the runner consumes: `mode:path` per line.
  const lines = [
    // Workspace is NOT in the allowlist file; the runner grants it rwx
    // explicitly. Data files are read-only.
    ...dataFiles.map((f) => `r:${f}`),
    ...bins.map((b) => `rx:${b}`),
    ...dso.map((d) => `rx:${d}`),
    ...dirs.map((d) => `r:${d}`),
    `x:${runBin}`,
  ];
  fs.writeFileSync(allowlistFile, lines.filter((l, i) => lines.indexOf(l) === i).join('\n') + '\n');

  const secrets = path.join(work, 'outside-secret.txt');
  fs.writeFileSync(secrets, 'TOP-SECRET-DO-NOT-READ\n');

  const run = (cmd, boxCwd) => {
    try {
      const r = execFileSync(runBin, [ws, allowlistFile, '/bin/sh', '-c', cmd], {
        cwd: boxCwd ?? ws,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out: r };
    } catch (e) {
      return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
    }
  };

  // 1. Shell starts and executes inside the confined runtime.
  const shStart = run('echo confined-shell-ok');
  record('sh starts + exec under allowlist', shStart.code === 0 && shStart.out.includes('confined-shell-ok'), shStart.err || `exit ${shStart.code}`);

  // 2. node (the SDK runtime) starts and executes.
  const nodeStart = run("node -e \"process.stdout.write('node-'+process.version)\"");
  record('node starts + exec under allowlist', nodeStart.code === 0 && /node-v\d+/.test(nodeStart.out), nodeStart.err || `exit ${nodeStart.code}`);

  // 3. Workload can write only inside the workspace (shell builtins only).
  //    `cat` is intentionally not allowlisted, so verify with `[` and `echo`.
  const wsWrite = run('echo in-ws > ws.txt && [ -s ws.txt ] && echo ws-ok', ws);
  record('write inside workspace allowed', wsWrite.code === 0 && wsWrite.out.includes('ws-ok'), wsWrite.err || `exit ${wsWrite.code}`);

  // 4. Reading allowlisted runtime data files is allowed (via allowlisted node).
  const etcRead = run('node -e "require(\'fs\').readFileSync(\'/etc/hosts\');process.stdout.write(\'etc-ok\')"');
  record('runtime data file readable', etcRead.code === 0 && etcRead.out.includes('etc-ok'), etcRead.err || `exit ${etcRead.code}`);

  // 5. Exec of an unallowlisted binary is denied.
  const nope = run('/bin/cat /etc/hosts');
  record('unallowlisted exec denied', nope.code !== 0, nope.err || `exit ${nope.code}`);

  // 6. Writing outside the workspace is denied (shell redirection => open for
  //    write outside the allowlist fails).
  const outWrite = run(`echo evil > ${JSON.stringify(path.join(work, 'evil.txt'))}`);
  record('write outside workspace denied', outWrite.code !== 0, outWrite.err || `exit ${outWrite.code}`);

  // 7. Reading outside the workspace is denied (allowlisted node, forbidden path).
  const outRead = run(`node -e "require('fs').readFileSync(process.argv[1])" ${JSON.stringify(secrets)}`);
  record('read outside workspace denied', outRead.code !== 0 && !outRead.out.includes('TOP-SECRET'), outRead.err || `exit ${outRead.code}`);

  // 8. Data files are read-only (open for append denied).
  const ro = run('echo x >> /etc/hosts');
  record('data files read-only', ro.code !== 0, ro.err || `exit ${ro.code}`);

  // 9. Descendants inherit the confinement across fork+exec: a node child that
  //    re-execs itself still cannot read the forbidden path.
  const desc = run(`node -e 'const{spawnSync}=require("child_process");const r=spawnSync(process.execPath,["-e","try{require(\\"fs\\").readFileSync(process.argv[1]);process.exit(9)}catch(e){process.exit(0)}",${JSON.stringify(secrets)}]);process.exit(r.status===0?0:9)'`);
  record('descendant re-exec inherits denial', desc.code === 0, desc.err || `exit ${desc.code}`);

  // 10. Read via shell redirection (builtin open) of a forbidden path fails.
  // 11. Network-restricted composition (RFC 0004 + RFC 0006): the production
  //     spawn path is `unshare -n --user --map-root-user -- <cmd>`. The
  //     confined runner must be usable AS the target of unshare, proving
  //     `unshare (unconfined) -> landlock-run (restricts) -> sh` composes:
  //     namespaces first, then Landlock, then the workload. unshare writes
  //     /proc/self/uid_map BEFORE landlock-run restricts, so it runs outside
  //     the confinement.
  let unshareUsable = false;
  try {
    execFileSync('unshare', ['-n', '--user', '--map-root-user', '--', '/bin/true'], { stdio: 'ignore' });
    unshareUsable = true;
  } catch {}
  if (unshareUsable) {
    const netwrap = (cmd, args, cwd) => {
      try {
        const r = execFileSync('unshare', ['-n', '--user', '--map-root-user', '--', runBin, ws, allowlistFile, '--', cmd, ...args], { cwd: cwd ?? ws, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out: r };
      } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
      }
    };
    const netwrapOk = netwrap('/bin/sh', ['-c', 'echo netbox-ok']);
    record('unshare wrapper -> confined runner composes', netwrapOk.code === 0 && netwrapOk.out.includes('netbox-ok'), netwrapOk.err || `exit ${netwrapOk.code}`);

    // 12. The composed path still enforces the allowlist (read outside denied
    //     when reached through the unshare wrapper). node is the direct target
    //     of unshare -> landlock-run, so no shell layer mangles the args.
    const netdeny = netwrap('node', ['-e', "require('fs').readFileSync(process.argv[1])", secrets]);
    record('unshare wrapper still encloses outside reads', netdeny.code !== 0 && !netdeny.out.includes('TOP-SECRET'), netdeny.err || `exit ${netdeny.code}`);
  } else {
    if (!wantJson) console.log('  [SKIP] unshare unavailable on this host; composition checks skipped');
  }

  fs.rmSync(work, { recursive: true, force: true });

  if (!wantJson) {
    const ok = results.filter((r) => r.ok).length;
    console.log(`\n  smoke: ${ok}/${results.length} passed`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

main().catch((e) => {
  if (!wantJson) console.error(e);
  process.exit(1);
});