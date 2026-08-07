import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BackendEngine } from './interface.js';
import { ExecOptions, ExecResult, SandboxError, SandboxOptions, SandboxResourceError } from '../core/types.js';

export class NativeBackend implements BackendEngine {
  public readonly name = 'native';
  public readonly capabilities = {
    filesystem: true,
    networkIsolation: true,  // Probed at init: true if unshare --user works (macOS: sandbox-exec always available); false on Linux CI where user namespaces are restricted
    cpuLimits: true,
    memoryLimits: true,
    streaming: true,
    remoteExecution: false,
  };
  private sandboxDir: string = '';
  private options!: SandboxOptions;
  /** Active child processes -- killed on destroy() */
  private activeProcesses = new Set<ChildProcess>();
  /** Whether Linux unshare --user network namespace creation succeeded at init */
  private networkIsolationAvailable = true;

  async init(options: SandboxOptions): Promise<void> {
    this.options = options;
    // Create an isolated temporary working directory for native execution
    const tmpPrefix = path.join(os.tmpdir(), 'palmshed-sandbox-');
    this.sandboxDir = await fs.mkdtemp(tmpPrefix);

    if (options.workDir) {
      const targetDir = path.resolve(this.sandboxDir, options.workDir);
      await fs.mkdir(targetDir, { recursive: true });
    }

    // Probe: on Linux, verify unprivileged user-namespace network isolation
    // works. If unshare --user --map-root-user fails (e.g. user namespaces
    // restricted, or unshare not supporting the flags), we cannot enforce
    // network isolation without root. Disable the capability and fall back
    // to proxy env vars so commands still execute.
    if (process.platform === 'linux') {
      try {
        execSync('unshare -n --user --map-root-user -- /bin/echo ok', {
          timeout: 5000,
          stdio: 'ignore',
        });
      } catch {
        this.networkIsolationAvailable = false;
        this.capabilities.networkIsolation = false;
      }
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? this.options.timeout ?? 0;
    const cwd = options.workDir
      ? path.resolve(this.sandboxDir, options.workDir)
      : this.sandboxDir;

    const env = {
      ...process.env,
      ...this.options.env,
      ...options.env,
    };

    // If network is disabled, set standard proxy/offline indicators
    if (this.options.network === 'disabled') {
      env.HTTP_PROXY = 'http://127.0.0.1:0';
      env.HTTPS_PROXY = 'http://127.0.0.1:0';
      env.NO_PROXY = '';
    }

    // Parse memory limit: per-execution option takes precedence over sandbox-level option
    const rawMemoryLimit = options.memory ?? this.options.memory;
    const memLimitBytes = rawMemoryLimit !== undefined ? this.parseSizeStringToBytes(
      typeof rawMemoryLimit === 'number' ? String(rawMemoryLimit) : rawMemoryLimit
    ) : null;

    // Parse CPU time limit (ms): per-execution option takes precedence over sandbox-level option
    const rawCpuTimeLimit = options.cpuTimeLimit ?? this.options.cpuTimeLimit;
    const cpuTimeLimitMs = rawCpuTimeLimit !== undefined && rawCpuTimeLimit > 0 ? rawCpuTimeLimit : null;

    return new Promise((resolve, reject) => {
      let stdoutAcc = '';
      let stderrAcc = '';
      let timedOut = false;
      let oomKilled = false;
      let cpuExceeded = false;
      let timer: NodeJS.Timeout | null = null;
      let memPoller: NodeJS.Timeout | null = null;
      let cpuPoller: NodeJS.Timeout | null = null;
      let settled = false;
      let finalCpuTimeMs: number | undefined;

      /**
       * Sample the total RSS of a process group/tree in bytes, cross-platform.
       * The root PID is the spawned shell (`child.pid`); on POSIX it is also the
       * process group ID because the child is spawned detached. Sampling the
       * whole group ensures compound commands (pipelines, background jobs,
       * chained `sh -c` children) cannot bypass memory enforcement by running
       * in a descendant process with a small parent shell.
       * Returns -1 if the group cannot be read (process already exited).
       */
      const sampleGroupRssBytes = (rootPid: number): number => {
        const platform = process.platform;
        if (platform === 'linux') {
          // Sum VmRSS across every process whose pgrp matches the root PID.
          let total = 0;
          let found = false;
          let entries: string[] = [];
          try {
            entries = fssync.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
          } catch {
            return -1;
          }
          for (const d of entries) {
            let statRaw: string;
            try {
              statRaw = fssync.readFileSync(`/proc/${d}/stat`, 'utf-8');
            } catch {
              continue; // process already exited
            }
            // comm may contain spaces/parens, so parse after the last ')'
            const closeParen = statRaw.lastIndexOf(')');
            if (closeParen === -1) continue;
            const rest = statRaw.slice(closeParen + 2).split(' ');
            // rest[0]=state, rest[1]=ppid, rest[2]=pgrp
            if (parseInt(rest[2], 10) !== rootPid) continue;
            found = true;
            try {
              const status = fssync.readFileSync(`/proc/${d}/status`, 'utf-8');
              const match = status.match(/VmRSS:\s*(\d+)\s*kB/);
              if (match) total += parseInt(match[1], 10) * 1024;
            } catch {
              // process exited mid-scan
            }
          }
          return found ? total : -1;
        } else if (platform === 'darwin') {
          // macOS: ps reports RSS in 1KB blocks; -g selects by process group
          let out: string;
          try {
            out = execSync(`ps -o rss= -g ${rootPid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
          } catch {
            return -1; // process group already gone
          }
          const lines = out.trim().split('\n').filter(Boolean);
          if (lines.length === 0) return -1;
          return lines.reduce((sum, l) => sum + (parseInt(l, 10) || 0), 0) * 1024;
        } else if (platform === 'win32') {
          // Windows: WMIC process-tree walk from the root PID. This is polling
          // based rather than Job Object accounting, so a child that detaches
          // from the tree can escape accounting. Documented platform limitation.
          let out: string;
          try {
            out = execSync(
              'wmic process get ProcessId,ParentProcessId,WorkingSetSize /value',
              { stdio: ['ignore', 'pipe', 'ignore'] }
            ).toString();
          } catch {
            return -1;
          }
          const procs = new Map<number, { ppid: number; rss: number }>();
          let curPid = 0;
          let curPpid = 0;
          let curRss = 0;
          for (const line of out.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
              if (curPid) procs.set(curPid, { ppid: curPpid, rss: curRss });
              curPid = 0;
              curPpid = 0;
              curRss = 0;
              continue;
            }
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq);
            const val = parseInt(trimmed.slice(eq + 1), 10) || 0;
            if (key === 'ProcessId') curPid = val;
            else if (key === 'ParentProcessId') curPpid = val;
            else if (key === 'WorkingSetSize') curRss = val;
          }
          if (curPid) procs.set(curPid, { ppid: curPpid, rss: curRss });
          // BFS from the root PID summing RSS across the process tree
          let total = 0;
          const visited = new Set<number>();
          const queue = [rootPid];
          while (queue.length) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);
            const p = procs.get(current);
            if (!p) continue;
            total += p.rss;
            for (const [childPid, child] of procs) {
              if (child.ppid === current && !visited.has(childPid)) queue.push(childPid);
            }
          }
          return total;
        }
        return -1;
      };

      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const shellFlag = isWin ? '/s /c' : '-c';

      /**
       * Sample the total CPU time (user + system) of a process group/tree in
       * milliseconds, cross-platform. Same process-group accounting as the RSS
       * sampler: enforcement must measure the workload (shell children,
       * pipelines, background jobs), not just the top-level PID.
       * Returns -1 if the group cannot be read (process already exited).
       */
      const sampleGroupCpuTimeMs = (rootPid: number): number => {
        const platform = process.platform;
        if (platform === 'linux') {
          // Sum utime+stime across every process whose pgrp matches rootPid.
          // /proc/<pid>/stat fields (after last ')'): state ppid pgrp session
          // tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
          // Ticks are in USER_HZ (typically 100).
          let total = 0;
          let found = false;
          let entries: string[] = [];
          try {
            entries = fssync.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
          } catch {
            return -1;
          }
          for (const d of entries) {
            let statRaw: string;
            try {
              statRaw = fssync.readFileSync(`/proc/${d}/stat`, 'utf-8');
            } catch {
              continue;
            }
            const closeParen = statRaw.lastIndexOf(')');
            if (closeParen === -1) continue;
            const rest = statRaw.slice(closeParen + 2).split(' ');
            if (parseInt(rest[2], 10) !== rootPid) continue;
            found = true;
            const utime = parseInt(rest[11], 10) || 0;
            const stime = parseInt(rest[12], 10) || 0;
            total += (utime + stime) * 10; // 100 ticks/sec => 10ms per tick
          }
          return found ? total : -1;
        } else if (platform === 'darwin') {
          // macOS: ps reports utime/stime as [MM:]SS.CC
          let out: string;
          try {
            out = execSync(`ps -o utime=,stime= -g ${rootPid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
          } catch {
            return -1;
          }
          const lines = out.trim().split('\n').filter(Boolean);
          if (lines.length === 0) return -1;
          let total = 0;
          for (const line of lines) {
            const [utime, stime] = line.trim().split(/\s+/);
            total += parseMacTimeToMs(utime) + parseMacTimeToMs(stime);
          }
          return total;
        } else if (platform === 'win32') {
          // Windows: WMIC process-tree walk of KernelModeTime + UserModeTime
          // (100-nanosecond units => /10000 = ms).
          let out: string;
          try {
            out = execSync(
              'wmic process get ProcessId,ParentProcessId,KernelModeTime,UserModeTime /value',
              { stdio: ['ignore', 'pipe', 'ignore'] }
            ).toString();
          } catch {
            return -1;
          }
          const procs = new Map<number, { ppid: number; cpu: number }>();
          let curPid = 0;
          let curPpid = 0;
          let curCpu = 0;
          for (const line of out.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
              if (curPid) procs.set(curPid, { ppid: curPpid, cpu: curCpu });
              curPid = 0;
              curPpid = 0;
              curCpu = 0;
              continue;
            }
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq);
            const val = parseInt(trimmed.slice(eq + 1), 10) || 0;
            if (key === 'ProcessId') curPid = val;
            else if (key === 'ParentProcessId') curPpid = val;
            else if (key === 'KernelModeTime' || key === 'UserModeTime') curCpu += val;
          }
          if (curPid) procs.set(curPid, { ppid: curPpid, cpu: curCpu });
          let total = 0;
          const visited = new Set<number>();
          const queue = [rootPid];
          while (queue.length) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);
            const p = procs.get(current);
            if (!p) continue;
            total += p.cpu;
            for (const [childPid, child] of procs) {
              if (child.ppid === current && !visited.has(childPid)) queue.push(childPid);
            }
          }
          return total / 10000;
        }
        return -1;
      };

      /**
       * Parse a macOS ps time string ([MM:]SS.CC, optionally [dd-]hh:mm:ss[.CC])
       * into milliseconds. Missing fields are treated as zero.
       */
      const parseMacTimeToMs = (raw: string): number => {
        if (!raw) return 0;
        let s = raw.trim();
        if (!s) return 0;
        let days = 0;
        const dashIdx = s.indexOf('-');
        if (dashIdx !== -1) {
          days = parseInt(s.slice(0, dashIdx), 10) || 0;
          s = s.slice(dashIdx + 1);
        }
        const parts = s.split(':');
        let totalMs = days * 24 * 3600 * 1000;
        if (parts.length === 3) {
          totalMs += (parseInt(parts[0], 10) || 0) * 3600 * 1000;
          totalMs += (parseInt(parts[1], 10) || 0) * 60 * 1000;
          totalMs += Math.round((parseFloat(parts[2]) || 0) * 1000);
        } else if (parts.length === 2) {
          totalMs += (parseInt(parts[0], 10) || 0) * 60 * 1000;
          totalMs += Math.round((parseFloat(parts[1]) || 0) * 1000);
        } else {
          totalMs += Math.round((parseFloat(s) || 0) * 1000);
        }
        return totalMs;
      };

      /**
       * RFC 0004: Network isolation for `network: 'disabled'`.
       * On Linux, use `unshare -n --user --map-root-user` to create an isolated
       * network namespace without requiring root privileges (unprivileged user
       * namespaces provide the CAP_SYS_ADMIN needed to also create the netns).
       * On macOS, use `sandbox-exec` with a Seatbelt profile (deprecated but working).
       * On Windows, network isolation is Unsupported (no-op).
       */
      let spawnShell = shell;
      let spawnArgs: string[];

      if (this.options.network === 'disabled') {
        if (process.platform === 'linux') {
          if (this.networkIsolationAvailable) {
            spawnShell = '/bin/sh';
            spawnArgs = ['-c', `unshare -n --user --map-root-user -- /bin/sh -c ${JSON.stringify(command)}`];
          } else {
            spawnShell = shell;
            spawnArgs = [shellFlag, command];
          }
        } else if (process.platform === 'darwin') {
          const sbProfile = '(version 1) (allow default) (deny network*)';
          spawnShell = '/usr/bin/sandbox-exec';
          spawnArgs = ['-p', sbProfile, shell, shellFlag, command];
        } else {
          spawnShell = shell;
          spawnArgs = [shellFlag, command];
        }
      } else {
        spawnShell = shell;
        spawnArgs = [shellFlag, command];
      }

      const child = spawn(spawnShell, spawnArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Use a process group so we can kill descendants too (non-Windows)
        detached: !isWin,
      });

      this.activeProcesses.add(child);

      /**
       * Kill the process gracefully: SIGTERM first, then SIGKILL after 1s if
       * the process hasn't exited. On Windows, fall back to kill() directly.
       */
      const killProcess = (signal: NodeJS.Signals = 'SIGTERM') => {
        if (settled) return;
        try {
          if (!isWin && child.pid !== undefined) {
            const descendants = this.getDescendantPids(child.pid);
            for (const pid of descendants) {
              try {
                process.kill(pid, signal);
              } catch {
                // process may have already exited
              }
            }
            process.kill(-child.pid, signal);
          } else if (isWin && child.pid !== undefined) {
            const { execSync } = require('child_process');
            try {
              execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
            } catch {
              child.kill(signal);
            }
          } else {
            child.kill(signal);
          }
          if (signal === 'SIGTERM') {
            setTimeout(() => {
              if (!settled) killProcess('SIGKILL');
            }, 1000);
          }
        } catch {
          // Process may have already exited
        }
      };

      // Expose kill function to the Execution handle via Sandbox.exec()
      if (options.onProcessSpawned) {
        options.onProcessSpawned(killProcess);
      }

      if (options.stdin && child.stdin) {
        options.stdin.pipe(child.stdin);
      }

      if (timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcess('SIGKILL');
        }, timeout);
      }

      // RSS-polling memory enforcement (100ms interval). Samples the entire
      // process group/tree so descendant workloads (pipelines, background jobs,
      // chained sh -c children) are counted against the limit, not just the
      // top-level shell process.
      if (memLimitBytes !== null && child.pid !== undefined) {
        const monitoredRootPid = child.pid;
        memPoller = setInterval(() => {
          if (settled) {
            clearInterval(memPoller!);
            return;
          }
          const rss = sampleGroupRssBytes(monitoredRootPid);
          if (rss === -1) return; // process group already gone
          if (rss > memLimitBytes) {
            oomKilled = true;
            clearInterval(memPoller!);
            killProcess('SIGKILL');
          }
        }, 100);
      }

      // CPU-time budget enforcement (100ms interval). Measures cumulative
      // user+system CPU time across the whole process group, so a workload
      // that forks workers, pipelines, or background children cannot hide its
      // CPU consumption in a descendant process. Independent of wall-clock
      // timeout: a workload can exceed CPU time while staying within timeout.
      if (cpuTimeLimitMs !== null && child.pid !== undefined) {
        const monitoredRootPid = child.pid;
        cpuPoller = setInterval(() => {
          if (settled) {
            clearInterval(cpuPoller!);
            return;
          }
          const cpuMs = sampleGroupCpuTimeMs(monitoredRootPid);
          if (cpuMs === -1) return; // process group already gone
          finalCpuTimeMs = cpuMs;
          if (cpuMs > cpuTimeLimitMs) {
            cpuExceeded = true;
            clearInterval(cpuPoller!);
            killProcess('SIGKILL');
          }
        }, 100);
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        stdoutAcc += str;
        if (options.onStdout) options.onStdout(str);
        if (options.stdout) options.stdout.write(chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        stderrAcc += str;
        if (options.onStderr) options.onStderr(str);
        if (options.stderr) options.stderr.write(chunk);
      });

      child.on('error', (err) => {
        settled = true;
        this.activeProcesses.delete(child);
        if (timer) clearTimeout(timer);
        reject(new SandboxError(`Execution failed: ${err.message}`, 'EXEC_FAILED', err));
      });

      child.on('close', async (code) => {
        settled = true;
        this.activeProcesses.delete(child);
        if (timer) clearTimeout(timer);
        if (memPoller) clearInterval(memPoller);
        if (cpuPoller) clearInterval(cpuPoller);
        // Best-effort final CPU-time sample for reporting even when no CPU
        // limit was configured (the process group has already been killed).
        if (finalCpuTimeMs === undefined && child.pid !== undefined) {
          const last = sampleGroupCpuTimeMs(child.pid);
          if (last !== -1) finalCpuTimeMs = last;
        }

        // Thorough cleanup: kill process group, then sweep escaped descendants
        if (child.pid !== undefined) {
          await this.cleanupProcessTree(child.pid);
        }

        const finishedAtMs = Date.now();
        const durationMs = finishedAtMs - startTime;
        const execId = `exec_${Math.random().toString(36).substring(2, 10)}`;
        const exitCode = timedOut || oomKilled || cpuExceeded ? -1 : (code ?? 0);

        if (oomKilled && memLimitBytes !== null) {
          // Capture final RSS best-effort (process is gone, use limit as observed)
          reject(new SandboxResourceError(
            `Memory limit exceeded: process RSS exceeded limit of ${rawMemoryLimit}`,
            'ERR_OOM_EXCEEDED',
            {
              resource: 'memory',
              limit: rawMemoryLimit!,
              observed: `>${rawMemoryLimit}`,
              recoverable: true,
            }
          ));
          return;
        }

        if (cpuExceeded && cpuTimeLimitMs !== null) {
          reject(new SandboxResourceError(
            `CPU time limit exceeded: process group consumed more than ${rawCpuTimeLimit}ms of CPU time`,
            'ERR_CPU_EXCEEDED',
            {
              resource: 'cpu',
              limit: rawCpuTimeLimit!,
              observed: `>${rawCpuTimeLimit}`,
              recoverable: true,
            }
          ));
          return;
        }

        const metadata = {
          id: execId,
          backend: this.name,
          specVersion: '0.1.1',
          startedAt: new Date(startTime).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs,
          exitCode,
          timedOut,
          cpuTimeMs: finalCpuTimeMs,
        };

        resolve({
          id: execId,
          exitCode,
          stdout: stdoutAcc,
          stderr: stderrAcc,
          durationMs,
          timedOut,
          cpuTimeMs: finalCpuTimeMs,
          metadata,
        });
      });
    });
  }

  private resolveSandboxPath(targetPath: string): string {
    const resolved = path.resolve(this.sandboxDir, targetPath);
    if (!resolved.startsWith(this.sandboxDir)) {
      throw new SandboxError('Path traversal attempt outside sandbox root', 'FS_ERROR');
    }
    return resolved;
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          totalSize += stat.size;
        }
      }
    } catch {
      // Directory may not exist yet
    }
    return totalSize;
  }

  private async assertDiskQuotaAvailable(additionalBytes: number): Promise<void> {
    if (!this.options?.diskQuota) return;
    const quotaBytes =
      typeof this.options.diskQuota === 'number'
        ? this.options.diskQuota
        : this.parseSizeStringToBytes(this.options.diskQuota);

    const currentSize = await this.getDirectorySize(this.sandboxDir);
    if (currentSize + additionalBytes > quotaBytes) {
      // SandboxResourceError is a direct import at the top of this file
      throw new SandboxResourceError(
        `Disk quota exceeded: current usage ${currentSize + additionalBytes} bytes exceeds limit of ${quotaBytes} bytes`,
        'ERR_DISK_QUOTA_EXCEEDED',
        {
          resource: 'disk',
          limit: this.options.diskQuota,
          observed: currentSize + additionalBytes,
          recoverable: true,
        }
      );
    }
  }

  private parseSizeStringToBytes(sizeStr: string): number {
    const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
    if (!match) return 100 * 1024 * 1024; // Default fallback 100MB
    const num = parseFloat(match[1]);
    const unit = (match[2] || 'MB').toUpperCase();
    const multipliers: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
    };
    return Math.floor(num * (multipliers[unit] || 1024 * 1024));
  }

  private getChildPids(parentPid: number): number[] {
    const children: number[] = [];
    if (process.platform === 'linux') {
      try {
        const entries = fssync.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
        for (const d of entries) {
          let statRaw: string;
          try {
            statRaw = fssync.readFileSync(`/proc/${d}/stat`, 'utf-8');
          } catch {
            continue;
          }
          const closeParen = statRaw.lastIndexOf(')');
          if (closeParen === -1) continue;
          const rest = statRaw.slice(closeParen + 2).split(' ');
          const ppid = parseInt(rest[1], 10);
          if (ppid === parentPid) {
            children.push(parseInt(d, 10));
          }
        }
      } catch {
        // /proc unavailable
      }
    } else {
      let out: string;
      try {
        const { execSync } = require('child_process');
        out = execSync('ps -o pid=,ppid=', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      } catch {
        return children;
      }
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          if (ppid === parentPid && !isNaN(pid)) {
            children.push(pid);
          }
        }
      }
    }
    return children;
  }

  private getDescendantPids(rootPid: number): number[] {
    const descendants: number[] = [];
    const queue: number[] = [rootPid];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      const children = this.getChildPids(pid);
      for (const childPid of children) {
        descendants.push(childPid);
        queue.push(childPid);
      }
    }
    return descendants;
  }

  private async cleanupProcessTree(rootPid: number): Promise<void> {
    if (rootPid === undefined) return;

    if (process.platform !== 'win32') {
      try {
        process.kill(-rootPid, 'SIGKILL');
      } catch {
        // process group may already be gone
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    let remaining = this.getDescendantPids(rootPid);
    let iterations = 0;
    while (remaining.length > 0 && iterations < 10) {
      for (const pid of remaining) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // process may have already exited
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      remaining = this.getDescendantPids(rootPid);
      iterations++;
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    const target = this.resolveSandboxPath(filePath);
    return await fs.readFile(target);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const target = this.resolveSandboxPath(filePath);
    const contentBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf-8');
    await this.assertDiskQuotaAvailable(contentBytes);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async uploadFile(localPath: string, sandboxPath: string): Promise<void> {
    const target = this.resolveSandboxPath(sandboxPath);
    const stat = await fs.stat(localPath);
    await this.assertDiskQuotaAvailable(stat.size);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(localPath, target);
  }

  async downloadFile(sandboxPath: string, localPath: string): Promise<void> {
    const source = this.resolveSandboxPath(sandboxPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(source, localPath);
  }

  async destroy(): Promise<void> {
    // Thoroughly kill all active child processes and their escaped descendants
    for (const child of this.activeProcesses) {
      if (child.pid !== undefined) {
        await this.cleanupProcessTree(child.pid);
      }
    }
    this.activeProcesses.clear();

    if (this.sandboxDir) {
      await fs.rm(this.sandboxDir, { recursive: true, force: true });
    }
  }
}
