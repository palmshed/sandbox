import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';
import { SandboxError } from '../../sdk/typescript/dist/index.js';

/**
 * Spec-Version: 1.0.0
 */
test('Compliance Suite: Backend Engine Contract (NativeBackend) [Spec-Version: 1.0.0]', async (t) => {
  const engine = new NativeBackend();

  t.after(async () => {
    await engine.destroy();
  });

  await t.test('Backend exposes valid capability negotiation flags', async () => {
    assert.equal(typeof engine.capabilities.filesystem, 'boolean');
    assert.equal(typeof engine.capabilities.streaming, 'boolean');
    assert.equal(typeof engine.capabilities.remoteExecution, 'boolean');
  });

  await t.test('Backend lifecycle init and execution contract', async () => {
    await engine.init({ timeout: 5000 });
    const res = await engine.exec('echo "Backend Conformance"');
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /Backend Conformance/);
  });

  await t.test('VFS isolation boundary: traversal, absolute paths, and symlink escapes are rejected [v0.1.2]', async (t) => {
    await assert.rejects(
      () => engine.readFile('../../../../etc/hosts'),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
    await assert.rejects(
      () => engine.writeFile('/etc/evil.txt', 'x'),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
    if (process.platform === 'win32') return t.skip('symlink escape assertion is POSIX-only');
    await engine.exec('ln -s /etc/hosts link.txt');
    await assert.rejects(
      () => engine.readFile('link.txt'),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
  });

  await t.test('Environment contract: host variables are not inherited wholesale [v0.1.2]', async () => {
    process.env.HOST_LEAK_VAR = 'should-not-leak';
    const res = await engine.exec(
      'node -e "console.log(process.env.HOST_LEAK_VAR||\'absent\', process.env.PATH?\'path\':\'nopath\')"'
    );
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /absent path/);
    delete process.env.HOST_LEAK_VAR;
  });
});
