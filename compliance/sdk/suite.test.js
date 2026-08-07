import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from '../../sdk/typescript/dist/index.js';

const specVersion = fs
  .readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../spec/version.md'), 'utf-8')
  .match(/\*\*0\.1\.\d\*\*/)?.[0]
  .replace(/\*/g, '');

/**
 * Spec-Version: ${specVersion}
 */
test(`Conformance Suite: Core Spec Verification (TypeScript SDK) [Spec-Version: ${specVersion}]`, async (t) => {
  const sandbox = await Sandbox.create({
    backend: 'native',
    timeout: 3000,
    network: 'disabled',
  });

  t.after(async () => {
    await sandbox.destroy();
  });

  await t.test(`Spec: Execution handle URI and initial status [Spec-Version: ${specVersion}]`, async () => {
    const execution = await sandbox.exec('echo "Compliance"');
    assert.match(execution.id, /^exec_/);
    assert.match(execution.uri, /^sandbox:\/\/execution\/exec_/);
    await execution.wait();
    assert.equal(execution.status(), 'completed');
  });

  await t.test(`Spec: Command Execution & Exit Code [Spec-Version: ${specVersion}]`, async () => {
    const execution = await sandbox.exec('echo "Compliance Test"');
    await execution.wait();
    assert.equal(execution.exitCode, 0);
    assert.equal(typeof execution.stdout(), 'string');
    assert.equal(execution.timedOut, false);
  });

  await t.test(`Spec: Execution Metadata [Spec-Version: ${specVersion}]`, async () => {
    const execution = await sandbox.exec('echo "Metadata"');
    await execution.wait();
    const meta = execution.metadata();
    assert.ok(meta);
    assert.equal(meta.backend, 'native');
    assert.equal(meta.specVersion, specVersion);
    assert.equal(typeof meta.startedAt, 'string');
    assert.equal(typeof meta.finishedAt, 'string');
  });

  await t.test(`Spec: Real-time stdout streaming via events [Spec-Version: ${specVersion}]`, async () => {
    let captured = '';
    const execution = await sandbox.exec('echo "Stream Chunk"');
    execution.on('stdout', (data) => { captured += data; });
    await execution.wait();
    assert.match(captured, /Stream Chunk/);
  });

  await t.test(`Spec: Timeout Enforcement & timedout status [Spec-Version: ${specVersion}]`, async () => {
    const execution = await sandbox.exec('node -e "setTimeout(() => {}, 5000)"', {
      timeout: 150,
    });
    await execution.wait();
    assert.equal(execution.status(), 'timedout');
    assert.equal(execution.exitCode, -1);
    const meta = execution.metadata();
    assert.ok(meta);
    assert.equal(meta.timedOut, true);
  });
});
