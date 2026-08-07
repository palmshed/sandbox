import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';

/**
 * Spec-Version: 0.1.0
 */
test('TCK: Filesystem Module [Spec-Version: 0.1.0]', async (t) => {
  const engine = new NativeBackend();
  await engine.init({});

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Virtual FS Write and Read', async () => {
    await engine.writeFile('tck.txt', 'TCK Filesystem Test');
    const content = await engine.readFile('tck.txt');
    assert.equal(content.toString(), 'TCK Filesystem Test');
  });
});
