/**
 * Reads the device-time anchors `audio-tap` writes on fd 3.
 *
 * The microphone's anchor comes out of ffmpeg's `ametadata` filter and needs a
 * regex over log-ish text (`pts-line.ts`); this one is a binary we own, so it is
 * JSON and there is nothing to guess at. Kept pure and in its own file for the
 * same reason `pts-line.ts` is: the Swift emitter and this parser are two
 * readers of ONE contract, and that pairing is the standing drift hazard in this
 * repo (`ax-dump`/`ax-exec` disagreeing over a single empty string cost a whole
 * replay path). `audio-tap --self-test` emits this shape above every gate so the
 * pair can be tested together, on any macOS, in CI.
 *
 * WHY THERE CAN BE MORE THAN ONE. A tap delivers nothing at all while the output
 * device is idle — measured: five seconds with nothing playing produced zero
 * callbacks and a zero-byte file — so the first anchor describes the first
 * sample that was actually DELIVERED, which may be minutes into a recording.
 * And if the device ever stops and restarts mid-recording, the byte stream
 * carries no trace of the hole. Every anchor therefore names the stdout
 * `byteOffset` it applies from, and the producer times each byte against the
 * last anchor at or before it. Unverified byte arithmetic across a hole would
 * slide the whole remainder of a recording earlier, silently.
 */

/** One `{"v":1,"anchorMs":…,"byteOffset":…}` line from fd 3. */
export interface AudioTapAnchor {
  /** Contract version; the producer refuses a binary it does not know. */
  version: number;
  /** Device time of the sample at `byteOffset`, in the `ax-dump --clock` base. */
  anchorMs: number;
  /** Absolute offset into the sidecar's stdout that `anchorMs` describes. */
  byteOffset: number;
  sampleRate: number;
  channels: number;
  /** Container/sample format, always `s16le` at v1. */
  format: string;
}

/**
 * Parse one anchor line. THROWS rather than returning null on anything
 * unexpected: an anchor is the only thing standing between this signal and
 * arrival-stamped audio, so a malformed one must stop the producer, not
 * degrade it into a guess. `parseDeviceClock` has the same contract for the
 * same reason.
 */
export function parseAudioTapAnchor(line: string): AudioTapAnchor {
  const text = line.trim();
  if (text.length === 0) throw new Error("audio-tap anchor: empty line");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Usage text and log lines land here. Quote it: the message is what a
    // reader gets when a stale binary is on PATH.
    throw new Error(`audio-tap anchor: not JSON: ${text.slice(0, 120)}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`audio-tap anchor: not an object: ${text.slice(0, 120)}`);
  }
  const o = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`audio-tap anchor: ${key} is not a finite number`);
    }
    return v;
  };
  const format = o["format"];
  if (typeof format !== "string" || format.length === 0) {
    throw new Error("audio-tap anchor: format is missing");
  }
  return {
    version: num("v"),
    anchorMs: num("anchorMs"),
    byteOffset: num("byteOffset"),
    sampleRate: num("sampleRate"),
    channels: num("channels"),
    format,
  };
}
