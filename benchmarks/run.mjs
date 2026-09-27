/**
 * Benchmark harness: reproducible evidence generation, not promises.
 *
 * Measures four metrics with fixed definitions (see benchmarks/README.md):
 * cold-start create latency, execution overhead vs a semantically equivalent
 * baseline, parallel capacity with saturation guardrails, and per-sandbox
 * host overhead. Native first; Docker measured separately, never mixed.
 *
 * Usage:
 *   node benchmarks/run.mjs [--backend native|docker] [--image <img>]
 *     [--only cold|overhead|parallel|host] [--sandboxes <maxN>]
 *     [--samples <n>] [--out <file>] [--verbose] [--list]
 *
 * Results print as a human summary plus a JSON evidence document (to --out
 * or stdout with --out -). Numbers carry a runner fingerprint and must
 * never be copied into README/ROADMAP/gist as targets without an explicit
 * promotion decision. Exit code is 0 on completion, even when saturation
 * stops the parallel ramp early (recorded as invalid, not failure).
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const entry = require.resolve('@palmshed/sandbox');
const pkg = require('@palmshed/sandbox/package.json');
const { Sandbox } = require('@palmshed/sandbox');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : (args[i + 1] ?? def);
};
const flag = (name) => args.includes(`--${name}`);
const BACKEND = opt('backend', 'native');
const IMAGE = opt('image', 'ubuntu:24.04');
const ONLY = opt('only', null);
const MAX_N = parseInt(opt('sandboxes', '100'), 10);
const SAMPLES = parseInt(opt('samples', '15'), 10);
const OUT = opt('out', null);
const VERBOSE = flag('verbose');

const ALL = ['cold', 'overhead', 'parallel', 'host'];
if (flag('list')) {
  console.log(ALL.join('\n'));
  process.exit(0);
}
const SELECTED = ONLY ? [ONLY] : ALL;
for (const m of SELECTED) {
  if (!ALL.includes(m)) {
    console.error(`unknown metric: ${m} (use --list)`);
    process.exit(2);
  }
}

function fingerprint() {
  const cpus = os.cpus();
  const fp = {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus.length ? cpus[0].model : 'unknown',
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    node: process.version,
    package: `@palmshed/sandbox@${pkg.version}`,
    packageEntry: entry,
    backend: BACKEND,
    timestamp: new Date().toISOString(),
    memGuardFloorBytes: 1024 * 1024 * 1024,
    memGuardAvailableDef: os.platform() === 'darwin' ? 'vm_stat free+inactive+purgeable+speculative' : 'os.freemem',
  };
  if (BACKEND === 'docker') {
    fp.docker = dockerInfo();
  }
  return fp;
}

function dockerInfo() {
  const info = { image: IMAGE, imagePresent: false, serverVersion: null };
  try {
    const v = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15000 });
    if (v.status === 0) info.serverVersion = v.stdout.trim();
    const q = spawnSync('docker', ['images', '-q', IMAGE], { encoding: 'utf8', timeout: 15000 });
    info.imagePresent = q.status === 0 && q.stdout.trim().length > 0;
  } catch {
    // record absence, never fail the harness on probe errors
  }
  return info;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { n: sorted.length, median, p95, max: sorted[sorted.length - 1], min: sorted[0] };
}

function log(...a) {
  if (VERBOSE) console.error('[bench]', ...a);
}

/**
 * Saturation guardrail: a host that is itself out of CPU/RAM produces an
 * invalid run, not a capacity number. Returns null when healthy, else the
 * reason string.
 */
/**
 * Host-available memory in bytes. On macOS, freemem excludes reclaimable
 * file-cache/inactive memory the kernel hands out freely, so available is
 * derived from vm_stat (free + inactive + purgeable + speculative); a parse
 * failure falls back to freemem. Elsewhere freemem is the signal.
 */
function availableMemBytes() {
  if (os.platform() === 'darwin') {
    try {
      const out = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 10000 }).stdout ?? '';
      const page = /page size of (\d+) bytes/.exec(out);
      const num = (name) => {
        const m = new RegExp(`${name}:\\s*([\\d.]+)\\.?`).exec(out);
        return m ? parseFloat(m[1].replace(/\./g, '')) : 0;
      };
      if (page) {
        const size = parseInt(page[1], 10);
        const pages = num('Pages free') + num('Pages inactive') + num('Pages purgeable') + num('Pages speculative');
        if (pages > 0) return pages * size;
      }
    } catch {
      // fall through to freemem
    }
  }
  return os.freemem();
}

