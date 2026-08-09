/**
 * production/scenarios/os-filesystem-isolation.mjs
 *
 * RFC 0006 adversarial escape suite (E1-E10 / G1-G8) against the PACKED
 * artifact: confined-execution attempts that must FAIL, the allowlist + workspace
 * workloads that must SUCCEED, and full health/residue discipline. This scenario
 * asserts the real Native path is confined, not just that the probe passes.
 *
 * On hosts where the mechanism is not supported (non-Linux, pre-5.13 kernel,
 * restricted user namespaces), the scenario skips rather than asserting on
 * ambient-rights behavior; `osFilesystemIsolation: 'supported'` is a strong
 * claim and must only be exercised where the kernel actually provides it.
 */

export default {
  id: 'os-filesystem-isolation',
  title: 'RFC 0006 OS-filesystem isolation: escape, allowlist, recoverability, residue',
  timeoutMs: 180000,
  run: async (ctx) => {
    const probeBox = await ctx.sandbox({ timeout: 15000 });
    const cap = probeBox.capabilities.osFilesystemIsolation;
    await probeBox.destroy();
    ctx.untrack(probeBox);
    if (cap !== 'supported') {
      return ctx.log(`osFilesystemIsolation=${cap} on ${ctx.platform}; RFC 0006 scenario skipped (expected on non-Linux / unsupported kernels)`);
    }

    const baseline = ctx.scanResidue();
    const sandbox = await ctx.sandbox({ osFilesystemIsolation: true, timeout: 15000 });
    try {
      const r = (e) => e.stdout();
      const failed = (e) => ctx.assert.notEqual(e.exitCode, 0, `attempt must fail (status=${e.status()}, exit=${e.exitCode})`);

      // E1/G1: direct reads of world-readable host material must fail.
      const read = await sandbox.exec('node -e "process.stdout.write(require(\'fs\').readFileSync(\'/etc/passwd\'))"', { timeout: 5000 });
      await read.wait();
      failed(read);
      ctx.assert.ok(!r(read).includes('root:'), 'E1: /etc/passwd must not be readable');

      // G2: writes outside the workspace must fail.
      const write = await sandbox.exec('node -e "process.stdout.write(require(\'fs\').writeFileSync(\'/tmp/palmshed-escape-prod.txt\',\'x\')||\'ok\')"', { timeout: 5000 });
      await write.wait();
      failed(write);
      ctx.assert.ok(!r(write).includes('ok'), 'G2: write outside workspace must not succeed');

      // E2: symlink escape blocked.
      const plant = await sandbox.exec('node -e "require(\'fs\').symlinkSync(\'/etc/passwd\',\'escape.txt\')"', { timeout: 5000 });
      await plant.wait();
      if (plant.exitCode === 0) {
        const escape = await sandbox.exec('node -e "process.stdout.write(require(\'fs\').readFileSync(\'escape.txt\'))"', { timeout: 5000 });
        await escape.wait();
        failed(escape);
        ctx.assert.ok(!r(escape).includes('root:'), 'E2: symlink escape must not expose /etc/passwd');
      }

      // E3: hardlink escape blocked.
      const link = await sandbox.exec('node -e "require(\'fs\').linkSync(\'/etc/passwd\',\'hardlink.txt\')"', { timeout: 5000 });
      await link.wait();
      failed(link);

      // E10: absolute host path read via interpreter is denied.
      const abs = await sandbox.exec('node -e "process.stdout.write(require(\'fs\').readFileSync(\'/etc/hostname\'))"', { timeout: 5000 });
      await abs.wait();
      failed(abs);

      // G3: exec of an unallowlisted binary is denied.
      const execDeny = await sandbox.exec('ls /etc', { timeout: 5000 });
      await execDeny.wait();
      failed(execDeny);

      // G7: the runtime allowlist keeps node/shell + workspace rw working.
      const node = await sandbox.exec('node -p process.version', { timeout: 5000 });
      await node.wait();
      ctx.assert.equal(node.exitCode, 0, 'G7: node must run under the allowlist');
      ctx.assert.match(r(node), /^v\d+\.\d+\.\d+/);

      const wsWrite = await sandbox.exec('node -e "require(\'fs\').writeFileSync(\'artifact.txt\',\'built-in-workspace\')"', { timeout: 5000 });
      await wsWrite.wait();
      ctx.assert.equal(wsWrite.exitCode, 0, 'G7: workspace write must succeed');

      const prod = await sandbox.exec('node artifact.txt', { timeout: 5000 });
      await prod.wait();
      ctx.assert.equal(prod.exitCode, 0, 'G7: workspace-heavy workload must succeed');
      ctx.assert.match(r(prod), /built-in-workspace/);

      // RFC adversarial item 14: after all failed attempts the sandbox stays healthy.
      const reuse = await sandbox.exec('echo post-escape-alive', { timeout: 5000 });
      await reuse.wait();
      ctx.assert.equal(reuse.exitCode, 0, 'sandbox must be healthy and reusable after escape attempts');
    } finally {
      await sandbox.destroy();
      ctx.untrack(sandbox);
    }

    ctx.assertNoResidue(baseline, 'os-filesystem-isolation');
  },
};