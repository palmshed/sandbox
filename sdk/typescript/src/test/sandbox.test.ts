import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { Sandbox } from '../index.js';

test('Native Backend Sandbox Execution', async (t) => {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 5000 });

  t.after(async () => {
    await sandbox.destroy();
  });

  await t.test('executes echo command', async () => {
    const res = await sandbox.exec('echo "Hello Palmshed Sandbox"');
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /Hello Palmshed Sandbox/);
  });

  await t.test('streams stdout output', async () => {
    let captured = '';
    const res = await sandbox.exec('echo "Stream Chunk"', {
      onStdout: (data: string) => {
        captured += data;
      },
    });
    assert.equal(res.exitCode, 0);
    assert.match(captured, /Stream Chunk/);
  });

  await t.test('handles command timeout', async () => {
    const res = await sandbox.exec('node -e "setTimeout(() => {}, 10000)"', {
      timeout: 200,
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.exitCode, -1);
  });

  await t.test('filesystem write, read, upload, download', async () => {
    await sandbox.writeFile('hello.txt', 'Virtual filesystem works!');
    const buf = await sandbox.readFile('hello.txt');
    assert.equal(buf.toString(), 'Virtual filesystem works!');

    // Test upload & download
    const tmpLocalSrc = path.join(os.tmpdir(), `test-upload-${Date.now()}.txt`);
    const tmpLocalDst = path.join(os.tmpdir(), `test-download-${Date.now()}.txt`);

    await fs.writeFile(tmpLocalSrc, 'Host to Sandbox file payload');
    await sandbox.uploadFile(tmpLocalSrc, 'uploaded/target.txt');

    await sandbox.downloadFile('uploaded/target.txt', tmpLocalDst);
    const downloadedContent = await fs.readFile(tmpLocalDst, 'utf-8');

    assert.equal(downloadedContent, 'Host to Sandbox file payload');

    // Cleanup host temp files
    await fs.rm(tmpLocalSrc, { force: true });
    await fs.rm(tmpLocalDst, { force: true });
  });
});
