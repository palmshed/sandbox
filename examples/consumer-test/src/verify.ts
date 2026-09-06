import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Sandbox } from '@palmshed/sandbox';

// Shared consumer suite. It runs against the installed @palmshed/sandbox
// package in two provenances: the packed workspace tarball (run.sh) and the
// published npm artifact (run-published.sh). The suite must therefore compile
// against both the current workspace types and older published types, so
// capability introspection beyond the stable core surface is reflective
// (Record casts) rather than statically typed. When CONSUMER_EVIDENCE names
// a path, a machine-readable evidence JSON is written there on completion
// (and on failure, with the error attached).

interface CheckRecord {
  name: string;
  pass: boolean;
}

interface ConsumerEvidence {
  suite: string;
  provenance: string;
  packageSpec: string;
  installedVersion: string;
  node: string;
  platform: string;
  capabilities: Record<string, unknown>;
  osfs: { advertised: boolean; value?: unknown; note?: string };
  checks: CheckRecord[];
  ok: boolean;
  error?: string;
}

const requirePkg = createRequire(import.meta.url);
const installedVersion: string = (requirePkg('@palmshed/sandbox/package.json') as { version: string }).version;

const evidence: ConsumerEvidence = {
  suite: 'consumer-test verify.ts',
  provenance: process.env['CONSUMER_PROVENANCE'] ?? 'packed',
  packageSpec: process.env['CONSUMER_PACKAGE_SPEC'] ?? 'workspace tarball',
  installedVersion,
  node: process.version,
  platform: process.platform,
  capabilities: {},
  osfs: { advertised: false },
  checks: [],
  ok: false,
};

function passed(name: string): void {
  evidence.checks.push({ name, pass: true });
  console.log(`  [ok] ${name}`);
}

function writeEvidence(): void {
  const path = process.env['CONSUMER_EVIDENCE'];
  if (path) {
    writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`consumer evidence: ${path}`);
  }
}

