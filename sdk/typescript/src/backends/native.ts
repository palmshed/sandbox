import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BackendEngine } from './interface.js';
import { ExecOptions, ExecResult, SandboxError, SandboxOptions, SandboxResourceError } from '../core/types.js';
import { logDebug } from '../core/log.js';
import {
  installCrashHooks,
  uninstallCrashHooks,
  registerSandbox,
  unregisterSandbox,
  recordSandboxPgid,
  reapStaleSandboxes,
  readHostStartToken,
  cleanupSandboxSync,
} from '../core/crashRecovery.js';

/**
 * Read the current Windows process table via PowerShell CIM (the replacement
 * for the removed WMIC utility). Returns a map of pid -> { ppid, value }
 * where `value` is either WorkingSetSize (memory, bytes) or the summed
 * KernelModeTime + UserModeTime (CPU, 100ns units), depending on `fields`.
 * Returns null if the snapshot cannot be obtained.
 */
function readWindowsProcessTable(
  fields: string,
  isCpu: boolean
): Map<number, { ppid: number; value: number }> | null {
  const procs = new Map<number, { ppid: number; value: number }>();
  const script = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,${fields} | ConvertTo-Json -Compress`;
  let out: string;
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(out.trim());
  } catch {
    return null;
  }
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows as Record<string, unknown>[]) {
    if (!row || typeof row !== 'object') continue;
    const pid = parseInt(String(row.ProcessId), 10);
    const ppid = parseInt(String(row.ParentProcessId), 10);
    if (isNaN(pid)) continue;
    const value = isCpu
      ? (parseInt(String(row.KernelModeTime), 10) || 0) + (parseInt(String(row.UserModeTime), 10) || 0)
      : parseInt(String(row.WorkingSetSize), 10) || 0;
    procs.set(pid, { ppid: isNaN(ppid) ? 0 : ppid, value });
  }
  return procs;
}

export class NativeBackend implements BackendEngine {
  public readonly name = 'native';
  public readonly capabilities = {
    filesystem: true,
    networkIsolation: true,  // Probed at init: true if unshare --user works (macOS: sandbox-exec always available); false on Linux CI where user namespaces are restricted, and false on Windows (unsupported)
    cpuLimits: true,
    memoryLimits: true,
    streaming: true,
    remoteExecution: false,
  };
  private sandboxDir: string = '';
  /** realpath of sandboxDir, used as the containment base for VFS resolution */
  private sandboxRealDir: string = '';
  private options!: SandboxOptions;
  /** Active child processes, killed on destroy() */
  private activeProcesses = new Set<ChildProcess>();
  /** Whether Linux unshare --user network namespace creation succeeded at init */
  private networkIsolationAvailable = true;
  /** Crash-recovery exit/signal cleanup bound to this instance (RFC 0005) */
  private crashCleanup: (() => void) | null = null;

  /**
   * Environment contract: executions do NOT inherit the host environment
   * wholesale. Only this minimal allowlist is carried from the host (needed to
   * run node/npm/shells); everything else is dropped so host secrets do not
   * leak into untrusted workloads. Explicit `env` values (sandbox-level and
   * per-execution) override the allowlist.
   */
  private static readonly envAllowlist: string[] =
    process.platform === 'win32'
      ? ['PATH', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE']
      : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE'];

  private static buildExecutionEnv(sandboxEnv: Record<string, string> | undefined, execEnv: Record<string, string> | undefined): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of NativeBackend.envAllowlist) {
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    }
    if (sandboxEnv) Object.assign(env, sandboxEnv);
    if (execEnv) Object.assign(env, execEnv);
    return env;
  }

  async init(options: SandboxOptions): Promise<void> {
    this.options = options;
    // Create an isolated temporary working directory for native execution
    const tmpPrefix = path.join(os.tmpdir(), 'palmshed-sandbox-');
    this.sandboxDir = await fs.mkdtemp(tmpPrefix);
    this.sandboxRealDir = await fs.realpath(this.sandboxDir);

    // Crash recovery (RFC 0005): register this sandbox so a reaper in a later
    // host process can clean it up if this host dies, and reap any sandboxes
    // whose recorded host has crashed since the last sweep.
    const hostStart = readHostStartToken(process.pid) ?? '';
    await registerSandbox(this.sandboxDir, hostStart);
    await reapStaleSandboxes(this.sandboxDir);
    if (!this.crashCleanup) {
      this.crashCleanup = () => this.cleanupSync();
      installCrashHooks(this.crashCleanup);
    }

    if (options.workDir) {
      await this.resolveWorkDir(options.workDir);
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
    } else if (process.platform === 'win32') {
      // Windows has no native network isolation (RFC 0004 documents it as
      // unsupported). Report the capability as unavailable so consumers and
      // the repro suite skip network assertions instead of failing them.
      this.networkIsolationAvailable = false;
      this.capabilities.networkIsolation = false;
    }

    logDebug('backend.init', {
      backend: this.name,
      networkIsolation: this.capabilities.networkIsolation,
      timeout: options.timeout ?? null,
      memory: options.memory ?? null,
      cpuTimeLimit: options.cpuTimeLimit ?? null,
      diskQuota: options.diskQuota ?? null,
    });
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? this.options.timeout ?? 0;
    const cwd = options.workDir
      ? await this.resolveWorkDir(options.workDir)
      : this.sandboxRealDir;

    const env = NativeBackend.buildExecutionEnv(this.options.env, options.env);

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

    // Parse disk quota (bytes) and snapshot the workspace so files created by
    // an over-quota execution can be rolled back on failure, keeping the
    // sandbox reusable (recoverable: true) despite having no delete API.
    const diskQuotaBytes = this.getDiskQuotaBytes();
    let preExecFiles: Set<string> | null = null;
    if (diskQuotaBytes !== null) {
      preExecFiles = await this.listWorkspaceFiles();
    }

    return new Promise((resolve, reject) => {
      let stdoutAcc = '';
      let stderrAcc = '';
      let timedOut = false;
      let oomKilled = false;
      let cpuExceeded = false;
      let diskExceeded = false;
      let timer: NodeJS.Timeout | null = null;
      let memPoller: NodeJS.Timeout | null = null;
      let cpuPoller: NodeJS.Timeout | null = null;
      let diskPoller: NodeJS.Timeout | null = null;
      let measuringDisk = false;
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
          // Windows: PowerShell CIM process-tree walk from the root PID (WMIC
          // is removed from Windows 11 24H2+/Server 2025). Polling based rather
          // than Job Object accounting, so a child that detaches from the tree
          // can escape accounting. Documented platform limitation.
          const procs = readWindowsProcessTable('WorkingSetSize', false);
          if (!procs) return -1;
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
            total += p.value;
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
          // Windows: PowerShell CIM process-tree walk of KernelModeTime +
          // UserModeTime (100-nanosecond units => /10000 = ms). WMIC is removed
          // from Windows 11 24H2+/Server 2025.
          const procs = readWindowsProcessTable('KernelModeTime,UserModeTime', true);
          if (!procs) return -1;
          let total = 0;
          const visited = new Set<number>();
          const queue = [rootPid];
          while (queue.length) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);
            const p = procs.get(current);
            if (!p) continue;
            total += p.value;
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
        // On Windows, pass arguments verbatim so cmd.exe sees '/s /c <command>'
        // as separate tokens. Without this, Node quotes the space-containing
        // '/s /c' argument, cmd.exe fails to parse the /c switch, and every
        // command exits 1.
        windowsVerbatimArguments: isWin,
      });

      this.activeProcesses.add(child);
      if (child.pid !== undefined) {
        recordSandboxPgid(this.sandboxDir, child.pid);
      }
      logDebug('exec.start', {
        backend: this.name,
        pid: child.pid ?? null,
        timeout: timeout || null,
        cpuTimeLimit: cpuTimeLimitMs ?? null,
        memory: memLimitBytes ?? null,
        network: this.options.network ?? 'allow',
      });

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

      // Disk-quota enforcement during execution (250ms interval). Workspace
      // usage is polled while the workload runs, so processes that write
      // directly (dd, fallocate, shell redirections) cannot bypass the quota
      // configured on the sandbox. On exceed, the process group is killed and
      // the execution rejects with ERR_DISK_QUOTA_EXCEEDED.
      if (diskQuotaBytes !== null && child.pid !== undefined) {
        diskPoller = setInterval(() => {
          if (settled || measuringDisk) return;
          measuringDisk = true;
          this.getDirectorySize(this.sandboxRealDir)
            .then((size) => {
              if (!settled && size > diskQuotaBytes) {
                diskExceeded = true;
                clearInterval(diskPoller!);
                killProcess('SIGKILL');
              }
            })
            .catch(() => {}) // workspace may be mid-removal on destroy
            .finally(() => {
              measuringDisk = false;
            });
        }, 250);
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

      child.on('close', async (code, signal) => {
        settled = true;
        this.activeProcesses.delete(child);
        if (timer) clearTimeout(timer);
        if (memPoller) clearInterval(memPoller);
        if (cpuPoller) clearInterval(cpuPoller);
        if (diskPoller) clearInterval(diskPoller);
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

        // Final workspace size check: a fast workload can write past the quota
        // and exit before the 250ms poller observes it, so the size is
        // re-measured after the process group is gone.
        if (!diskExceeded && diskQuotaBytes !== null) {
          try {
            const finalSize = await this.getDirectorySize(this.sandboxRealDir);
            if (finalSize > diskQuotaBytes) diskExceeded = true;
          } catch {
            // workspace may be mid-removal on destroy
          }
        }

        // A process that died from a signal (crash like SIGABRT/SIGSEGV, or
        // an external kill) reports `code === null`. Surface a conventional
        // non-zero exit code (128 + signal number) so a signal death is never
        // mistaken for a successful exit.
        const terminatedBySignal = code === null && signal !== null;
        const exitCode =
          timedOut || oomKilled || cpuExceeded || diskExceeded
            ? -1
            : terminatedBySignal
              ? 128 + (os.constants.signals[signal as keyof typeof os.constants.signals] ?? 0)
              : (code ?? 0);

        if (oomKilled && memLimitBytes !== null) {
          // Capture final RSS best-effort (process is gone, use limit as observed)
          logDebug('resource.enforced', {
            backend: this.name,
            resource: 'memory',
            limit: rawMemoryLimit,
            recoverable: true,
          });
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
          logDebug('resource.enforced', {
            backend: this.name,
            resource: 'cpu',
            limit: rawCpuTimeLimit,
            recoverable: true,
          });
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

        if (diskExceeded && diskQuotaBytes !== null) {
          // Roll back files created during this execution so the workspace
          // returns under quota and the sandbox stays reusable.
          await this.rollbackWorkspace(preExecFiles);
          logDebug('resource.enforced', {
            backend: this.name,
            resource: 'disk',
            limit: this.options.diskQuota,
            recoverable: true,
          });
          reject(new SandboxResourceError(
            `Disk quota exceeded: sandbox workspace usage exceeded limit of ${this.options.diskQuota}`,
            'ERR_DISK_QUOTA_EXCEEDED',
            {
              resource: 'disk',
              limit: this.options.diskQuota!,
              observed: `>${this.options.diskQuota}`,
              recoverable: true,
            }
          ));
          return;
        }

        const metadata = {
          id: execId,
          backend: this.name,
          specVersion: '1.0.0',
          startedAt: new Date(startTime).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs,
          exitCode,
          timedOut,
          signal: terminatedBySignal ? signal : undefined,
          cpuTimeMs: finalCpuTimeMs,
        };

        logDebug('exec.end', {
          backend: this.name,
          exitCode,
          durationMs,
          timedOut,
          cpuTimeMs: finalCpuTimeMs ?? null,
        });

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

  /**
   * Resolve a VFS path to an absolute path inside the sandbox workspace,
   * enforcing containment:
   *  1. Lexical check: `path.relative` from the workspace root must not escape
   *     it (rejects `..` traversal, absolute host paths, and cross-drive paths).
   *  2. Symlink check: the deepest existing ancestor is `realpath`-resolved and
   *     must also lie under the (realpath of the) workspace root. This prevents
   *     a workload-planted symlink from redirecting VFS operations outside the
   *     sandbox. Nonexistent suffix components are appended back unchanged.
   * Returns the realpath-normalized absolute path. Throws FS_ERROR on escape.
   */
  private async resolveSandboxPath(targetPath: string): Promise<string> {
    const resolved = path.resolve(this.sandboxDir, targetPath);
    const rel = path.relative(this.sandboxDir, resolved);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new SandboxError('Path traversal attempt outside sandbox root', 'FS_ERROR');
    }

    let current = resolved;
    const suffix: string[] = [];
    for (;;) {
      let real: string;
      try {
        real = await fs.realpath(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const parent = path.dirname(current);
        if (parent === current) {
          throw new SandboxError(`Path outside sandbox root: ${targetPath}`, 'FS_ERROR');
        }
        suffix.unshift(path.basename(current));
        current = parent;
        continue;
      }
      const realRel = path.relative(this.sandboxRealDir, path.join(real, ...suffix));
      if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
        throw new SandboxError('Symlink escape outside sandbox root', 'FS_ERROR');
      }
      return path.join(real, ...suffix);
    }
  }

  /** Resolve an exec workDir inside the workspace, creating it if absent. */
  private async resolveWorkDir(workDir: string): Promise<string> {
    const target = await this.resolveSandboxPath(workDir);
    await fs.mkdir(target, { recursive: true });
    return target;
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

  /** List regular files in the workspace as paths relative to the sandbox root. */
  private async listWorkspaceFiles(
    dirPath: string = this.sandboxRealDir,
    base: string = ''
  ): Promise<Set<string>> {
    const files = new Set<string>();
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      const rel = base ? path.join(base, entry.name) : entry.name;
      if (entry.isDirectory()) {
        const sub = await this.listWorkspaceFiles(path.join(dirPath, entry.name), rel);
        for (const f of sub) files.add(f);
      } else if (entry.isFile()) {
        files.add(rel);
      }
    }
    return files;
  }

  /** Remove workspace files that were not present at the start of an execution. */
  private async rollbackWorkspace(preExecFiles: Set<string> | null): Promise<void> {
    if (!preExecFiles) return;
    const current = await this.listWorkspaceFiles();
    for (const rel of current) {
      if (!preExecFiles.has(rel)) {
        try {
          await fs.unlink(path.join(this.sandboxRealDir, rel));
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  /** Parsed disk quota in bytes, or null when no diskQuota is configured. */
  private getDiskQuotaBytes(): number | null {
    if (this.options?.diskQuota === undefined) return null;
    return typeof this.options.diskQuota === 'number'
      ? this.options.diskQuota
      : this.parseSizeStringToBytes(this.options.diskQuota);
  }

  private async assertDiskQuotaAvailable(additionalBytes: number): Promise<void> {
    const quotaBytes = this.getDiskQuotaBytes();
    if (quotaBytes === null) return;

    const currentSize = await this.getDirectorySize(this.sandboxRealDir);
    if (currentSize + additionalBytes > quotaBytes) {
      // SandboxResourceError is a direct import at the top of this file
      throw new SandboxResourceError(
        `Disk quota exceeded: current usage ${currentSize + additionalBytes} bytes exceeds limit of ${quotaBytes} bytes`,
        'ERR_DISK_QUOTA_EXCEEDED',
        {
          resource: 'disk',
          limit: quotaBytes,
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

    if (process.platform === 'win32') {
      // Windows has no process groups. taskkill /T /F removes the whole tree
      // rooted at rootPid. Without this, the root process survives destroy()
      // and any piped stdio keeps the parent alive forever.
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${rootPid} /T /F`, { stdio: 'ignore' });
      } catch {
        // process may have already exited
      }
      return;
    }

    try {
      process.kill(-rootPid, 'SIGKILL');
    } catch {
      // process group may already be gone
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
    const target = await this.resolveSandboxPath(filePath);
    return await fs.readFile(target);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const target = await this.resolveSandboxPath(filePath);
    const contentBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf-8');
    await this.assertDiskQuotaAvailable(contentBytes);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async uploadFile(localPath: string, sandboxPath: string): Promise<void> {
    const target = await this.resolveSandboxPath(sandboxPath);
    const stat = await fs.stat(localPath);
    await this.assertDiskQuotaAvailable(stat.size);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(localPath, target);
  }

  async downloadFile(sandboxPath: string, localPath: string): Promise<void> {
    const source = await this.resolveSandboxPath(sandboxPath);
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
    await unregisterSandbox(this.sandboxDir);
    if (this.crashCleanup) {
      uninstallCrashHooks(this.crashCleanup);
      this.crashCleanup = null;
    }
    logDebug('backend.destroy', { backend: this.name });
  }

  /**
   * Synchronous cleanup used by the crash-recovery exit/signal hooks (RFC
   * 0005). Must not await; safe to run inside process 'exit' handlers.
   */
  private cleanupSync(): void {
    for (const child of this.activeProcesses) {
      if (child.pid !== undefined) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          // process may have already exited
        }
      }
    }
    this.activeProcesses.clear();
    cleanupSandboxSync(this.sandboxDir, []);
  }
}
