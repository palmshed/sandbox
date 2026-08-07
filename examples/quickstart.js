import { Sandbox } from '@palmshed/sandbox';

async function run() {
  const sandbox = await Sandbox.create({
    cpu: 1,
    memory: '256MB',
    timeout: 10000,
    network: 'disabled',
    backend: 'native',
  });

  console.log('Sandbox initialized with backend:', sandbox.backendName);

  // Exec command
  const res = await sandbox.exec('node -v');
  console.log('Node version in sandbox:', res.stdout.trim());

  // Write and execute file
  await sandbox.writeFile('main.js', 'console.log("Hello from Palmshed Sandbox!");');
  const runRes = await sandbox.exec('node main.js');
  console.log('Execution result:', runRes.stdout.trim());

  await sandbox.destroy();
  console.log('Sandbox destroyed cleanly.');
}

run().catch(console.error);
