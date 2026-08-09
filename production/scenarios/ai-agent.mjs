/**
 * production/scenarios/ai-agent.mjs
 *
 * End-to-end AI coding agent workflow against the Native backend:
 *
 *   create sandbox
 *   → upload repository
 *   → install dependencies (dependency-free fixture, so no network needed)
 *   → run agent commands (generate + execute code)
 *   → stream output live
 *   → modify files (agent applies a patch)
 *   → run tests again (patch must be reflected)
 *   → collect artifacts
 *   → destroy sandbox
 *   → assert no residue
 *
 * The assertion is not just "the commands ran": it is that every phase left
 * the sandbox in the correct state, cleaned up correctly, and remained
 * usable afterward.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

const BUDGET_MS = 120000;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Build a tiny repository tree on the host, exactly like a checkout. */
function buildRepo(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'agent-fixture',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node --test' },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'calc.mjs'),
    `export function add(a, b) { return a + b; }
export function double(n) { return n * 2; }
`
  );
  fs.writeFileSync(
    path.join(dir, 'test', 'calc.test.mjs'),
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { add, double } from '../src/calc.mjs';
test('add', () => assert.equal(add(2, 3), 5));
test('double', () => assert.equal(double(4), 8));
`
  );
}

const agentTasks = [
  {
    description: 'sum an array and print JSON',
    code: `const nums = [1, 2, 3, 4, 5];\nconsole.log(JSON.stringify({ result: nums.reduce((a, b) => a + b, 0), ok: true }));`,
    expect: '{"result":15,"ok":true}',
  },
  {
    description: 'read a file the agent just wrote',
    code: `import fs from 'node:fs';\nfs.writeFileSync('note.txt', 'agent wrote this');\nconsole.log(fs.readFileSync('note.txt', 'utf8'));`,
    expect: 'agent wrote this',
  },
];

async function runAgentTask(ctx, sandbox, task) {
  const st = ctx.step(`task:${task.description.slice(0, 24)}`);
  await sandbox.writeFile('agent/task.js', task.code);
  const chunks = [];
  const execution = await sandbox.exec('node agent/task.js', { timeout: 10000 });
  execution.on('stdout', (chunk) => chunks.push(chunk));
  await execution.wait();
  st.end();
  const stdout = chunks.join('');
  ctx.assert.equal(execution.status(), 'completed', `agent task should complete: ${task.description}`);
  ctx.assert.ok(stdout.includes(task.expect), `agent task output should contain ${task.expect}`);
  ctx.assert.ok(chunks.length > 0, 'agent task output should stream in chunks');
}

export default {
  id: 'ai-agent',
  title: 'AI coding agent: full workflow with streaming, patching, artifacts',
  timeoutMs: BUDGET_MS,
  run: async (ctx) => {
    const baseline = ctx.scanResidue();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-ai-agent-repo-'));
    buildRepo(repoDir);

    try {
      let sandbox;
      try {
        // Phase 1: create + upload repository (checkout).
        sandbox = await ctx.sandbox({ network: 'disabled', timeout: 30000 });
        let st = ctx.step('upload');
        await sandbox.uploadFile(path.join(repoDir, 'package.json'), 'package.json');
        await sandbox.uploadFile(path.join(repoDir, 'src', 'calc.mjs'), 'src/calc.mjs');
        await sandbox.uploadFile(path.join(repoDir, 'test', 'calc.test.mjs'), 'test/calc.test.mjs');
        st.end();

        // Phase 2: baseline tests pass.
        st = ctx.step('baseline-test');
        const baselineRun = await sandbox.exec('npm test', { timeout: 30000 });
        await baselineRun.wait();
        st.end();
        ctx.assert.equal(baselineRun.exitCode, 0, 'baseline tests should pass');

        // Phase 3: agent generates and executes code, output streamed.
        for (const task of agentTasks) {
          await runAgentTask(ctx, sandbox, task);
        }

        // Phase 4: agent applies a patch; rerun tests must reflect the change.
        st = ctx.step('patch');
        await sandbox.writeFile(
          'src/calc.mjs',
          `export function add(a, b) { return a + b + 10; }\nexport function double(n) { return n * 2; }\n`
        );
        st.end();

        st = ctx.step('patched-test');
        const patchedRun = await sandbox.exec('npm test', { timeout: 30000 });
        await patchedRun.wait();
        st.end();
        ctx.assert.equal(patchedRun.status(), 'failed', 'patched tests should fail because add(2,3) is now 15');
        ctx.assert.notEqual(patchedRun.exitCode, 0, 'patched tests should exit non-zero');

        // Phase 5: collect artifacts.
        st = ctx.step('artifact');
        const artifactExec = await sandbox.exec('node -e "const fs=require(\'fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.writeFileSync(\'dist/report.json\', JSON.stringify({ sha: \'abc123\' }))"', { timeout: 10000 });
        await artifactExec.wait();
        ctx.assert.equal(artifactExec.exitCode, 0, 'artifact generation must succeed');
        const artifact = await sandbox.readFile('dist/report.json');
        const artifactHash = sha256(artifact);
        const hostCopy = path.join(os.tmpdir(), `prod-ai-agent-artifact-${process.pid}-${Date.now()}.json`);
        await sandbox.downloadFile('dist/report.json', hostCopy);
        const hostBytes = fs.readFileSync(hostCopy);
        ctx.assert.equal(sha256(hostBytes), artifactHash, 'downloaded artifact must byte-match the sandbox copy');
        ctx.assert.ok(artifact.toString('utf-8').includes('abc123'), 'artifact contents should be correct');
        fs.rmSync(hostCopy, { force: true });
        st.end();

        // Phase 6: destroy and verify the system returned to its prior state.
        await sandbox.destroy();
        ctx.untrack(sandbox);
        sandbox = null;
        ctx.assertNoResidue(baseline, 'ai-agent');
        ctx.log('PASS: agent workflow complete, sandbox cleaned up');
      } finally {
        if (sandbox) await sandbox.destroy();
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  },
};
