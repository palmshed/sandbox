import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '../../sdk/typescript/dist/index.js';

/**
 * Issue #13: the reference SDK always emits truncated deterministically
 * (schema-level omission coverage lives in scripts/verify-schemas.mjs,
 * which owns the ajv dependency; compliance jobs do not install root
 * devDependencies, so this file asserts runtime behavior only).
 */
test('Compliance: SDK always emits truncated (issue #13)', async (t) => {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 15000 });
  try {
    const small = await sandbox.exec('echo hi');
    await small.wait();
    assert.equal(small.status(), 'completed');
    assert.equal(small.result().truncated, false);
    assert.equal(small.metadata().truncated, false);
    assert.equal(typeof small.truncated, 'boolean');
  } finally {
    await sandbox.destroy();
  }
});
