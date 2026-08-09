/**
 * production/scenarios/artifacts.mjs
 *
 * Filesystem artifact integrity under real upload/download pressure:
 * concurrent uploads, overwrite semantics, and byte-exact round-trips for
 * both text and binary payloads.
 */
const BUDGET_MS = 120000;

export default {
  id: 'artifacts',
  title: 'Artifacts: concurrent transfers, overwrites, byte-exact round-trips',
  timeoutMs: BUDGET_MS,
  run: async (ctx) => {
    const baseline = ctx.scanResidue();
    const sandbox = await ctx.sandbox({ network: 'disabled', timeout: 30000 });

    // ── concurrent uploads ───────────────────────────────────────────────
    {
      const st = ctx.step('concurrent-uploads');
      const uploads = Array.from({ length: 25 }, (_, i) =>
        sandbox.writeFile(`inbox/blob-${i}.txt`, `payload-${i}`).then(() => i)
      );
      const done = await Promise.all(uploads);
      ctx.assert.equal(done.length, 25, 'all 25 concurrent uploads must resolve');
      const probe = await sandbox.exec(
        `node -e "const fs=require('fs');let ok=true;for(let i=0;i<25;i++){if(fs.readFileSync('inbox/blob-'+i+'.txt','utf8')!=='payload-'+i)ok=false}console.log(ok)"`,
        { timeout: 10000 }
      );
      await probe.wait();
      ctx.assert.equal(probe.exitCode, 0, 'upload probe must run');
      ctx.assert.equal(probe.stdout().trim(), 'true', 'every concurrent upload must land intact');
      st.end();
    }

    // ── concurrent downloads ─────────────────────────────────────────────
    {
      const st = ctx.step('concurrent-downloads');
      const reads = await Promise.all(
        Array.from({ length: 25 }, (_, i) => sandbox.readFile(`inbox/blob-${i}.txt`))
      );
      for (let i = 0; i < 25; i++) {
        ctx.assert.equal(reads[i].toString('utf-8'), `payload-${i}`, `download ${i} must round-trip`);
      }
      st.end();
    }

    // ── binary byte-exact round-trip ─────────────────────────────────────
    {
      const st = ctx.step('binary-round-trip');
      const binary = Buffer.alloc(512 * 1024);
      for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
      await sandbox.writeFile('bin/blob.bin', binary);
      const back = await sandbox.readFile('bin/blob.bin');
      ctx.assert.ok(binary.equals(back), '512 KiB binary blob must round-trip byte-exactly');
      st.end();
    }

    // ── overwrite semantics ──────────────────────────────────────────────
    {
      const st = ctx.step('overwrite');
      await sandbox.writeFile('mutate.txt', 'version-1');
      await sandbox.writeFile('mutate.txt', 'version-2');
      const second = await sandbox.readFile('mutate.txt');
      ctx.assert.equal(second.toString('utf-8'), 'version-2', 'overwrite must replace content');
      const probe = await sandbox.exec(
        `node -e "require('fs').writeFileSync('mutate.txt','version-3');console.log(require('fs').readFileSync('mutate.txt','utf8'))"`,
        { timeout: 5000 }
      );
      await probe.wait();
      ctx.assert.equal(probe.stdout().trim(), 'version-3', 'in-sandbox writes must be visible to the SDK');
      const third = await sandbox.readFile('mutate.txt');
      ctx.assert.equal(third.toString('utf-8'), 'version-3', 'SDK reads must reflect in-sandbox writes');
      st.end();
    }

    await sandbox.destroy();
    ctx.untrack(sandbox);
    ctx.assertNoResidue(baseline, 'artifacts');
  },
};
