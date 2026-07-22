/**
 * JpegStreamSplitter — extracts complete JPEG frames from ffmpeg's `image2pipe`
 * MJPEG stream. Each JPEG begins with SOI (0xFF 0xD8) and ends with EOI
 * (0xFF 0xD9); baseline MJPEG from ffmpeg byte-stuffs 0xFF inside entropy data,
 * so a plain SOI→EOI scan reliably delimits frames. Pure and synchronous — the
 * unit-testable counterpart to the producer's process spawning.
 */
export class JpegStreamSplitter {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const frames: Uint8Array[] = [];
    for (;;) {
      const soi = this.findMarker(0xd8, 0);
      if (soi < 0) {
        // No start marker yet; keep only a trailing lone 0xFF (a split SOI).
        this.buf =
          this.buf.length > 0 && this.buf[this.buf.length - 1] === 0xff
            ? this.buf.subarray(this.buf.length - 1)
            : Buffer.alloc(0);
        break;
      }
      if (soi > 0) this.buf = this.buf.subarray(soi); // drop bytes before SOI
      const eoi = this.findMarker(0xd9, 2);
      if (eoi < 0) break; // incomplete frame — wait for more bytes
      const end = eoi + 2;
      frames.push(Uint8Array.from(this.buf.subarray(0, end)));
      this.buf = this.buf.subarray(end);
    }
    return frames;
  }

  get pending(): number {
    return this.buf.length;
  }

  private findMarker(second: number, from: number): number {
    for (let i = from; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === 0xff && this.buf[i + 1] === second) return i;
    }
    return -1;
  }
}
