/**
 * examples/ci-runner.js
 *
 * Simulates a CI build/test environment: a repository is uploaded into a
 * sandbox filesystem, a build/test command runs inside the sandbox, and
 * logs + artifacts are collected.
 *
 * Validates:
 *   - Workspace mounting (uploadFile of a small project tree)
 *   - Build execution inside the sandbox
 *   - stdout/stderr streaming with live output
 *   - Exit code + timed-out enforcement
 *   - Artifact extraction (downloadFile)
 *   - Sandbox cleanup
 *
 * Usage: node examples/ci-runner.js
 *
 * The fixture project is created on the host, uploaded into the sandbox, then
 * `npm test` is run inside. This mirrors a CI pipeline: checkout -> install ->
 * test -> collect artifacts.
 */
import { Sandbox } from '../sdk/typescript/dist/index.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

async function buildFixture(dir) {
  // A tiny "project" whose test passes and writes an artifact.
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-project',
        version: '1.0.0',
        type: 'module',
        scripts: { build: 'node src/build.mjs', test: 'node --test test/run.test.mjs' },
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(dir, 'src/build.mjs'),
    `import fs from 'node:fs';
const out = { artifact: 'build-output', sha: 'abc123' };
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/report.json', JSON.stringify(out));
console.log('build complete:', JSON.stringify(out));
`
  );
  await fs.mkdir(path.join(dir, 'test'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'test/run.test.mjs'),
    `import test from 'node:test';
import assert from 'node:assert/strict';
test('fixture sanity', () => { assert.equal(1 + 1, 2); });
`
  );
}

async function main() {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-fixture-'));
  await buildFixture(fixtureDir);

  console.log('=== CI Runner: fixture project created ===');

  const sandbox = await Sandbox.create({
    backend: 'native',
    timeout: 30000,
    // Build/test environments often need network for dependency install;
    // this fixture is dependency-free so we keep the sandbox isolated.
    network: 'disabled',
  });

  try {
    console.log('=== Uploading workspace into sandbox ===');
    await sandbox.uploadFile(path.join(fixtureDir, 'package.json'), 'package.json');
    await sandbox.uploadFile(path.join(fixtureDir, 'src/build.mjs'), 'src/build.mjs');
    await sandbox.uploadFile(path.join(fixtureDir, 'test/run.test.mjs'), 'test/run.test.mjs');

    console.log('=== Step 1: build ===');
    const build = await sandbox.exec('npm run build', { timeout: 15000 });
    build.on('stdout', (chunk) => process.stdout.write(`[build] ${chunk}`));
    build.on('stderr', (chunk) => process.stderr.write(`[build:stderr] ${chunk}`));
    await build.wait();
    console.log(`build status: ${build.status()} (exit ${build.exitCode})`);

    console.log('=== Step 2: test ===');
    const test = await sandbox.exec('npm test', { timeout: 15000 });
    test.on('stdout', (chunk) => process.stdout.write(`[test] ${chunk}`));
    test.on('stderr', (chunk) => process.stderr.write(`[test:stderr] ${chunk}`));
    await test.wait();
    console.log(`test status: ${test.status()} (exit ${test.exitCode})`);

    console.log('=== Step 3: collect artifact ===');
    const artifact = await sandbox.readFile('dist/report.json');
    console.log('artifact contents:', artifact.toString('utf-8').trim());

    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-artifacts-'));
    await sandbox.downloadFile('dist/report.json', path.join(artifactDir, 'report.json'));
    const downloaded = await fs.readFile(path.join(artifactDir, 'report.json'), 'utf-8');
    console.log('downloaded artifact verified:', /abc123/.test(downloaded));

    const exitCode = build.exitCode === 0 && test.exitCode === 0 ? 0 : 1;
    console.log(`\n=== CI Runner complete (exit ${exitCode}) ===`);
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.rm(artifactDir, { recursive: true, force: true });
    process.exit(exitCode);
  } catch (err) {
    console.error('CI Runner failed:', err);
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  } finally {
    await sandbox.destroy();
  }
}

main();
