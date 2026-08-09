/**
 * production/scenarios/resilience.mjs
 *
 * Input-shape stress: the hostile or sloppy inputs a real service receives.
 * Every case asserts the documented, predictable behavior and that the
 * sandbox remains usable afterward:
 *
 *   - malformed commands (syntax error, unknown binary)
 *   - missing working directories (auto-created) and path-traversal rejection
 *   - environment overrides (explicit wins; host env not wholesale-inherited)
 *   - symlink handling (internal round-trip; escape attempt must not corrupt)
 *   - nested directories (20 levels deep) as exec cwd
 *   - thousands of files (2000) created and counted
 *   - large stdout/stderr streams (4 MiB each) with byte-exact capture
 */
import * as os from 'os';
import * as path from 'path';

const BUDGET_MS = 180000;

export default {
  id: 'resilience',
  title: 'Resilience: malformed input, env overrides, symlinks, big trees',
  timeoutMs: BUDGET_MS,
  run: async (ctx) => {
    const baseline = ctx.scanResidue();

    // ── malformed commands ───────────────────────────────────────────────
    {
      const st = ctx.step('malformed-commands');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 15000 });

      const syntaxErr = await sandbox.exec('node -e "("', { timeout: 5000 });
      await syntaxErr.wait();
      ctx.assert.equal(syntaxErr.status(), 'failed', 'syntax error must be reported failed');
      ctx.assert.notEqual(syntaxErr.exitCode, 0, 'syntax error must exit non-zero');
      ctx.assert.ok(syntaxErr.stderr().length > 0, 'syntax error stderr must be captured');

      const missingBinary = await sandbox.exec('definitely-not-a-real-binary-xyz', { timeout: 5000 });
      await missingBinary.wait();
      ctx.assert.equal(missingBinary.status(), 'failed', 'unknown binary must be reported failed');
      ctx.assert.notEqual(missingBinary.exitCode, 0, 'unknown binary must exit non-zero');

      const after = await sandbox.exec('node -e "console.log(\'still-alive\')"', { timeout: 5000 });
      await after.wait();
      ctx.assert.equal(after.exitCode, 0, 'sandbox must remain usable after malformed commands');

      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── working directories: auto-create + traversal rejection ───────────
    {
      const st = ctx.step('workdir');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 15000 });

      // Missing workDir is created, not an error (documented behavior).
      const deep = await sandbox.exec('node -e "console.log(process.cwd())"', {
        workDir: 'projects/a/b/c/d',
        timeout: 5000,
      });
      await deep.wait();
      ctx.assert.equal(deep.exitCode, 0, 'exec with an absent workDir must auto-create it');
      // process.cwd() uses platform separators (backslashes on Windows), so
      // normalize to forward slashes before matching the requested workDir.
      const cwdNormalized = deep.stdout().replace(/\\/g, '/');
      ctx.assert.ok(
        cwdNormalized.includes('projects/a/b/c/d'),
        'exec must run inside the auto-created workDir'
      );

      // A traversal workDir must be rejected without poisoning the sandbox.
      let traversalErr = null;
      const traversal = await sandbox.exec('node -e "console.log(1)"', {
        workDir: '../../etc',
        timeout: 5000,
      });
      try {
        await traversal.wait();
      } catch (err) {
        traversalErr = err;
      }
      ctx.assert.ok(traversalErr, 'traversal workDir must surface an error');
      ctx.assert.equal(traversalErr.code, 'FS_ERROR', 'traversal workDir must reject with FS_ERROR');

      const ok = await sandbox.exec('node -e "console.log(\'usable\')"', { timeout: 5000 });
      await ok.wait();
      ctx.assert.equal(ok.exitCode, 0, 'sandbox must remain usable after traversal rejection');

      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── environment overrides ────────────────────────────────────────────
    {
      const st = ctx.step('env-overrides');
      // A marker on the host must NOT leak into the sandbox (only the
      // documented allowlist is carried over).
      process.env.PRODUCTION_SUITE_SECRET = 'host-secret-marker';
      const sandbox = await ctx.sandbox({
        network: 'disabled',
        timeout: 15000,
        env: { CUSTOM: 'from-sandbox', NUMBER_VAR: '42' },
      });
      const e = await sandbox.exec(
        `node -e "console.log(JSON.stringify({ custom: process.env.CUSTOM, num: process.env.NUMBER_VAR, secret: process.env.PRODUCTION_SUITE_SECRET ?? null }))"`,
        { timeout: 5000 }
      );
      await e.wait();
      ctx.assert.equal(e.exitCode, 0, 'env probe must run');
      const parsed = JSON.parse(e.stdout().trim());
      ctx.assert.equal(parsed.custom, 'from-sandbox', 'sandbox-level env must be visible');
      ctx.assert.equal(parsed.num, '42', 'sandbox-level env must be visible');
      ctx.assert.equal(parsed.secret, null, 'host env outside the allowlist must not leak');

      // Per-exec override beats the sandbox-level value.
      const override = await sandbox.exec(
        `node -e "console.log(process.env.CUSTOM)"`,
        { timeout: 5000, env: { CUSTOM: 'per-exec' } }
      );
      await override.wait();
      ctx.assert.equal(override.stdout().trim(), 'per-exec', 'per-exec env override must win');

      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── symlink handling ─────────────────────────────────────────────────
    {
      const st = ctx.step('symlinks');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 15000 });
      await sandbox.writeFile('src/target.txt', 'symlink-target-content');

      // Internal symlink round-trip. Windows file symlinks require privileges
      // and junctions only target directories, so the link may not be creatable
      // there; the script exits 0 either way and we verify from the SDK side.
      const link = await sandbox.exec(
        `node -e "try { require('fs').symlinkSync('src/target.txt', 'link.txt', '${ctx.isWin ? 'junction' : 'file'}'); } catch (e) { if (process.platform === 'win32') process.exit(0); throw e; } console.log('linked')"`,
        { timeout: 5000 }
      );
      await link.wait();
      const linkedCheck = await sandbox.exec(
        `node -e "console.log(require('fs').existsSync('link.txt') ? 1 : 0)"`,
        { timeout: 5000 }
      );
      await linkedCheck.wait();
      if (linkedCheck.stdout().trim() === '1') {
        const viaLink = await sandbox.readFile('link.txt');
        ctx.assert.equal(
          viaLink.toString('utf-8'),
          'symlink-target-content',
          'reading through an internal symlink must resolve to the target'
        );
      } else {
        ctx.log('symlink creation unsupported on this host; verified usability instead');
      }

      // Escape attempt: a symlink pointing at an absolute host path. The
      // Native backend has no OS-level filesystem isolation (issue #3), so the
      // read may succeed; the invariant is that the sandbox is not corrupted.
      const escape = await sandbox.exec(
        `node -e "try { require('fs').symlinkSync('${path.join(os.tmpdir(), 'production-suite-host-secret')}', 'escape.txt', 'file'); console.log('escape-link-created'); } catch (e) { if (process.platform === 'win32') process.exit(0); throw e; }"`,
        { timeout: 5000 }
      );
      await escape.wait();
      ctx.assert.equal(escape.exitCode, 0, 'symlink escape attempt must not crash the sandbox');

      const usable = await sandbox.exec('node -e "console.log(\'post-symlink\')"', { timeout: 5000 });
      await usable.wait();
      ctx.assert.equal(usable.exitCode, 0, 'sandbox must remain usable after symlink attempts');

      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── nested directories ───────────────────────────────────────────────
    {
      const st = ctx.step('nested-dirs');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 15000 });
      const deepPath = 'n0/n1/n2/n3/n4/n5/n6/n7/n8/n9/n10/n11/n12/n13/n14/n15/n16/n17/n18/n19';
      await sandbox.writeFile(`${deepPath}/leaf.txt`, 'deep-leaf');
      const fromDeep = await sandbox.exec('node -e "console.log(require(\'fs\').readFileSync(\'leaf.txt\', \'utf8\'))"', {
        workDir: deepPath,
        timeout: 5000,
      });
      await fromDeep.wait();
      ctx.assert.equal(fromDeep.exitCode, 0, 'exec deep inside nested directories must work');
      ctx.assert.equal(fromDeep.stdout().trim(), 'deep-leaf', 'deep file must be readable from its dir');
      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── thousands of files ───────────────────────────────────────────────
    {
      const st = ctx.step('thousands-of-files');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 15000 });
      const make = await sandbox.exec(
        `node -e "const fs=require('fs');fs.mkdirSync('many');for(let i=0;i<2000;i++)fs.writeFileSync('many/f'+i+'.txt','x')"`,
        { timeout: 15000 }
      );
      await make.wait();
      ctx.assert.equal(make.exitCode, 0, 'creating 2000 files must succeed');
      const count = await sandbox.exec(
        `node -e "console.log(require('fs').readdirSync('many').length)"`,
        { timeout: 5000 }
      );
      await count.wait();
      ctx.assert.equal(count.stdout().trim(), '2000', 'all 2000 files must be present');
      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    // ── large stdout/stderr streams ──────────────────────────────────────
    {
      const st = ctx.step('large-streams');
      const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 30000 });
      // Payload is generated inside the child; a 4 MiB literal on argv would
      // exceed ARG_MAX (spawn E2BIG).
      await sandbox.writeFile(
        'gen.js',
        `const s = Buffer.alloc(${4 * 1024 * 1024}, 'y').toString(); process.stdout.write(s); process.stderr.write(s);`
      );
      const payloadBytes = 4 * 1024 * 1024;
      const chunks = { stdout: 0, stderr: 0 };
      const e = await sandbox.exec('node gen.js', { timeout: 30000 });
      e.on('stdout', (c) => (chunks.stdout += Buffer.byteLength(c)));
      e.on('stderr', (c) => (chunks.stderr += Buffer.byteLength(c)));
      await e.wait();
      ctx.assert.equal(e.exitCode, 0, 'large-stream workload must complete');
      ctx.assert.equal(chunks.stdout, payloadBytes, 'every stdout byte must be streamed');
      ctx.assert.equal(chunks.stderr, payloadBytes, 'every stderr byte must be streamed');
      ctx.assert.equal(e.stdout().length, payloadBytes, 'captured stdout must be byte-exact');
      ctx.assert.equal(e.stderr().length, payloadBytes, 'captured stderr must be byte-exact');
      await sandbox.destroy();
      ctx.untrack(sandbox);
      st.end();
    }

    ctx.assertNoResidue(baseline, 'resilience');
  },
};
