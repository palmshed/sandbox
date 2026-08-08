/**
 * Debug logging controlled by the `SANDBOX_LOG=debug` environment variable.
 *
 * Off by default; enabled only when `process.env.SANDBOX_LOG === 'debug'`.
 * Emits lifecycle and resource-enforcement events to **stderr** so debug
 * output can never corrupt captured stdout.
 *
 * Privacy contract: only identifiers (execution/container ids, backend names)
 * and resource configuration are logged. Secrets, environment values, command
 * contents, and filesystem contents are NEVER logged.
 */

export function logDebug(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {}
): void {
  if (typeof process === 'undefined' || process.env.SANDBOX_LOG !== 'debug') return;
  const kv = Object.entries(fields)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  process.stderr.write(`[sandbox:debug] ${event}${kv ? ` ${kv}` : ''}\n`);
}
