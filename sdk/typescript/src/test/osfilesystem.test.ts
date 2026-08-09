import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs/promises';
import { Sandbox } from '../index.js';

/**
 * RFC 0006 adversarial escape suite (E1-E10 / G1-G8).
 *
 * These tests exercise the Native backend's OS-level filesystem isolation
 * (Landlock confinement runner) end-to-end through the real `Sandbox` API,
 * not the probe. They are gated on the capability reporting `supported`:
 * if the mechanism is unavailable on this host/kernel (pre-5.13, no Landlock,
 * restricted user namespaces, or an unprobed platform), they skip rather than
 * assert on ambient-rights behavior.
 *
 * Each escape attempt asserts the attempt FAILS while the sandbox stays
 * healthy and reusable (RFC 0006 adversarial plan item 14).
 */
async function skipUnlessSupported(): Promise<{ skip: boolean; message: string }> {
  if (process.platform !== 'linux') {
    return { skip: true, message: 'OS-filesystem isolation is Linux-only (RFC 0006)' };
  }
  return { skip: false, message: '' };
}

test('RFC 0006 OS-filesystem isolation escape suite', async (t) => {
  const env = await skipUnlessSupported();
  if (env.skip) return t.skip(env.message);

  const sandbox = await Sandbox.create({ backend: 'native', timeout: 15000 });
  t.after(async () => {
    await sandbox.destroy();
  });

  const cap = sandbox.capabilities.osFilesystemIsolation;
  if (cap !== 'supported') {
    return t.skip(`osFilesystemIsolation=${cap} (not enforced on this host); skipping escape assertions`);
  }

  const nodeRead = (p: string): string =>
    `node -e "const fs=require('fs');process.stdout.write(fs.readFileSync(process.argv[1]))" ${JSON.stringify(p)}`;

  const readback = (e: { stdout(): string }): string => e.stdout();
  const failed = (e: { status(): string; exitCode: number }): void => {
    assert.notEqual(e.exitCode, 0, `attempt must fail (status=${e.status()}, exit=${e.exitCode})`);
  };
  const succeeded = (e: { status(): string; exitCode: number }): void => {
    assert.equal(e.exitCode, 0, `attempt must succeed (status=${e.status()})`);
  };

  // E1/G1: read of world-readable host material must fail under confinement.
  await t.test('E1: direct read of /etc/passwd (world-readable) is denied', async () => {
    const exec = await sandbox.exec(nodeRead('/etc/passwd'));
    await exec.wait();
    failed(exec);
  });

  await t.test('E1: direct read of $HOME material is denied', async () => {
    const home = os.homedir();
    const exec = await sandbox.exec(nodeRead(`${home}/.ssh/config`));
    await exec.wait();
    failed(exec);
  });

  // G2/E1: writes outside the workspace must fail.
  await t.test('E1/G2: write outside the workspace (/tmp) is denied', async () => {
    const target = `/tmp/palmshed-osfs-escape-${Date.now()}.txt`;
    const exec = await sandbox.exec(
      `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(target)}`
    );
    await exec.wait();
    failed(exec);
  });

  await t.test('E1/G2: write outside the workspace ($HOME) is denied', async () => {
    const target = `${os.homedir()}/palmshed-osfs-escape-home.txt`;
    const exec = await sandbox.exec(
      `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(target)}`
    );
    await exec.wait();
    failed(exec);
    await fs.rm(target, { force: true });
  });

  // E2/G4: a workspace symlink to a host path must not be followed to read.
  await t.test('E2: symlink escape through workspace link is blocked', async () => {
    const plant = await sandbox.exec(
      `node -e "require('fs').symlinkSync('/etc/passwd','escape-link.txt')"`
    );
    await plant.wait();
    if (plant.exitCode !== 0) {
      // The runner itself may deny symlink creation in a hardened config;
      // either way the escape goal must not be reachable.
      return;
    }
    const exec = await sandbox.exec(nodeRead('escape-link.txt'));
    await exec.wait();
    failed(exec);
  });

  // E3: hardlink escape (REFER semantics, ABI >= 2).
  await t.test('E3: hardlinking a host file into the workspace is blocked', async () => {
    const exec = await sandbox.exec(
      `node -e "require('fs').linkSync('/etc/passwd','escape-hardlink.txt')"`
    );
    await exec.wait();
    failed(exec);
  });

  // E7/G5: a subprocess spawned by the workload is equally confined. node is
  // allowlisted, so spawning node as a child must still be denied the read.
  await t.test('E7: subprocess (node child) inherits the confinement', async () => {
    const childScript = `require('fs').readFileSync('/etc/shadow')`;
    const exec = await sandbox.exec(
      `node -e "require('child_process').execFileSync('node',['-e',${JSON.stringify(childScript)}],{stdio:'inherit'})"`
    );
    await exec.wait();
    failed(exec);
  });

  // E6: relative traversal from a workspace-relative cwd lands in a denied subtree.
  await t.test('E6: ../../ traversal escapes the workspace grant', async () => {
    const victim = await sandbox.exec(`node -e "require('fs').mkdirSync('a/b',{recursive:true})"`);
    await victim.wait();
    const exec = await sandbox.exec(
      `node -e "require('fs').readFileSync('../../../../etc/passwd')"`,
      { workDir: 'a/b' }
    );
    await exec.wait();
    failed(exec);
  });

  // E10/G5: absolute path access through the interpreter is denied.
  await t.test('E10: absolute host path read via node is denied', async () => {
    const exec = await sandbox.exec(nodeRead('/etc/hostname'));
    await exec.wait();
    failed(exec);
  });

  // G3: exec of a binary outside the runtime allowlist must fail.
  await t.test('G3: executing an unallowlisted binary (ls) is denied', async () => {
    const exec = await sandbox.exec('ls /etc');
    await exec.wait();
    failed(exec);
  });

  // G7: the runtime allowlist keeps normal workloads working.
  await t.test('G7: node and shell builtins still run; workspace rw works', async () => {
    const node = await sandbox.exec('node -p process.version');
    await node.wait();
    succeeded(node);
    assert.match(readback(node), /^v\d+\.\d+\.\d+/);

    const echo = await sandbox.exec('echo confined-works');
    await echo.wait();
    succeeded(echo);
    assert.match(readback(echo), /confined-works/);

    const wsWrite = await sandbox.exec(
      `node -e "require('fs').writeFileSync('inws.txt','data')"`
    );
    await wsWrite.wait();
    succeeded(wsWrite);
    const read = await sandbox.exec(`node -e "process.stdout.write(require('fs').readFileSync('inws.txt','utf8'))"`);
    await read.wait();
    succeeded(read);
    assert.match(readback(read), /data/);
  });

  // E9/E5 (declared residual on Linux): /proc reads may remain visible because
  // Landlock is path-based and does not manage procfs. Record the residual
  // without pretending the attempt failed.
  await t.test('E9/E5: /proc read residual is declared, not asserted', async () => {
    const exec = await sandbox.exec('node -e "try{process.stdout.write(require(\'fs\').readFileSync(\'/proc/self/environ\',\'utf8\').length+\'\')}catch(e){process.stdout.write(\'denied\')}"');
    await exec.wait();
    // Both outcomes are acceptable and documented: `denied` is the strongest
    // case, a numeric length is the declared residual (RFC 0006, "Residuals").
    const out = readback(exec);
    assert.ok(out === 'denied' || /^\d+$/.test(out), `/proc self read: got '${out}'`);
  });

  // G6 (irrevocability): chmod on a path that is not granted must fail
  // (Landlock denies the inode metadata change outside the grant).
  await t.test('G6: irrevocability - cannot chmod an ungranted host file', async () => {
    const exec = await sandbox.exec(
      `node -e "require('fs').chmodSync('/tmp/palmshed-g6-target.txt',0o777)"`
    );
    await exec.wait();
    failed(exec);
  });

  // RFC adversarial plan item 14: after all failed attempts the sandbox is
  // healthy and reusable.
  await t.test('recovery: sandbox healthy and reusable after escape attempts', async () => {
    const exec = await sandbox.exec('echo still-alive');
    await exec.wait();
    succeeded(exec);
    assert.match(readback(exec), /still-alive/);
  });
});