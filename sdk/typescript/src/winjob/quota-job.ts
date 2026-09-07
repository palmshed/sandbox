import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';

/**
 * Windows Job Object CPU hard quota (RFC 0007, win32 only).
 *
 * Mechanism: one Job Object per sandbox with ENABLE | HARD_CAP rate control.
 * Children of job members join automatically (Node never passes breakaway),
 * so assigning the spawned root confines the whole tree. A per-sandbox
 * persistent PowerShell helper (embedded below, C# P/Invoke, ASCII JSON-line
 * protocol) owns the job handles: spawning powershell per operation would
 * recompile the C# every time. No native dependencies; works wherever
 * powershell.exe exists (5.1 and 7 both run the Add-Type below).
 *
 * Documented residuals: assignment lands tens of milliseconds after spawn
 * (helper round trip), so sub-50ms forkers may partially escape before the
 * root joins; per-exec overrides serialize on a mutex like every other
 * backend dance. Never kills: throttling only.
 */

// Numeric constants below mirror the verified Win32 values (JobObjectCpu-
// RateControlInformation = 15, confirmed against MSDN tables and phnt
// headers; ENABLE|HARD_CAP = 0x1|0x4; OpenProcess rights SET_QUOTA|
// TERMINATE = 0x101). They appear as literals in the embedded script so the
// C# stays self-contained.

/** Host CPU count, guarded (rate math divides by it). */
export function hostCpuCores(): number {
  return Math.max(1, os.cpus().length);
}

/**
 * Convert a core quota to a job CpuRate (percent of total system CPU times
 * 100, e.g. 20 percent becomes 2000). Clamped to 1..10000: 0 is rejected by
 * the API, and anything above full-system capacity can never bind (Q6
 * pass-through effect). Pure math, platform independent, unit tested.
 */
export function quotaCoresToRate(quotaCores: number, hostCores: number): number {
  const safeHost = hostCores > 0 ? hostCores : 1;
  return Math.min(10000, Math.max(1, Math.round((quotaCores / safeHost) * 10000)));
}

// NOTE to editors: the script below is plain single-quoted strings joined by
// newlines (no template literal, so no ${ hazard); PowerShell $variables are
// fine, and the C# avoids interpolated strings. Double-quoted PowerShell
// lines interpolate $req fields at runtime, which is intended.
function buildHelperScript(): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class QJob {',
    '  [StructLayout(LayoutKind.Explicit)]',
    '  public struct RateInfo {',
    '    [FieldOffset(0)] public uint ControlFlags;',
    '    [FieldOffset(4)] public uint CpuRate;',
    '  }',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern IntPtr CreateJobObject(IntPtr a, string n);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern bool SetInformationJobObject(IntPtr h, int c, ref RateInfo i, uint l);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern bool QueryInformationJobObject(IntPtr h, int c, out RateInfo o, uint l, IntPtr r);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern bool AssignProcessToJobObject(IntPtr h, IntPtr p);',
    '  [DllImport("kernel32.dll")]',
    '  public static extern IntPtr OpenProcess(uint a, bool i, uint p);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern bool CloseHandle(IntPtr h);',
    '  public const int CpuRateClass = 15;',
    '  public const uint EnableHardCap = 5;',
    '}',
    '"@',
    '$jobs = @{}',
    ':outer while (($line = [Console]::In.ReadLine()) -ne $null) {',
    '  $res = @{ ok = $false }',
    '  try {',
    '    $req = $line | ConvertFrom-Json',
    '    switch ($req.cmd) {',
    "      'ping' { $res.ok = $true }",
    "      'create' {",
    '        $h = [QJob]::CreateJobObject([IntPtr]::Zero, $null)',
    "        if ($h -eq [IntPtr]::Zero) { $res.error = 'CreateJobObject failed' }",
    '        else { $jobs[$req.job] = $h; $res.ok = $true }',
    '      }',
    "      'set' {",
    "        if (-not $jobs.ContainsKey($req.job)) { $res.error = 'unknown job' }",
    '        else {',
    "          $info = New-Object 'QJob+RateInfo'",
    '          $info.ControlFlags = 5',
    '          $info.CpuRate = [uint32]$req.rate',
    '          if ([QJob]::SetInformationJobObject($jobs[$req.job], 15, [ref]$info, 8)) { $res.ok = $true }',
    "          else { $res.error = 'SetInformationJobObject failed' }",
    '        }',
    '      }',
    "      'assign' {",
    "        if (-not $jobs.ContainsKey($req.job)) { $res.error = 'unknown job' }",
    '        else {',
    '          $ph = [QJob]::OpenProcess(257, $false, [uint32]$req.targetPid)',
    "          if ($ph -eq [IntPtr]::Zero) { $res.error = 'OpenProcess failed (exited?)' }",
    '          else {',
    '            try {',
    '              if ([QJob]::AssignProcessToJobObject($jobs[$req.job], $ph)) { $res.ok = $true }',
    "              else { $res.error = 'AssignProcessToJobObject failed (already in a job?)' }",
    '            } finally { [QJob]::CloseHandle($ph) | Out-Null }',
    '          }',
    '        }',
    '      }',
    "      'query' {",
    "        if (-not $jobs.ContainsKey($req.job)) { $res.error = 'unknown job' }",
    '        else {',
    "          $info = New-Object 'QJob+RateInfo'",
    '          if ([QJob]::QueryInformationJobObject($jobs[$req.job], 15, [ref]$info, 8, [IntPtr]::Zero)) { $res.ok = $true; $res.rate = $info.CpuRate }',
    "          else { $res.error = 'QueryInformationJobObject failed' }",
    '        }',
    '      }',
    "      'close' {",
    '        if ($jobs.ContainsKey($req.job)) { [QJob]::CloseHandle($jobs[$req.job]) | Out-Null; $jobs.Remove($req.job) }',
    '        $res.ok = $true',
    '      }',
    "      'exit' { $res.ok = $true; $res | ConvertTo-Json -Compress; break outer }",
    "      default { $res.error = 'unknown cmd' }",
    '    }',
    '  } catch {',
    '    $res = @{ ok = $false; error = $_.Exception.Message }',
    '  }',
    '  $res | ConvertTo-Json -Compress',
    '}',
    'foreach ($h in $jobs.Values) { [QJob]::CloseHandle($h) | Out-Null }',
  ].join('\n');
}

