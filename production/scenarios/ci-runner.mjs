/**
 * production/scenarios/ci-runner.mjs
 *
 * CI runner workflow against the Native backend:
 *
 *   checkout project → install → build → test (green) → capture logs
 *   → introduce a regression → test fails intentionally → capture logs
 *   → artifact from the earlier build must still be present and readable
 *   → cleanup → assert no residue
 *
 * The assertions are about correct state transitions: a failing build must be
 * reported as failed with its logs captured, the sandbox must remain usable,
 * and artifacts produced before a failure must not be lost.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BUDGET_MS = 120000;

function buildRepo(dir, broken) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'ci-fixture',
      version: '1.0.0',
      type: 'module',
      scripts: {
        build: 'node src/build.mjs',
        test: 'node --test',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'build.mjs'),
    `import fs from 'node:fs';\nfs.mkdirSync('dist', { recursive: true });\nfs.writeFileSync('dist/report.json', JSON.stringify({ artifact: 'build-output', sha: 'abc123' }));\nconsole.log('build complete: build-output');\n`
  );
  fs.writeFileSync(
    path.join(dir, 'test', 'ci.test.mjs'),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/lib.mjs';\ntest('answer', () => assert.equal(answer(), ${broken ? 0 : 42}));\n`
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'lib.mjs'),
    `export function answer() { return 42; }\n`
  );
}

export default {
  id: 'ci-runner',
  title: 'CI runner: build, test, intentional failure, artifact preservation',
  timeoutMs: BUDGET_MS,
  run: async (ctx) => {
    const baseline = ctx.scanResidue();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-ci-repo-'));
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-ci-logs-'));
    buildRepo(repoDir, false);

    let sandbox;
    try {
      sandbox = await ctx.sandbox({ network: 'disabled', timeout: 30000 });

      // Phase 1: checkout (upload the project tree).
      let st = ctx.step('checkout');
      for (const rel of ['package.json', 'src/build.mjs', 'src/lib.mjs', 'test/ci.test.mjs']) {
        await sandbox.uploadFile(path.join(repoDir, rel), rel);
      }
      st.end();

      // Phase 2: build + test, capturing logs.
      st = ctx.step('green-pipeline');
      const buildLogs = [];
      const build = await sandbox.exec('npm run build', { timeout: 30000 });
      build.on('stdout', (chunk) => buildLogs.push(chunk));
      await build.wait();
      ctx.assert.equal(build.exitCode, 0, 'build must succeed');
      ctx.assert.ok(buildLogs.join('').includes('build complete'), 'build logs must be captured');

      const test = await sandbox.exec('npm test', { timeout: 30000 });
      await test.wait();
      ctx.assert.equal(test.exitCode, 0, 'tests must pass on the green tree');
      ctx.assert.match(test.stdout(), /answer/, 'test logs must be captured');
      st.end();

      // Phase 3: verify the artifact, then preserve a copy.
      st = ctx.step('artifact');
      const artifact = await sandbox.readFile('dist/report.json');
      ctx.assert.ok(artifact.toString('utf-8').includes('abc123'), 'artifact must be written by build');
      const preserved = path.join(logsDir, 'report.json');
      await sandbox.downloadFile('dist/report.json', preserved);
      st.end();

      // Phase 4: introduce a regression and run the pipeline again.
      st = ctx.step('regression');
      await sandbox.writeFile(
        'test/ci.test.mjs',
        `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/lib.mjs';\ntest('answer', () => assert.equal(answer(), 0));\n`
      );
      const failLogs = [];
      const failing = await sandbox.exec('npm test', { timeout: 30000 });
      failing.on('stdout', (chunk) => failLogs.push(chunk));
      failing.on('stderr', (chunk) => failLogs.push(chunk));
      await failing.wait();
      st.end();
      ctx.assert.equal(failing.status(), 'failed', 'regressed test must be reported failed');
      ctx.assert.notEqual(failing.exitCode, 0, 'regressed test must exit non-zero');
      ctx.assert.ok(failLogs.join('').length > 0, 'failure logs must be captured');

      // Phase 5: the artifact produced before the failure must still exist.
      st = ctx.step('artifact-preserved');
      const afterFailure = await sandbox.readFile('dist/report.json');
      ctx.assert.equal(
        afterFailure.toString('utf-8'),
        artifact.toString('utf-8'),
        'artifact from the green build must survive the failing run'
      );
      const preservedBytes = fs.readFileSync(preserved);
      ctx.assert.ok(
        preservedBytes.equals(artifact),
        'preserved artifact copy must byte-match the sandbox artifact'
      );
      st.end();

      // Phase 6: cleanup and residue verification.
      await sandbox.destroy();
      ctx.untrack(sandbox);
      sandbox = null;
      ctx.assertNoResidue(baseline, 'ci-runner');
      ctx.log('PASS: CI workflow complete, artifact preserved, sandbox cleaned up');
    } finally {
      if (sandbox) await sandbox.destroy();
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  },
};
