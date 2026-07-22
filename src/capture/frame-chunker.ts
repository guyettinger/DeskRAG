/**
 * FrameChunker — reassembles fixed-size raw frames from an arbitrarily-chunked
 * byte stream (ffmpeg's stdout arrives in OS-sized reads, not frame-aligned).
 * Pure and synchronous so it can be unit-tested without spawning anything.
 */
export class FrameChunker {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly frameBytes: number) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
      throw new Error(`frameBytes must be a positive integer, got ${frameBytes}`);
    }
  }

  /** Append bytes; return every complete frame now available (in order). */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const frames: Uint8Array[] = [];
    while (this.buf.length >= this.frameBytes) {
      frames.push(Uint8Array.from(this.buf.subarray(0, this.frameBytes)));
      this.buf = this.buf.subarray(this.frameBytes);
    }
    return frames;
  }

  /** Bytes buffered but not yet forming a full frame. */
  get pending(): number {
    return this.buf.length;
  }
}
