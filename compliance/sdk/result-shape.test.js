import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Sandbox } from '../../sdk/typescript/dist/index.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../spec/exec.schema.json'), 'utf8'));

/**
 * Issue #13: truncated is optional in the schema so third-party producers
 * stay compatible (absent means unknown, never false), while the reference
 * SDK always emits it deterministically. The runtime guarantee is not
 * weakened to match the schema; the optionality is producer-side only.
 */
test('Compliance: ExecResult truncated optionality (issue #13)', async (t) => {
  const ajv = new Ajv({ strict: false });
  // Compile through wrapper schemas so the internal $ref to
  // ExecutionMetadata resolves against the same document.
  const validateResult = ajv.compile({ definitions: schema.definitions, $ref: '#/definitions/ExecResult' });
  const validateMetadata = ajv.compile({ definitions: schema.definitions, $ref: '#/definitions/ExecutionMetadata' });

  const metadata = {
    id: 'exec_test',
    backend: 'native',
    specVersion: '1.2.0',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
  };
  const base = {
    id: 'exec_test',
    exitCode: 0,
    stdout: 'hi',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    metadata: { ...metadata },
  };

  await t.test('a producer omitting truncated still validates (absent means unknown)', async () => {
    assert.equal(validateResult({ ...base }), true);
    assert.equal(validateMetadata({ ...metadata }), true);
  });

  await t.test('explicit truncated true/false validates on both surfaces', async () => {
    assert.equal(validateResult({ ...base, truncated: true }), true);
    assert.equal(validateResult({ ...base, truncated: false, metadata: { ...metadata, truncated: false } }), true);
  });

  await t.test('the reference SDK always emits truncated deterministically', async () => {
    const sandbox = await Sandbox.create({ backend: 'native', timeout: 15000 });
    try {
      const small = await sandbox.exec('echo hi');
      await small.wait();
      assert.equal(small.result().truncated, false);
      assert.equal(small.metadata().truncated, false);
      assert.equal(typeof small.truncated, 'boolean');
    } finally {
      await sandbox.destroy();
    }
  });
});
