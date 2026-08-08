/**
 * examples/ai-agent-runner.mjs
 *
 * Simulates an AI agent that receives a user request, generates code,
 * executes it inside a sandbox, and streams output back.
 *
 * Validates:
 *   - Sandbox creation with restricted network
 *   - File write + execution flow
 *   - Real-time stdout streaming
 *   - Timeout enforcement
 *   - Sandbox cleanup
 */

import { Sandbox } from '@palmshed/sandbox';

// Simulated agent-generated code snippets (untrusted input)
const agentTasks = [
  {
    description: 'Sum an array of numbers',
    code: `
      const nums = [1, 2, 3, 4, 5];
      const sum = nums.reduce((a, b) => a + b, 0);
      console.log(JSON.stringify({ result: sum, ok: true }));
    `,
    timeout: 3000,
  },
  {
    description: 'Attempt an infinite loop (should time out)',
    code: `while (true) {}`,
    timeout: 300,
  },
  {
    description: 'Write and read a file',
    code: `
      const fs = require('fs');
      fs.writeFileSync('output.txt', 'agent result');
      console.log(fs.readFileSync('output.txt', 'utf8'));
    `,
    timeout: 3000,
  },
];

async function runAgentTask(sandbox, task) {
  console.log(`\n--- Task: ${task.description} ---`);

  await sandbox.writeFile('task.js', task.code);

  const execution = await sandbox.exec('node task.js', { timeout: task.timeout });

  const chunks = [];
  execution.on('stdout', (chunk) => chunks.push(chunk));

  await execution.wait();

  console.log('Status:   ', execution.status());
  console.log('Exit code:', execution.exitCode);
  console.log('Timed out:', execution.timedOut);
  console.log('Duration: ', execution.durationMs, 'ms');
  if (chunks.length > 0) {
    console.log('Output:   ', chunks.join('').trim());
  }
}

async function main() {
  const sandbox = await Sandbox.create({
    backend: 'native',
    network: 'disabled',
    timeout: 5000,
  });

  console.log('Backend:      ', sandbox.backendName);
  console.log('Capabilities: ', sandbox.capabilities);

  for (const task of agentTasks) {
    await runAgentTask(sandbox, task);
  }

  await sandbox.destroy();
  console.log('\nSandbox destroyed cleanly.');
}

main().catch((err) => {
  console.error('Agent runner error:', err);
  process.exit(1);
});