function saturationReason() {
  // One floor everywhere (1 GiB available); only the definition of
  // available is platform-adjusted. The floor is recorded in the
  // fingerprint with every evidence document.
  const floor = 1024 * 1024 * 1024;
  const free = availableMemBytes();
  if (free < floor) return `host available memory low (${Math.round(free / 1048576)} MiB < ${floor / 1048576} MiB floor)`;
  if (typeof os.loadavg === 'function' && os.platform() !== 'win32') {
    const [one] = os.loadavg();
    if (one > os.cpus().length * 2) return `host load average high (${one.toFixed(1)})`;
  }
  return null;
}

async function createSandbox(extra = {}) {
  const options = { backend: BACKEND, timeout: 60000, ...extra };
  if (BACKEND === 'docker') options.image = IMAGE;
  return Sandbox.create(options);
}

// Fixed deterministic workload for the overhead metric.
const HELLO = `node -e "console.log('benchmark')"`;
async function sandboxWorkload(sandbox) {
  const t0 = Date.now();
  await sandbox.writeFile('bench.txt', 'x'.repeat(1024));
  const ex = await sandbox.exec(HELLO);
  await ex.wait();
  if (ex.status() !== 'completed') throw new Error(`workload failed: ${ex.status()}`);
  await sandbox.readFile('bench.txt');
  return Date.now() - t0;
}

async function baselineWorkload(dir) {
  const t0 = Date.now();
  fs.writeFileSync(`${dir}/bench.txt`, 'x'.repeat(1024));
  await new Promise((resolve, reject) => {
    const child = spawn(BACKEND === 'win32' ? 'cmd.exe' : '/bin/sh', BACKEND === 'win32' ? ['/s', '/c', HELLO] : ['-c', HELLO]);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`baseline exit ${code}`))));
  });
  fs.readFileSync(`${dir}/bench.txt`);
  return Date.now() - t0;
}

async function metricCold() {
  const walls = [];
  const sandboxes = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = Date.now();
    sandboxes.push(await createSandbox());
    walls.push(Date.now() - t0);
  }
  for (const s of sandboxes) await s.destroy();
  // Sample 0 pays one-time process/backend initialization (capability
  // probes, reaper sweep). Samples 1..4 are create-after-init
  // (cold-create); samples 5..14 are creates 6-15 (warm-host).
  // coldInitMs isolates the one-time cost as walls[0] minus cold-create.
  const coldCreate = stats(walls.slice(1, 5));
  const warm = walls.slice(5);
  return {
    coldInitMs: Math.max(0, walls[0] - coldCreate.median),
    coldCreateMs: walls[0],
    coldCreate,
    warmHost: stats(warm),
    unit: 'ms',
    note: 'create latency only; Docker image pull excluded, image state in fingerprint',
  };
}

