/**
 * examples/ci-runner.mjs
 *
 * Simulates a CI build/test environment against the Native backend:
 * a repository is uploaded into the sandbox filesystem, a build/test command
 * runs inside the sandbox, and logs + artifacts are collected.
 *
 * Validates (matching the Native capability matrix only):
 *   - Workspace mounting (uploadFile of a project tree) + writeFile VFS
 *   - Build + test execution inside the sandbox
 *   - stdout/stderr streaming with live output
 *   - Success, failure (non-zero exit), and timeout handling
 *   - Sandbox reuse after a failed and after a timed-out workload
 *   - Artifact extraction (readFile / downloadFile)
 *   - Sandbox cleanup
 *
 * The fixture projects are dependency-free so the sandbox can stay
 * `network: 'disabled'` (the only network policy the Native backend verifies).
 * A real CI pipeline that installs dependencies would enable network access
 * or seed a pre-warmed dependency cache (out of scope for this example).
 *
 * Usage: node examples/ci-runner.mjs
 */
import { Sandbox } from '../sdk/typescript/dist/index.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const summary = [];

function log(...args) {
  const line = args.map(String).join(' ');
  summary.push(line);
  console.log(line);
}

/**
 * Build a tiny "green" project whose test passes and writes an artifact.
 * Mirrors a CI pipeline: checkout -> install (none needed) -> build -> test.
 */
async function buildFixture(dir) {
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'test'), { recursive: true });
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
  await fs.writeFile(
    path.join(dir, 'test/run.test.mjs'),
    `import test from 'node:test';
import assert from 'node:assert/strict';
test('fixture sanity', () => { assert.equal(1 + 1, 2); });
`
  );
}

/** Stream a running execution live and wait for it to settle. */
async function stream(label, execution) {
  execution.on('stdout', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  execution.on('stderr', (chunk) => process.stderr.write(`[${label}:stderr] ${chunk}`));
  await execution.wait();
  return execution;
}

/** Prove the sandbox is still healthy and executable after a workload. */
async function assertReusable(sandbox, afterWhat) {
  const probe = await sandbox.exec(`node -e "console.log('reuse-ok-${afterWhat}')"`, {
    timeout: 5000,
  });
  await probe.wait();
  if (probe.exitCode !== 0 || !probe.stdout().includes(`reuse-ok-${afterWhat}`)) {
    throw new Error(`sandbox NOT reusable after ${afterWhat} (exit ${probe.exitCode})`);
  }
  log(`  reuse check: sandbox healthy after ${afterWhat}`);
}

/**
 * Scenario 1: Green pipeline: build + test + collect artifacts.
 * Uses uploadFile (host -> sandbox VFS) like a CI checkout.
 */
async function scenarioGreenPipeline(sandbox, fixtureDir) {
  log('--- Scenario 1: green build/test pipeline ---');
  await sandbox.uploadFile(path.join(fixtureDir, 'package.json'), 'package.json');
  await sandbox.uploadFile(path.join(fixtureDir, 'src/build.mjs'), 'src/build.mjs');
  await sandbox.uploadFile(path.join(fixtureDir, 'test/run.test.mjs'), 'test/run.test.mjs');

  const build = await stream('build', await sandbox.exec('npm run build', { timeout: 15000 }));
  log(`  build: status=${build.status()} exit=${build.exitCode} duration=${build.durationMs}ms`);

  const test = await stream('test', await sandbox.exec('npm test', { timeout: 15000 }));
  log(`  test:  status=${test.status()} exit=${test.exitCode} duration=${test.durationMs}ms`);

  if (build.exitCode !== 0 || test.exitCode !== 0) {
    throw new Error('green pipeline unexpectedly failed');
  }

  const artifact = await sandbox.readFile('dist/report.json');
  if (!artifact.toString('utf-8').includes('abc123')) {
    throw new Error('artifact contents mismatch');
  }

  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-artifacts-'));
  await sandbox.downloadFile('dist/report.json', path.join(artifactDir, 'report.json'));
  const downloaded = await fs.readFile(path.join(artifactDir, 'report.json'), 'utf-8');
  if (!downloaded.includes('abc123')) {
    throw new Error('downloaded artifact mismatch');
  }
  await fs.rm(artifactDir, { recursive: true, force: true });
  log(`  artifact: dist/report.json read + downloaded (${downloaded.trim()})`);

  await assertReusable(sandbox, 'green-pipeline');
  log('  PASS: green build/test/artifact pipeline');
}

/**
 * Scenario 2: Failing workload: a project whose test exits non-zero.
 * Uses writeFile (VFS) to stage the project under a workDir, like an
 * agent-generated patch. The sandbox must report the failure and stay usable.
 */
async function scenarioFailingBuild(sandbox) {
  log('--- Scenario 2: failing test workload ---');
  await sandbox.writeFile(
    'project-b/package.json',
    JSON.stringify({ name: 'broken-project', version: '1.0.0', scripts: { test: 'node test/fail.mjs' } })
  );
  await sandbox.writeFile(
    'project-b/test/fail.mjs',
    `console.error('expected failure: assertion failed');\nprocess.exit(3);\n`
  );

  const test = await stream('fail', await sandbox.exec('npm test', { workDir: 'project-b', timeout: 15000 }));
  log(`  test:  status=${test.status()} exit=${test.exitCode} duration=${test.durationMs}ms`);
  log(`  stderr: ${test.stderr().trim()}`);

  if (test.status() !== 'failed' || test.exitCode === 0) {
    throw new Error('failing workload was not reported as failed');
  }
  if (!test.stderr().includes('expected failure')) {
    throw new Error('failure diagnostics were not captured');
  }

  await assertReusable(sandbox, 'failed-workload');
  log('  PASS: failing workload reported + sandbox reusable');
}

/**
 * Scenario 3: Timed-out workload: an execution that exceeds its timeout.
 * The sandbox must surface `timedout` and remain usable.
 */
async function scenarioTimeout(sandbox) {
  log('--- Scenario 3: timed-out workload ---');
  const execution = await stream('timeout', await sandbox.exec('node -e "setInterval(() => {}, 50)"', { timeout: 400 }));
  log(`  status=${execution.status()} timedOut=${execution.timedOut} exit=${execution.exitCode}`);

  if (execution.status() !== 'timedout' || !execution.timedOut) {
    throw new Error('timed-out workload was not reported as timedout');
  }

  await assertReusable(sandbox, 'timed-out-workload');
  log('  PASS: timed-out workload reported + sandbox reusable');
}

async function main() {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-fixture-'));
  await buildFixture(fixtureDir);

  log('=== CI Runner: fixture project created ===');

  const sandbox = await Sandbox.create({
    backend: 'native',
    timeout: 30000,
    // Keep the sandbox isolated (the fixture is dependency-free). See header.
    network: 'disabled',
  });

  try {
    log(`backend=${sandbox.backendName} networkIsolation=${sandbox.capabilities.networkIsolation}`);
    log('');

    await scenarioGreenPipeline(sandbox, fixtureDir);
    log('');
    await scenarioFailingBuild(sandbox);
    log('');
    await scenarioTimeout(sandbox);

    log('');
    log('=== CI Runner complete: all scenarios passed ===');
    await fs.rm(fixtureDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('CI Runner failed:', err);
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  } finally {
    await sandbox.destroy();
  }
}

main();
