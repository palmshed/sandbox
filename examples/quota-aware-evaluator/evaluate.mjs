/**
 * examples/quota-aware-evaluator/evaluate.mjs
 *
 * A real consumer integration example (not a test harness): a code
 * evaluation system that caps untrusted submissions at a CPU quota using
 * the published @palmshed/sandbox package. Install dependencies from the
 * npm registry first (`npm install`), then run (`npm start`).
 *
 * Shows:
 *   - Capability discovery (`cpuQuotaLimits`) before relying on a quota.
 *   - Per-submission sandboxes capped with `cpuQuota` (throttle, never kill).
 *   - Timeout handling: throttling stretches wall-clock time, so a wall
 *     `timeout` tuned for unthrottled execution can fire under quota on
 *     legitimate work. Wall timeout and CPU-time budget (`cpuTimeLimit`,
 *     which counts CPU time and is unaffected by throttling) are different
 *     controls; size timeouts with the quota in mind.
 *   - A per-execution quota override on a quota-less sandbox.
 *
 * Where the capability reports `false` the quota option is accepted but
 * ignored; the script reports which path each run took instead of warning.
 */

import { Sandbox } from '@palmshed/sandbox';

const QUOTA = 0.5;

const submissions = [
  {
    id: 'sub_001',
    label: 'Correct: fizzbuzz (light)',
    code: `
      for (let i = 1; i <= 15; i++) {
        if (i % 15 === 0) console.log('FizzBuzz');
        else if (i % 3 === 0) console.log('Fizz');
        else if (i % 5 === 0) console.log('Buzz');
        else console.log(i);
      }
    `,
    timeout: 8000,
  },
  {
    id: 'sub_002',
    label: 'CPU-heavy but legitimate: prime sieve',
    code: `
      function primes(n) {
        const sieve = new Array(n).fill(true);
        sieve[0] = sieve[1] = false;
        for (let i = 2; i * i < n; i++) {
          if (sieve[i]) for (let j = i * i; j < n; j += i) sieve[j] = false;
        }
        return sieve.filter(Boolean).length;
      }
      console.log('primes under 2M:', primes(2000000));
    `,
    timeout: 15000,
  },
  {
    id: 'sub_003',
    label: 'Abusive: infinite loop under quota',
    code: `while (true) {}`,
    timeout: 4000,
  },
  {
    id: 'sub_004',
    label: 'Runtime error under quota',
    code: `console.log(undefinedVar.property);`,
    timeout: 8000,
  },
];

async function evaluate(submission) {
  const sandbox = await Sandbox.create({
    backend: 'native',
    network: 'disabled',
    cpuQuota: QUOTA,
  });
  const enforced = sandbox.capabilities.cpuQuotaLimits === true;

  await sandbox.writeFile('solution.js', submission.code);
  const start = Date.now();
  const execution = await sandbox.exec('node solution.js', { timeout: submission.timeout });
  let waitError = null;
  try {
    await execution.wait();
  } catch (err) {
    waitError = err;
  }
  const wall = Date.now() - start;
  await sandbox.destroy();

  return {
    id: submission.id,
    label: submission.label,
    enforced,
    status: execution.status(),
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    waitError: waitError ? `${waitError.name}: ${waitError.code ?? waitError.message}` : null,
    stdout: execution.stdout().trim().split('\n').at(-1) ?? '',
    wall,
  };
}

async function main() {
  console.log(`Quota-aware evaluation (cpuQuota: ${QUOTA}, quota enforced only where reported)\n`);

  for (const sub of submissions) {
    const r = await evaluate(sub);
    const verdict = r.status === 'completed' ? 'PASS'
                  : r.timedOut              ? 'TIMEOUT'
                  :                           'FAIL';
    console.log(`${verdict}  [${r.id}] ${r.label} (quota ${r.enforced ? 'enforced' : 'not enforced here'}, ${r.wall}ms)`);
    if (r.waitError) console.log(`       wait() threw: ${r.waitError}`);
    if (r.stdout) console.log(`       output: ${r.stdout.slice(0, 80)}`);
  }

  // Per-execution override on a quota-less sandbox: this one execution is
  // capped while the sandbox default stays unlimited.
  const sandbox = await Sandbox.create({ backend: 'native', network: 'disabled' });
  const execution = await sandbox.exec('node -e "console.log(1 + 1)"', { cpuQuota: QUOTA });
  await execution.wait();
  console.log(`\nOverride-only exec: ${execution.status()} (quota ${sandbox.capabilities.cpuQuotaLimits === true ? 'enforced' : 'not enforced here'})`);
  await sandbox.destroy();
}

main().catch((err) => {
  console.error('Evaluator error:', err);
  process.exit(1);
});