async function main() {
  console.log('Testing consumer import and execution against packed @palmshed/sandbox artifact...');

  // 1. Creation & backend verification
  const sandbox = await Sandbox.create({
    backend: 'native',
    timeout: 5000,
  });

  assert.ok(sandbox, 'Sandbox instance created');
  assert.equal(sandbox.backendName, 'native');
  passed('creation and backend');

  // 2. Capabilities negotiation check
  assert.equal(typeof sandbox.capabilities.filesystem, 'boolean');
  assert.equal(typeof sandbox.capabilities.streaming, 'boolean');
  assert.equal(typeof sandbox.capabilities.networkIsolation, 'boolean');
  assert.equal(typeof sandbox.capabilities.cpuLimits, 'boolean');
  assert.equal(typeof sandbox.capabilities.memoryLimits, 'boolean');
  assert.equal(typeof sandbox.capabilities.remoteExecution, 'boolean');
  // Snapshot the full capability object (reflective: older published types
  // may not declare newer keys, and JSON keeps only plain values).
  evidence.capabilities = JSON.parse(JSON.stringify(sandbox.capabilities)) as Record<string, unknown>;
  passed('capabilities shape');

  // 3. Execution & exit code
  const execution = await sandbox.exec('node -e "console.log(\'sandbox ok\')"');
  assert.equal(execution.status(), 'running');
  assert.match(execution.id, /^exec_/);
  assert.match(execution.uri, /^sandbox:\/\/execution\/exec_/);

  // Stream chunk assertion
  let streamCaptured = false;
  execution.on('stdout', (chunk) => {
    if (chunk.includes('sandbox ok')) {
      streamCaptured = true;
    }
  });

  await execution.wait();

  assert.equal(execution.status(), 'completed');
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.stdout().trim(), 'sandbox ok');
  assert.ok(streamCaptured, 'stdout stream chunk was captured via event listener');
  passed('execution and exit code');

  // 4. Stream handle verification (Readable stream from accumulated stdout)
  const stream = execution.stdoutStream();
  let streamBuf = '';
  for await (const chunk of stream) {
    streamBuf += chunk;
  }
  assert.equal(streamBuf.trim(), 'sandbox ok');
  passed('stdout stream handle');

  // 5. Exit event with code
  const exitExec = await sandbox.exec('node -e "process.exit(42)"');
  let capturedExitCode: number | null = null;
  exitExec.on('exit', (code) => { capturedExitCode = code; });
  await exitExec.wait();
  assert.equal(exitExec.exitCode, 42);
  assert.equal(exitExec.status(), 'failed');
  assert.equal(capturedExitCode, 42);
  passed('exit event');

  // 6. stderr capture
  const stderrExec = await sandbox.exec('node -e "process.stderr.write(\'err channel\')"');
  await stderrExec.wait();
  assert.equal(stderrExec.status(), 'completed');
  assert.equal(stderrExec.stderr().trim(), 'err channel');
  passed('stderr capture');

  // 7. Metadata & result inspection
  const metaExec = await sandbox.exec('echo "metadata test"');
  await metaExec.wait();
  const meta = metaExec.metadata();
  assert.ok(meta, 'metadata object available after wait()');
  assert.equal(meta!.backend, 'native');
  // Version-robust: the suite runs against published releases as well as
  // the packed workspace build, so only the semver shape is asserted.
  assert.match(meta!.specVersion, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  assert.equal(typeof meta!.startedAt, 'string');
  assert.equal(typeof meta!.finishedAt, 'string');
  assert.ok(meta!.durationMs >= 0);
  assert.equal(meta!.timedOut, false);
  assert.equal(meta!.exitCode, 0);
  assert.equal(typeof meta!.id, 'string');

  const result = metaExec.result();
  assert.ok(result, 'result object available after wait()');
  assert.equal(typeof result!.stdout, 'string');
  assert.equal(typeof result!.stderr, 'string');
  assert.equal(typeof result!.durationMs, 'number');
  assert.equal(result!.timedOut, false);
  assert.equal(result!.exitCode, 0);
  passed('metadata and result');

  // 8. logs() returns stdout + stderr combined
  const logsExec = await sandbox.exec('node -e "console.log(\'out line\'); process.stderr.write(\'err line\')"');
  await logsExec.wait();
  assert.ok(logsExec.logs().includes('out line'));
  assert.ok(logsExec.logs().includes('err line'));
  passed('logs()');

  // 9. cancel() transitions status to cancelled
  const cancelExec = await sandbox.exec('node -e "setInterval(() => {}, 10000)"', {
    timeout: 5000,
  });
  assert.equal(cancelExec.status(), 'running');
  await cancelExec.cancel();
  assert.equal(cancelExec.status(), 'cancelled');
  passed('cancel()');

  // 11. OS filesystem isolation capability (RFC 0006). Reflective on purpose:
  // published packages predate the capability and their types do not declare
  // it. Absence is recorded as evidence, never a failure.
  const capsView = sandbox.capabilities as unknown as Record<string, unknown>;
  const osfsValue = capsView['osFilesystemIsolation'];
  if (typeof osfsValue === 'string' && (osfsValue === 'supported' || osfsValue === 'unsupported' || osfsValue === 'unknown')) {
    evidence.osfs = { advertised: true, value: osfsValue };
    if (osfsValue === 'supported' && process.platform !== 'win32') {
      const denyExec = await sandbox.exec('node -e "require(\'fs\').readFileSync(\'/etc/passwd\')"');
      await denyExec.wait();
      assert.notEqual(denyExec.exitCode, 0, 'confined read of /etc/passwd is denied');
      passed('osfs confinement escape denied');
    } else {
      passed('osfs advertised tri-state recorded');
    }
  } else {
    evidence.osfs = { advertised: false, note: 'capability not advertised by this package version' };
    passed('osfs capability absent recorded');
  }

  // 10. destroy() cleans up and prevents further execution
  await sandbox.destroy();
  await assert.rejects(
    async () => sandbox.exec('echo "should fail"'),
    /already been destroyed/,
    'exec() after destroy() rejects',
  );
  passed('destroy()');

  evidence.ok = true;
  writeEvidence();
  console.log('Consumer verification passed cleanly!');
}

main().catch((err) => {
  console.error('Consumer verification failed:', err);
  evidence.ok = false;
  evidence.error = err instanceof Error ? err.message : String(err);
  try {
    writeEvidence();
  } catch {
    // Evidence is best effort on the failure path.
  }
  process.exit(1);
});
