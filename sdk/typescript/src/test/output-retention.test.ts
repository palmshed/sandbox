import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '../index.js';
import { BoundedOutput, MAX_RETAINED_BYTES_PER_STREAM } from '../core/retention.js';

/**
 * Bounded output retention (issue #12).
 *
 * Retained stdout/stderr keep at most the last 16 MiB per stream so an
 * unbounded producer cannot OOM the SDK host. Real-time callbacks stay
 * complete; any retention loss sets `truncated` on metadata and result.
 */
test('Bounded output retention (native backend)', async (t) => {
  const sandbox = await Sandbox.create({ backend: 'native', timeout: 30000 });

  t.after(async () => {
    await sandbox.destroy();
  });

  await t.test('small outputs are byte-exact with truncated false and no marker', async () => {
    const execution = await sandbox.exec('echo "Hello Retention"');
    await execution.wait();

    assert.equal(execution.status(), 'completed');
    // Regex, not exact equality: Windows cmd echoes with literal quotes
    // and CRLF line endings, while POSIX shells print bare LF text.
    assert.match(execution.stdout(), /Hello Retention/);
    assert.ok(!execution.stdout().includes('output truncated'));
    assert.equal(execution.truncated, false);
    assert.equal(execution.metadata()!.truncated, false);
    assert.equal(execution.result()!.truncated, false);
  });

  await t.test('unbounded producer stays bounded, flags truncated, keeps callbacks complete', async () => {
    let callbackBytes = 0;
    // 64 KiB writes honoring backpressure: crosses the 16 MiB cap in well
    // under the timeout and sustains indefinitely. (A bare while(true) write
    // loop starves the flush side, so yields are required to actually emit;
    // ignoring backpressure with large batches trips pipe write limits, so
    // the producer waits for drain instead.) Written as a file so no shell
    // quoting is involved (Windows runs cmd.exe, where single quotes break).
    await sandbox.writeFile(
      'flood.js',
      'const b = Buffer.alloc(65536, 120); const { once } = require("events"); (async () => { while (true) { if (!process.stdout.write(b)) await once(process.stdout, "drain"); } })();'
    );
    const execution = await sandbox.exec('node flood.js', {
      timeout: 5000,
      onStdout: (chunk) => {
        callbackBytes += Buffer.byteLength(chunk, 'utf8');
      },
    });
    await execution.wait();

    assert.equal(execution.status(), 'timedout');
    assert.equal(execution.truncated, true);
    assert.equal(execution.metadata()!.truncated, true);
    assert.equal(execution.result()!.truncated, true);

    const retained = execution.stdout();
    assert.ok(
      Buffer.byteLength(retained, 'utf8') <= MAX_RETAINED_BYTES_PER_STREAM + 1024,
      `retained ${Buffer.byteLength(retained, 'utf8')} bytes exceeds the cap`
    );
    assert.match(retained, /^\[output truncated: showing last \d+ of \d+ bytes\]/);
    // The lossless path saw strictly more than retention kept.
    assert.ok(
      callbackBytes > MAX_RETAINED_BYTES_PER_STREAM,
      `callbacks should observe full output, saw ${callbackBytes} bytes`
    );
  });
});

test('BoundedOutput unit semantics', async (t) => {
  await t.test('evicts oldest whole chunks past the cap', async () => {
    const out = new BoundedOutput(10);
    out.push('12345');
    out.push('67890');
    assert.equal(out.truncated, false);
    assert.equal(out.text(), '1234567890');
    out.push('ABCDE');
    assert.equal(out.truncated, true);
    assert.equal(out.text(), '[output truncated: showing last 10 of 15 bytes]\n67890ABCDE');
    assert.equal(out.total(), 15);
  });

  await t.test('drops a single over-cap chunk whole instead of slicing characters', async () => {
    const out = new BoundedOutput(4);
    out.push('é'.repeat(10)); // 20 bytes, one chunk
    assert.equal(out.truncated, true);
    assert.match(out.text(), /^\[output truncated: showing last 0 of 20 bytes\]/);
  });
});
