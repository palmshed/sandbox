/**
 * Cross-language cancellation-semantics probe (F2 release gate).
 *
 * Runs the same six race scenarios as `sdk/go/cancellation_test.go`
 * against the reference TypeScript SDK and prints the observed behavior,
 * so the cross-check evidence is reproducible from the repository instead
 * of a scratch file.
 *
 * Normative expectation (rfcs/0009-go-sdk-bindings.md section 2.1): the
 * first terminal state observed by the guard wins, and a cancelled
 * execution is never overwritten by a later natural completion. This
 * probe only observes; it never changes an implementation. Known
 * deviation: rfcs/0010-reference-discrepancies.md discrepancy 001.
 *
 * Usage: node sdk/go/crosscheck/cancel-probe.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Sandbox } = require('@palmshed/sandbox');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];

async function scenario(name, fn) {
  const sb = await Sandbox.create({ backend: 'native', timeout: 20000 });
  try {
    out.push({ scenario: name, observed: await fn(sb) });
  } finally {
    await sb.destroy();
  }
}

// 1. cancel before natural completion
await scenario('cancel_before_completion', async (sb) => {
  const ex = await sb.exec('sleep 30');
  await sleep(200);
  await ex.cancel();
  const immediate = ex.status();
  await sleep(1500); // let the post-kill close event land
  return { immediate, afterSettle: ex.status() };
});

// 2. natural completion wins the race (establish the terminal state first)
await scenario('completion_wins', async (sb) => {
  const ex = await sb.exec('echo quick');
  await ex.wait();
  const atCompletion = ex.status();
  await ex.cancel();
  return { atCompletion, afterCancel: ex.status(), exit: ex.exitCode };
});

// 3. cancel after terminal completion leaves state unchanged
await scenario('cancel_after_terminal', async (sb) => {
  const ex = await sb.exec('exit 5');
  await ex.wait();
  const before = ex.status();
  await ex.cancel();
  return { before, after: ex.status(), exit: ex.exitCode };
});

// 4. repeated cancel is idempotent
await scenario('cancel_idempotent', async (sb) => {
  const ex = await sb.exec('sleep 30');
  await sleep(150);
  await ex.cancel();
  await ex.cancel();
  await ex.cancel();
  return { status: ex.status() };
});

// 5. repeated wait returns the same result
await scenario('wait_repeatable', async (sb) => {
  const ex = await sb.exec('echo stable');
  await ex.wait();
  const first = { status: ex.status(), exit: ex.exitCode, out: ex.stdout() };
  await ex.wait();
  await ex.wait();
  const second = { status: ex.status(), exit: ex.exitCode, out: ex.stdout() };
  return { identical: JSON.stringify(first) === JSON.stringify(second) };
});

// 6. post-kill closure must not overwrite an established cancelled state
await scenario('post_kill_no_overwrite', async (sb) => {
  const ex = await sb.exec('sleep 30');
  await sleep(200);
  await ex.cancel();
  const atCancel = ex.status();
  await sleep(2000);
  return { atCancel, afterKill: ex.status(), overwritten: ex.status() !== atCancel };
});

console.log(JSON.stringify(out, null, 1));
