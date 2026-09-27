/**
 * Bounded output retention (issue #12).
 *
 * Unbounded workload output must not grow host memory without bound, so
 * retained stdout/stderr keep at most the last `capBytes` bytes per
 * stream. Accounting is in UTF-8 bytes; eviction drops whole leading
 * chunks (never slices inside a chunk, so no split multi-byte
 * characters), meaning retention holds *approximately* the last
 * `capBytes` bytes and never more.
 *
 * The real-time paths (`onStdout`/`onStderr` callbacks, piped Writable
 * streams) are intentionally untouched by this cap: they remain the
 * complete, lossless route to full output. Only retention is lossy, and
 * any loss sets `truncated` permanently for the execution lifetime.
 */

/** Maximum retained bytes per stream (16 MiB). Well above the largest covered workload (4 MiB), far below OOM territory. */
export const MAX_RETAINED_BYTES_PER_STREAM = 16 * 1024 * 1024;

export class BoundedOutput {
  private chunks: string[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  private dropped = false;

  constructor(private readonly capBytes: number = MAX_RETAINED_BYTES_PER_STREAM) {}

  /** Append a chunk; evict oldest whole chunks past the cap. */
  push(chunk: string): void {
    if (chunk.length === 0) return;
    const size = Buffer.byteLength(chunk, 'utf8');
    this.totalBytes += size;
    this.chunks.push(chunk);
    this.retainedBytes += size;
    while (this.chunks.length > 1 && this.retainedBytes > this.capBytes) {
      const oldest = this.chunks.shift()!;
      this.retainedBytes -= Buffer.byteLength(oldest, 'utf8');
      this.dropped = true;
    }
    if (this.chunks.length === 1 && this.retainedBytes > this.capBytes) {
      // Single giant chunk: retaining any of it would exceed the cap, so
      // drop it whole rather than slice inside a multi-byte character.
      // The bytes still count toward totalBytes and set truncated.
      this.retainedBytes = 0;
      this.chunks = [];
      this.dropped = true;
    }
  }

  /** Retained text, prefixed with a truncation marker when bytes were dropped. */
  text(): string {
    const body = this.chunks.join('');
    if (!this.dropped) return body;
    return `[output truncated: showing last ${this.retainedBytes} of ${this.totalBytes} bytes]\n${body}`;
  }

  /** Total bytes ever received (retained plus dropped). */
  total(): number {
    return this.totalBytes;
  }

  /** True once any byte has been dropped. Sticky for the execution lifetime. */
  get truncated(): boolean {
    return this.dropped;
  }
}
