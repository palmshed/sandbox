/**
 * examples/code-evaluator.js
 *
 * Simulates a code evaluation system: takes multiple submissions,
 * runs each in a fresh sandbox, collects pass/fail results.
 *
 * Validates:
 *   - Multiple independent executions
 *   - Failed programs (non-zero exit)
 *   - Infinite loop timeout enforcement
 *   - stderr capture
 *   - Result collection
 */

import { Sandbox } from '../sdk/typescript/dist/index.js';

const submissions = [
  {
    id: 'sub_001',
    label: 'Correct: fizzbuzz',
    code: `
      for (let i = 1; i <= 15; i++) {
        if (i % 15 === 0) console.log('FizzBuzz');
        else if (i % 3 === 0) console.log('Fizz');
        else if (i % 5 === 0) console.log('Buzz');
        else console.log(i);
      }
    `,
    timeout: 2000,
  },
  {
    id: 'sub_002',
    label: 'Runtime error: undefined variable',
    code: `console.log(undefinedVar.property);`,
    timeout: 2000,
  },
  {
    id: 'sub_003',
    label: 'Infinite loop: should time out',
    code: `while(true) {}`,
    timeout: 300,
  },
  {
    id: 'sub_004',
    label: 'Correct: fibonacci',
    code: `
      function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }
      console.log(fib(10));
    `,
    timeout: 2000,
  },
];

async function evaluate(submission) {
  const sandbox = await Sandbox.create({ backend: 'native', network: 'disabled' });

  await sandbox.writeFile('solution.js', submission.code);
  const execution = await sandbox.exec('node solution.js', { timeout: submission.timeout });
  await execution.wait();

  await sandbox.destroy();

  return {
    id:       submission.id,
    label:    submission.label,
    status:   execution.status(),
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    stdout:   execution.stdout().trim(),
    stderr:   execution.stderr().trim(),
    duration: execution.durationMs,
  };
}

async function main() {
  console.log('Running code evaluation suite...\n');
  const results = [];

  for (const sub of submissions) {
    const result = await evaluate(sub);
    results.push(result);
    const verdict = result.status === 'completed' ? '✓ PASS'
                  : result.timedOut              ? '✗ TIMEOUT'
                  :                                '✗ FAIL';
    console.log(`${verdict}  [${result.id}] ${result.label}`);
    if (result.stderr) console.log(`       stderr: ${result.stderr.split('\n')[0]}`);
  }

  const passed  = results.filter(r => r.status === 'completed').length;
  const failed  = results.filter(r => r.status === 'failed').length;
  const timeout = results.filter(r => r.timedOut).length;

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${timeout} timed out`);
}

main().catch((err) => {
  console.error('Evaluator error:', err);
  process.exit(1);
});
