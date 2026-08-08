import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../sdk/typescript/dist/backends/native.js';
import { SandboxError } from '../../sdk/typescript/dist/index.js';

/**
 * Spec-Version: 1.0.0
 */
test('TCK: Filesystem Module [Spec-Version: 1.0.0]', async (t) => {
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

  await t.test('Path traversal is rejected with FS_ERROR [v0.1.2]', async () => {
    await assert.rejects(
      () => engine.readFile('../../../../etc/hosts'),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
    await assert.rejects(
      () => engine.writeFile('../../../etc/evil.txt', 'x'),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
  });

  await t.test('Absolute host paths are rejected with FS_ERROR [v0.1.2]', async () => {
    await assert.rejects(
      () => engine.readFile('/etc/hosts'),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
  });

  await t.test('Symlink escapes are rejected with FS_ERROR [v0.1.2]', async (t) => {
    if (process.platform === 'win32') return t.skip('symlink escape assertions are POSIX-only');
    await engine.exec('ln -s /etc/hosts link.txt');
    await assert.rejects(
      () => engine.readFile('link.txt'),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
    await engine.exec('ln -s /etc dirlink');
    await assert.rejects(
      () => engine.writeFile('dirlink/hostname', 'x'),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
  });

  await t.test('exec workDir is contained to the workspace root [v0.1.2]', async () => {
    await assert.rejects(
      () => engine.exec('pwd', { workDir: '/etc' }),
      (err) => err instanceof SandboxError && err.code === 'FS_ERROR'
    );
    const res = await engine.exec('pwd', { workDir: 'sub/nested' });
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.trim().endsWith('sub/nested'));
  });
});
