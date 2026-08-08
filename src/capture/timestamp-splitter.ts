/**
 * TimestampLineSplitter — extracts per-frame presentation timestamps from
 * ffmpeg's `mkvtimestamp_v2` output, which writes a `# timecode format v2`
 * header followed by one integer millisecond value per packet, newline
 * separated.
 *
 * BUFFER UNTIL A NEWLINE BEFORE PARSING. A real stream arrives in chunks whose
 * boundaries land mid-number, and parsing each chunk independently turns one
 * `1000` into `10` and `0` — two plausible, wrong timestamps that no assertion
 * about the value's shape can catch. It is the same rule the AX sidecar needs
 * for its >64KB stdout, one digit at a time instead of one JSON document.
 *
 * Pure and synchronous — the unit-testable counterpart to the producer's
 * process spawning, like JpegStreamSplitter and FrameChunker.
 */
export class TimestampLineSplitter {
  private buf = "";

  push(chunk: Uint8Array): number[] {
    this.buf += Buffer.from(chunk).toString("utf8");
    const lines = this.buf.split("\n");
    // Whatever follows the final newline is an incomplete line — or "" when the
    // chunk ended exactly on one. Either way it is not ready to parse.
    this.buf = lines.pop() ?? "";
    const out: number[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue; // blank or the format header
      const n = Number(t);
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  }

  /** Bytes held back awaiting a newline (diagnostics + tests). */
  get pending(): number {
    return this.buf.length;
  }
}
