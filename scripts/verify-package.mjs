#!/usr/bin/env node
/**
 * scripts/verify-package.mjs
 *
 * Package verification against `npm pack --dry-run --json`, mirroring the
 * release.yml tarball-content gate plus packaging invariants:
 *
 *   1. required files present: package.json, dist/index.js, dist/index.d.ts,
 *      README.md, LICENSE,
 *   2. forbidden content absent: dist/test/, typedoc output,
 *   3. the `files` allowlist ships only dist/, LICENSE, and README.md,
 *   4. zero runtime dependencies (the published package is self-contained),
 *   5. engines declares the supported Node.js LTS floor (>=20).
 */
import * as fss from 'fs';
import * as path from 'path';
import { SDK_DIR, run, Reporter } from './lib/preflight-lib.mjs';

const report = new Reporter();

function main() {
  const pack = run('npm', ['pack', '--dry-run', '--json'], { cwd: SDK_DIR, timeoutMs: 120000 });
  if (!pack.ok) {
    report.check('npm pack --dry-run', false, pack.stderr.trim());
    process.exit(report.finish());
  }

  let manifest;
  try {
    manifest = JSON.parse(pack.stdout.trim());
  } catch {
    report.check('npm pack --dry-run parses', false, 'non-JSON output from npm pack');
    process.exit(report.finish());
  }

  // npm pack --dry-run --json emits an array on older npm and an object
  // keyed by package name on newer npm; accept either shape.
  const entry = Array.isArray(manifest) ? manifest[0] : manifest[Object.keys(manifest)[0]];
  if (!entry || !Array.isArray(entry.files)) {
    report.check('npm pack --dry-run entry', false, 'no package entry with files in npm pack output');
    process.exit(report.finish());
  }
  const paths = entry.files.map((f) => f.path);

  const required = ['package.json', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE'];
  const missing = required.filter((r) => !paths.includes(r));
  report.check(
    'required files present',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${entry.entryCount} files, ${entry.size} bytes`
  );

  const forbidden = [/^dist\/test\//, /typedoc/, /\.tgz$/];
  const unexpected = paths.filter((p) => forbidden.some((re) => re.test(p)));
  report.check(
    'forbidden content absent',
    unexpected.length === 0,
    unexpected.length ? `unexpected: ${unexpected.join(', ')}` : ''
  );

  const pkgPath = path.join(SDK_DIR, 'package.json');
  const pkg = JSON.parse(fss.readFileSync(pkgPath, 'utf-8'));

  const allowlist = Array.isArray(pkg.files) ? pkg.files : [];
  const allowed = new Set(['dist/', 'LICENSE', 'README.md']);
  const allowlistOk =
    allowlist.length > 0 &&
    allowlist.every((f) => f.startsWith('!') || allowed.has(f)) &&
    allowlist.some((f) => f === 'dist/');
  report.check('files allowlist', allowlistOk, allowlistOk ? allowlist.join(', ') : JSON.stringify(allowlist));

  const deps = Object.keys(pkg.dependencies ?? {});
  report.check('zero runtime dependencies', deps.length === 0, deps.length ? deps.join(', ') : 'none');

  const engines = pkg.engines?.node ?? '';
  const enginesOk = typeof engines === 'string' && /^>=\s*20/.test(engines);
  report.check('engines.node >= 20', enginesOk, String(engines));

  process.exit(report.finish());
}

main();
