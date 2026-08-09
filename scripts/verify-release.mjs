#!/usr/bin/env node
/**
 * scripts/verify-release.mjs
 *
 * Release-readiness checks, mirroring the release.yml version gate plus the
 * governance promises a release must satisfy:
 *
 *   1. SDK package version == runtime spec version (exact), and major.minor
 *      aligned (the spec-compatibility rule),
 *   2. a git tag must exist for the version: either a tag at HEAD, a
 *      --tag/PREFLIGHT_TAG argument (CI release pipeline), or --check-tag-exists
 *      (nightly gate: any v<version> tag must exist in the repo),
 *   3. spec/CHANGELOG.md contains a [<version>] entry,
 *   4. docs/release-readiness.md exists (the freeze plan is maintained).
 */
import * as fss from 'fs';
import * as path from 'path';
import {
  REPO_ROOT,
  SPEC_DIR,
  sdkVersion,
  specVersion,
  gitTagAtHead,
  run,
  Reporter,
} from './lib/preflight-lib.mjs';

const report = new Reporter();
const args = new Set(process.argv.slice(2));
const explicitTag = process.env.PREFLIGHT_TAG?.replace(/^v/, '') || null;
const checkTagExists = args.has('--check-tag-exists');

function main() {
  const pkgVer = sdkVersion();
  const specVer = specVersion();

  report.check(
    'SDK version == spec version',
    pkgVer === specVer,
    `sdk ${pkgVer} vs spec ${specVer ?? 'unreadable'}`
  );

  const sdkMM = pkgVer.split('.')[0] + '.' + pkgVer.split('.')[1];
  const specMM = specVer ? specVer.split('.')[0] + '.' + specVer.split('.')[1] : null;
  report.check('SDK major.minor <= spec major.minor', specMM !== null && sdkMM === specMM, `${sdkMM} vs ${specMM}`);

  let tagOk = false;
  let tagDetail = '';
  if (explicitTag) {
    tagOk = explicitTag === pkgVer;
    tagDetail = `tag ${explicitTag} vs sdk ${pkgVer}`;
  } else if (checkTagExists) {
    const res = run('git', ['tag', '--list', `v${pkgVer}`], { cwd: REPO_ROOT });
    tagOk = res.ok && res.stdout.trim().length > 0;
    tagDetail = tagOk ? `v${pkgVer} tag exists` : `no v${pkgVer} tag found`;
  } else {
    const atHead = gitTagAtHead();
    tagOk = atHead !== null && atHead.replace(/^v/, '') === pkgVer;
    tagDetail = atHead ? `tag ${atHead} vs sdk ${pkgVer}` : 'HEAD is not tagged';
  }
  report.check('git tag matches version', tagOk, tagDetail);

  const changelog = fss.readFileSync(path.join(SPEC_DIR, 'CHANGELOG.md'), 'utf-8');
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryPresent = new RegExp(`\\[${escapeRegex(pkgVer)}\\]`).test(changelog);
  report.check('CHANGELOG entry for version', entryPresent, entryPresent ? `[${pkgVer}]` : `no [${pkgVer}] entry`);

  const rrPath = path.join(REPO_ROOT, 'docs', 'release-readiness.md');
  report.check(
    'release-readiness doc present',
    fss.existsSync(rrPath),
    fss.existsSync(rrPath) ? 'docs/release-readiness.md' : 'missing'
  );

  process.exit(report.finish());
}

main();