async function metricOverhead() {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/bench-base-`);
  try {
    const sandbox = await createSandbox();
    try {
      const sbWalls = [];
      for (let i = 0; i < 5; i++) await sandboxWorkload(sandbox); // warmups discarded
      for (let i = 0; i < SAMPLES; i++) sbWalls.push(await sandboxWorkload(sandbox));
      const baseWalls = [];
      for (let i = 0; i < 5; i++) await baselineWorkload(dir);
      for (let i = 0; i < SAMPLES; i++) baseWalls.push(await baselineWorkload(dir));
      const sb = stats(sbWalls);
      const base = stats(baseWalls);
      return {
        sandboxWallMs: sb,
        baselineWallMs: base,
        overheadRatioMedian: sb.median / base.median,
        unit: 'ms and ratio',
        note: 'semantically equivalent baseline: direct fs ops plus bare child spawn of the same command',
      };
    } finally {
      await sandbox.destroy();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function metricParallel() {
  const steps = [10, 25, 50, 100, 150, 200].filter((n) => n <= MAX_N);
  const results = [];
  let highestSuccessfulN = 0;
  const invalid = [];
  for (const n of steps) {
    const blocked = saturationReason();
    if (blocked) {
      invalid.push({ n, reason: `saturation guard before step: ${blocked}` });
      break;
    }
    const sandboxes = [];
    try {
      const t0 = Date.now();
      for (let i = 0; i < n; i++) sandboxes.push(await createSandbox());
      const createMs = Date.now() - t0;
      const t1 = Date.now();
      await Promise.all(
        sandboxes.map(async (s) => {
          const ex = await s.exec('echo ok');
          await ex.wait();
          if (ex.status() !== 'completed') throw new Error(`parallel exec ${ex.status()}`);
          await s.writeFile('p.txt', 'ok');
        })
      );
      const workMs = Date.now() - t1;
      for (const s of sandboxes) await s.destroy();
      sandboxes.length = 0;
      highestSuccessfulN = n;
      results.push({ n, createMsTotal: createMs, workMsTotal: workMs, completed: true });
    } catch (err) {
      invalid.push({ n, reason: `step failed, not saturation evidence: ${err.message}` });
      for (const s of sandboxes) {
        try {
          await s.destroy();
        } catch {
          // best effort cleanup after a failed step
        }
      }
      break;
    }
  }
  return { steps: results, highestSuccessfulN, invalid, unit: 'ms and count' };
}

function fdCount() {
  try {
    if (os.platform() === 'linux') return fs.readdirSync('/proc/self/fd').length;
  } catch {
    // unavailable: fall through to null
  }
  return null;
}

async function metricHost() {
  const N = 25;
  await new Promise((r) => setTimeout(r, 500));
  const rssBefore = process.memoryUsage().rss;
  const fdBefore = fdCount();
  const sandboxes = [];
  for (let i = 0; i < N; i++) sandboxes.push(await createSandbox());
  await new Promise((r) => setTimeout(r, 2000)); // settle
  const rssAfter = process.memoryUsage().rss;
  const fdAfter = fdCount();
  for (const s of sandboxes) await s.destroy();
  return {
    n: N,
    rssDeltaBytesPerSandbox: Math.max(0, Math.round((rssAfter - rssBefore) / N)),
    fdDeltaPerSandbox: fdBefore === null || fdAfter === null ? null : (fdAfter - fdBefore) / N,
    unit: 'bytes and fds',
    note: 'idle sandboxes; workload memory excluded by construction',
  };
}

async function main() {
  const evidence = { fingerprint: fingerprint(), metrics: {}, invalid: [] };
  if (SELECTED.includes('cold')) {
    log('cold...');
    evidence.metrics.cold = await metricCold();
  }
  if (SELECTED.includes('overhead')) {
    log('overhead...');
    evidence.metrics.overhead = await metricOverhead();
  }
  if (SELECTED.includes('parallel')) {
    log('parallel...');
    const p = await metricParallel();
    evidence.metrics.parallel = p;
    evidence.invalid.push(...p.invalid);
  }
  if (SELECTED.includes('host')) {
    log('host...');
    evidence.metrics.host = await metricHost();
  }

  const json = JSON.stringify(evidence, null, 2);
  if (OUT && OUT !== '-') fs.writeFileSync(OUT, json + '\n');

  // Human summary (rendered from the evidence, never hand-written).
  const lines = [`backend=${BACKEND} package=${pkg.version} node=${process.version} ${os.platform()}-${os.arch()} cpus=${os.cpus().length}`];
  if (evidence.metrics.cold) {
    const c = evidence.metrics.cold;
    lines.push(`cold: init=${c.coldInitMs}ms create=${c.coldCreateMs}ms warmMedian=${c.warmHost.median}ms warmP95=${c.warmHost.p95}ms (n=${c.warmHost.n})`);
  }
  if (evidence.metrics.overhead) {
    const o = evidence.metrics.overhead;
    lines.push(`overhead: sandboxMedian=${o.sandboxWallMs.median}ms baselineMedian=${o.baselineWallMs.median}ms ratio=${o.overheadRatioMedian.toFixed(3)}`);
  }
  if (evidence.metrics.parallel) {
    const p = evidence.metrics.parallel;
    lines.push(`parallel: highestSuccessfulN=${p.highestSuccessfulN} steps=${p.steps.map((s) => s.n).join(',') || 'none'}`);
  }
  if (evidence.metrics.host) {
    const h = evidence.metrics.host;
    lines.push(`host: rssDeltaPerSandbox=${h.rssDeltaBytesPerSandbox}B fdDeltaPerSandbox=${h.fdDeltaPerSandbox}`);
  }
  for (const inv of evidence.invalid) lines.push(`invalid: n=${inv.n} reason=${inv.reason}`);
  console.log(lines.join('\n'));
  if (!OUT || OUT === '-') console.log(json);
}

main().catch((err) => {
  console.error(`benchmark harness error: ${err.message}`);
  process.exit(1);
});
