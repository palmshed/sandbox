#!/usr/bin/env node
/**
 * scripts/gen-osfs-source.mjs
 *
 * Regenerates sdk/typescript/src/osfs/landlockRunnerSource.ts from the
 * canonical scripts/probes/landlock-run.c source of truth (RFC 0006).
 *
 * The SDK package only ships `dist/`, so the C trampoline must be embedded as
 * a TS string constant to be available at runtime for compilation. This
 * generator keeps the embedded copy byte-identical to the probe source; the
 * drift-guard test (sdk/typescript/src/test/osfilesystem.test.ts) re-checks
 * equality when running inside the repo, and preflight CI runs this generator
 * in verify mode (--check) so a probe change cannot silently diverge.
 *
 * Git's core.autocrlf converts LF to CRLF on Windows checkouts, so line
 * endings are normalized to LF before embedding and before comparison: the
 * embedded string is deterministic on all three OSes.
 *
 * Usage:
 *   node scripts/gen-osfs-source.mjs            # regenerate the TS module
 *   node scripts/gen-osfs-source.mjs --check    # exit 1 if the module is stale
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probeSource = path.join(here, 'probes', 'landlock-run.c');
const outModule = path.join(here, '..', 'sdk', 'typescript', 'src', 'osfs', 'landlockRunnerSource.ts');
const check = process.argv.includes('--check');

const normalizeLf = (s) => s.replace(/\r\n/g, '\n');

const c = normalizeLf(fs.readFileSync(probeSource, 'utf-8'));
const generated = `/**
 * Generated from scripts/probes/landlock-run.c (RFC 0006). Do not edit by hand;
 * regenerate with: node scripts/gen-osfs-source.mjs
 */
export const LANDLOCK_RUN_C: string = ${JSON.stringify(c)};
`;

if (check) {
  const current = fs.existsSync(outModule) ? normalizeLf(fs.readFileSync(outModule, 'utf-8')) : '';
  if (current !== generated) {
    console.error('osfs runner source is stale vs scripts/probes/landlock-run.c; run node scripts/gen-osfs-source.mjs');
    process.exit(1);
  }
  console.log('  PASS  osfs runner source in sync  (probes/landlock-run.c ↔ osfs/landlockRunnerSource.ts)');
  process.exit(0);
}

fs.mkdirSync(path.dirname(outModule), { recursive: true });
fs.writeFileSync(outModule, generated);
console.log(`generated ${path.relative(here, outModule)} (${Buffer.byteLength(c)} bytes)`);