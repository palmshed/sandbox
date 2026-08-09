import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { Sandbox } from '../index.js';
import { reapStaleSandboxes, registryDir, readHostStartToken } from '../core/crashRecovery.js';

const fixturePath = path.join(__dirname, 'fixtures', 'host-crash-fixture.js');

const isWin = process.platform === 'win32';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met within timeout');
}

async function waitUntilAsync(fn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met within timeout');
}

function entryHasPgids(dir: string): () => Promise<boolean> {
  return async () => {
    const entry = await readEntry(dir);
    return entry !== null && Array.isArray(entry.pgids) && (entry.pgids as number[]).length > 0;
  };
}

function entryFileFor(dir: string): string {
  return path.join(registryDir(), `${path.basename(dir)}.json`);
}

async function readEntry(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(entryFileFor(dir), 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function findSandboxDirWithMarker(marker: string): string {
  let newest = '';
  let newestMtime = 0;
  for (const name of fssync.readdirSync(os.tmpdir())) {
    if (!name.startsWith('palmshed-sandbox-')) continue;
    const dir = path.join(os.tmpdir(), name);
    if (!fssync.existsSync(path.join(dir, marker))) continue;
    const mtime = fssync.statSync(dir).mtimeMs;
    if (mtime > newestMtime) {
      newest = dir;
      newestMtime = mtime;
    }
  }
  return newest;
}

interface HostState {
  pid: number;
  dir: string;
  workloadPid: number;
  mode: string;
}

async function spawnHost(mode: 'workload' | 'nohup' | 'exit'): Promise<{ child: ChildProcess; state: HostState }> {
  const stateFile = path.join(
    os.tmpdir(),
    `host-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const child = spawn(process.execPath, [fixturePath, stateFile, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  let state: HostState | null = null;
  try {
    await waitUntil(() => {
      try {
        state = JSON.parse(fssync.readFileSync(stateFile, 'utf-8')) as HostState;
        return true;
      } catch {
        return false;
      }
    }, 15000);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`host fixture did not start: ${stderr || (err as Error).message}`);
  }
  fssync.unlinkSync(stateFile);
  return { child, state: state! };
}

test('Crash Recovery (RFC 0005)', async (t) => {
  const hosts: ChildProcess[] = [];
  t.after(async () => {
    for (const h of hosts) {
      try {
        h.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  await t.test('G1: graceful host shutdown cleans up sandbox and workload', async () => {
    const { child, state } = await spawnHost(isWin ? 'exit' : 'workload');
    hosts.push(child);
    try {
      await waitUntilAsync(() => readEntry(state.dir).then((e) => e !== null));
      await waitUntilAsync(entryHasPgids(state.dir));

      if (state.workloadPid) assert.ok(pidAlive(state.workloadPid), 'workload should be running');
      assert.ok(fssync.existsSync(state.dir), 'sandbox dir should exist');

      if (isWin) {
        // Windows cannot catch SIGTERM in JS handlers; the fixture self-exits,
        // which is the cross-platform graceful 'exit' hook path.
        await waitForExit(child);
      } else {
        process.kill(child.pid!, 'SIGTERM');
        await waitForExit(child);
      }

      assert.ok(!fssync.existsSync(state.dir), 'sandbox dir should be removed on graceful shutdown');
      if (state.workloadPid) {
        assert.ok(!pidAlive(state.workloadPid), 'workload should be terminated on graceful shutdown');
      }
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  await t.test('G2: hard host crash is reaped by the next sandbox creation', async () => {
    const { child, state } = await spawnHost('workload');
    hosts.push(child);
    try {
      await waitUntilAsync(entryHasPgids(state.dir));

      if (state.workloadPid) assert.ok(pidAlive(state.workloadPid));
      assert.ok(fssync.existsSync(state.dir));

      child.kill('SIGKILL');
      await waitForExit(child);

      // Nothing cleans up synchronously after a hard crash.
      assert.ok(fssync.existsSync(state.dir), 'dir must still exist before reaping');
      if (state.workloadPid) {
        assert.ok(pidAlive(state.workloadPid), 'workload survives the host until reaped');
      }

      // Creating a new sandbox triggers the stale-sandbox sweep.
      const fresh = await Sandbox.create({ backend: 'native', timeout: 5000 });
      try {
        await waitUntil(() => !fssync.existsSync(state.dir), 20000);
      } finally {
        await fresh.destroy();
      }

      assert.ok(!fssync.existsSync(state.dir), 'crashed sandbox dir should be reaped');
      if (state.workloadPid) {
        assert.ok(!pidAlive(state.workloadPid), 'orphaned workload should be terminated by reaper');
      }
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  await t.test('G3: backgrounded/nohup workload cannot escape reaping', { skip: isWin }, async () => {
    const { child, state } = await spawnHost('nohup');
    hosts.push(child);
    try {
      await waitUntilAsync(entryHasPgids(state.dir));

      if (state.workloadPid) assert.ok(pidAlive(state.workloadPid));
      child.kill('SIGKILL');
      await waitForExit(child);

      const fresh = await Sandbox.create({ backend: 'native', timeout: 5000 });
      try {
        await waitUntil(() => !fssync.existsSync(state.dir));
      } finally {
        await fresh.destroy();
      }

      assert.ok(!fssync.existsSync(state.dir));
      if (state.workloadPid) {
        assert.ok(!pidAlive(state.workloadPid), 'nohup workload should be terminated by reaper');
      }
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  await t.test('G4: reaper never touches a live sandbox', async () => {
    const marker = `marker-g4-${process.pid}.txt`;
    const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
    await sandbox.writeFile(marker, 'keep');
    const dir = findSandboxDirWithMarker(marker);
    try {
      assert.ok(dir, 'live sandbox dir should exist');
      const before = await sandbox.readFile(marker);
      assert.equal(before.toString(), 'keep');

      await reapStaleSandboxes(dir);

      assert.ok(fssync.existsSync(dir), 'live sandbox dir must survive a reaper pass');
      const after = await sandbox.readFile(marker);
      assert.equal(after.toString(), 'keep');
      const exec = await sandbox.exec('echo alive');
      await exec.wait();
      assert.equal(exec.exitCode, 0);
    } finally {
      await sandbox.destroy();
    }
  });

  await t.test('G5: PID-reuse token mismatch causes reaping', async () => {
    const marker = `marker-g5-${process.pid}.txt`;
    const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
    await sandbox.writeFile(marker, 'x');
    const dir = findSandboxDirWithMarker(marker);
    try {
      assert.ok(dir);
      assert.ok(readEntry(dir) !== null);

      // Simulate PID reuse: the recorded host PID is live (our process), but
      // the recorded start-time token no longer matches that PID.
      const entryPath = entryFileFor(dir);
      const entry = (await readEntry(dir))!;
      entry.hostStart = 'SIMULATED-RECYCLED-PID';
      await fs.writeFile(entryPath, JSON.stringify(entry));

      await reapStaleSandboxes();

      assert.ok(!fssync.existsSync(dir), 'sandbox with mismatched start token should be reaped');
    } finally {
      await sandbox.destroy();
    }
  });

  await t.test('G5b: live process start-time token is stable across reads', async () => {
    const token1 = readHostStartToken(process.pid);
    assert.ok(token1 !== null && token1 !== '', 'host start token must be readable');
    const token2 = readHostStartToken(process.pid);
    assert.equal(token2, token1, 'token must be constant for a live process (guards vsize drift)');
  });

  await t.test('G6: reaped sandboxes are never resurrected; fresh create is clean', async () => {
    const marker = `marker-g6-${process.pid}.txt`;
    const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });
    await sandbox.writeFile(marker, 'x');
    const dir = findSandboxDirWithMarker(marker);
    await sandbox.destroy();
    assert.ok(!fssync.existsSync(dir), 'destroyed sandbox dir is gone');

    const fresh = await Sandbox.create({ backend: 'native', timeout: 5000 });
    try {
      await fresh.writeFile(marker, 'x');
      const freshDir = findSandboxDirWithMarker(marker);
      assert.ok(freshDir, 'fresh sandbox should have its own dir');
      assert.notEqual(freshDir, dir);
    } finally {
      await fresh.destroy();
    }
  });
});