export interface QuotaJobRequest {
  cmd: 'ping' | 'create' | 'set' | 'assign' | 'query' | 'close' | 'exit';
  job?: string;
  rate?: number;
  targetPid?: number;
}

export interface QuotaJobResponse {
  ok: boolean;
  rate?: number;
  error?: string;
}

/**
 * Per-sandbox persistent helper: one powershell process (C# compiled once),
 * ASCII JSON lines over stdin/stdout, strictly serial requests. A request
 * timeout kills the helper and fails everything after it honestly instead of
 * risking desynchronized framing. No-op on non-Windows hosts (never started
 * there; callers gate on platform first).
 */
export class QuotaJobHelper {
  private child: ChildProcess | null = null;
  private buf = '';
  private tail: Promise<void> = Promise.resolve();
  private resolvers: Array<(r: QuotaJobResponse) => void> = [];
  private dead = false;

  /** Spawn powershell and handshake (ping). Throws when unusable. */
  async start(timeoutMs = 60000): Promise<void> {
    if (this.child !== null) return;
    const encoded = Buffer.from(buildHelperScript(), 'utf16le').toString('base64');
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    const onDead = () => this.markDead('helper process ended');
    child.on('error', onDead);
    child.on('exit', onDead);
    // Handshake proves the pipe, the C# compile, and the protocol at once.
    const res = await this.request({ cmd: 'ping' }, timeoutMs);
    if (!res.ok) {
      await this.stop();
      throw new Error(`quota helper handshake failed: ${res.error ?? 'no response'}`);
    }
  }

  /** Serialized request; rejects on timeout (helper is then dead). */
  request(req: QuotaJobRequest, timeoutMs = 30000): Promise<QuotaJobResponse> {
    const run = this.tail.then(
      () =>
        new Promise<QuotaJobResponse>((resolve) => {
          const child = this.child;
          if (this.dead || child === null || child.stdin === null) {
            resolve({ ok: false, error: 'helper not running' });
            return;
          }
          const stdin = child.stdin;
          const timer = setTimeout(() => {
            this.markDead('request timeout');
            resolve({ ok: false, error: 'request timeout' });
          }, timeoutMs);
          this.resolvers.push((res) => {
            clearTimeout(timer);
            resolve(res);
          });
          stdin.write(JSON.stringify(req) + '\n', (err) => {
            if (err) {
              clearTimeout(timer);
              this.markDead(`stdin write failed: ${err.message}`);
              resolve({ ok: false, error: 'stdin write failed' });
            }
          });
        })
    );
    // The chain itself never rejects (outcomes travel inside responses), so
    // later requests are unaffected by earlier failures.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Ask the helper to exit, then kill it; best effort, never throws. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.markDead('stopped');
    if (child === null) return;
    const alreadyGone = child.exitCode !== null || child.signalCode !== null;
    if (!alreadyGone) {
      try {
        child.stdin?.write(JSON.stringify({ cmd: 'exit' }) + '\n');
      } catch {
        // pipe already gone
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf-8');
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      const resolve = this.resolvers.shift();
      if (!resolve) continue;
      try {
        const res = JSON.parse(line) as QuotaJobResponse;
        resolve(typeof res.ok === 'boolean' ? res : { ok: false, error: 'malformed response' });
      } catch {
        resolve({ ok: false, error: 'malformed response' });
      }
    }
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    const resolvers = this.resolvers;
    this.resolvers = [];
    for (const resolve of resolvers) {
      resolve({ ok: false, error: reason });
    }
  }
}

/**
 * Full live proof that job rate control works on this host: helper plus a
 * real assign of a throwaway sleep plus a rate readback. Used once per
 * process and cached by the caller. Never throws: false means unavailable.
 */
export async function probeQuotaJobSupport(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const helper = new QuotaJobHelper();
  let sleeper: ChildProcess | null = null;
  try {
    await helper.start();
    const created = await helper.request({ cmd: 'create', job: 'probe' });
    if (!created.ok) return false;
    try {
      const set = await helper.request({ cmd: 'set', job: 'probe', rate: 5000 });
      if (!set.ok) return false;
      sleeper = spawn('ping', ['-n', '6', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
      if (sleeper.pid === undefined) return false;
      const assigned = await helper.request({ cmd: 'assign', job: 'probe', targetPid: sleeper.pid });
      if (!assigned.ok) return false;
      const queried = await helper.request({ cmd: 'query', job: 'probe' });
      return queried.ok === true && queried.rate === 5000;
    } finally {
      await helper.request({ cmd: 'close', job: 'probe' });
    }
  } catch {
    return false;
  } finally {
    if (sleeper !== null) {
      try {
        sleeper.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    await helper.stop();
  }
}
