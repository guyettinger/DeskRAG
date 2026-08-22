/**
 * What a signal card SAYS — its lamp, and the one line in its well.
 *
 * `.ts`, never `.tsx`: the ROOT tsconfig sets no `jsx`, so a root test that
 * reaches into a `.tsx` — even only for a type — breaks `npm run typecheck`.
 * The `index-graph-view.ts` / `track-view.ts` pairing: main decides what an
 * activity MEANS (`recording-activity.ts`), this decides how it reads.
 *
 * ## Three rules, each of them paid for elsewhere in this app
 *
 * - **A well ALWAYS answers.** Off, blocked, ready, or a figure — never blank.
 *   A stage that merely never appears is indistinguishable from one nobody
 *   implemented, which is why the Indexing ladder draws a skipped stage and
 *   states its reason.
 * - **Nothing is inferred.** No rate, no ETA, no staleness verdict. `0 keyframes`
 *   twenty seconds in is a fact, and it is the one reading that exposes a screen
 *   producer which attached and never spawned. A threshold calling that "stalled"
 *   would be a claim nobody measured.
 * - **Silence is a MEASUREMENT and absence is not.** A peak of exactly 0 is
 *   digital silence — the microphone default that recorded −91 dB for a whole
 *   session and left a store that looked perfectly healthy. `null` peaks mean the
 *   bytes were not readable PCM, and no chunk yet means neither has been said.
 */

import type { RecordingSignalDTO, TrackTone, SignalKind } from "@shared/types";

/** The lamp. Three states, matching the `.led` vocabulary already in the sheet. */
export type LedState = "ok" | "warn" | "off";

/** The right-hand half of a well: a second figure, a frame, or an envelope. */
export type SignalGlyph =
  | { kind: "count"; text: string }
  | { kind: "frame"; blobId: string }
  | { kind: "wave"; peaks: number[] };

export interface SignalReadout {
  led: LedState;
  /** The well's left-hand line. Never empty. */
  figure: string;
  /** True when `figure` is a state rather than a measurement, so it can recede. */
  idle: boolean;
  /** Tone for the figure, where the figure names an application. */
  tone?: TrackTone;
  glyph?: SignalGlyph;
  /** Amber caveat under the figure — a measurement that needs acting on. */
  warning?: string;
  /** The disclosure a figure cannot carry inline, for the well's `title`. */
  note?: string;
}

/** What the card knows about itself, independent of any recording. */
export interface SignalGate {
  enabled: boolean;
  /** Permission granted (or not required). */
  granted: boolean;
  /** An environment gate that FAILED — a missing binary or sidecar. */
  blockedBy?: string;
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Peak amplitude (0..1) as dBFS, to one decimal.
 *
 * Exactly 0 has no dB value at all — log(0) is −Infinity, and printing "−Inf dB"
 * or clamping it to some floor would both dress an absolute up as a reading. The
 * caller says "no signal" instead.
 */
export function peakDb(peak: number): string {
  return `${(20 * Math.log10(peak)).toFixed(1)} dB`;
}

/** The loudest sample in the last chunk, or null when there is nothing to read. */
function loudest(peaks: number[] | null | undefined): number | null {
  if (!peaks || peaks.length === 0) return null;
  return Math.max(...peaks);
}

/**
 * Fold the gate, the recording state and the live counters into one readout.
 *
 * `live` is the recording, not the signal: a card must be able to say "ready"
 * while nothing is capturing, and "not capturing" while something is.
 */
/**
 * One audio card's well. Shared by the microphone and computer audio because
 * the READING is identical — chunks, then peak, then an envelope — and only the
 * two sentences differ. Two copies of this would be the `ax-dump`/`ax-exec`
 * drift hazard in the place where the digital-silence callout lives.
 */
function audioReadout(
  s: RecordingSignalDTO,
  silenceWarning: string,
  note: string,
): SignalReadout {
  const chunks = s.chunks ?? 0;
  if (chunks === 0) return { led: "ok", figure: "Waiting for the first chunk", idle: true };
  const peak = loudest(s.peaks);
  if (peak === null)
    return {
      led: "warn",
      figure: "Cannot read the audio",
      idle: true,
      warning: "The chunk is not 16-bit PCM.",
    };
  if (peak === 0)
    return {
      led: "warn",
      figure: "No signal",
      idle: false,
      glyph: { kind: "wave", peaks: s.peaks ?? [] },
      warning: silenceWarning,
    };
  return {
    led: "ok",
    figure: `peak ${peakDb(peak)}`,
    idle: false,
    glyph: { kind: "wave", peaks: s.peaks ?? [] },
    note,
  };
}

export function signalReadout(
  id: SignalKind,
  gate: SignalGate,
  live: boolean,
  s: RecordingSignalDTO | undefined,
): SignalReadout {
  if (!gate.enabled) return { led: "off", figure: "Off", idle: true };
  if (gate.blockedBy) return { led: "warn", figure: gate.blockedBy, idle: true };
  if (!gate.granted) return { led: "warn", figure: "Waiting on permission", idle: true };
  if (!live) return { led: "ok", figure: "Ready", idle: true };
  // Recording, but this producer never started. Main knows this from what
  // actually attached — the microphone is dropped on a refused permission and a
  // native producer that fails to load is never added — and it is the reading a
  // card driven by Settings alone could never give.
  if (!s || !s.attached) return { led: "warn", figure: "Not capturing", idle: true };

  switch (id) {
    case "screen": {
      const n = s.keyframes ?? 0;
      return {
        led: "ok",
        figure: plural(n, "keyframe"),
        idle: false,
        ...(s.lastFrameBlobId ? { glyph: { kind: "frame", blobId: s.lastFrameBlobId } } : {}),
        note: "A keyframe is kept when the picture changes, so a still screen makes none.",
      };
    }
    case "input":
      return {
        led: "ok",
        figure: plural(s.keys ?? 0, "key"),
        idle: false,
        glyph: { kind: "count", text: plural(s.clicks ?? 0, "click") },
        note: "Keys become text at index time, against the layout in force.",
      };
    case "active-win": {
      const app = s.app;
      if (!app) return { led: "ok", figure: "No window yet", idle: true };
      return {
        led: "ok",
        figure: app,
        idle: false,
        ...(s.appTone ? { tone: s.appTone } : {}),
        glyph: { kind: "count", text: plural(s.focusChanges ?? 0, "switch", "switches") },
      };
    }
    case "audio":
      return audioReadout(
        s,
        "Every sample is zero — check the input device in Settings.",
        "The loudest sample in the last completed chunk.",
      );
    case "desktop-audio":
      return audioReadout(
        s,
        // BOTH causes, because from inside the process they are the same
        // observation. A tap delivers nothing at all while the output device is
        // idle — measured: five seconds of silence yields zero callbacks — and
        // a refused permission looks identical. Naming one would be a claim
        // nobody measured.
        "Every sample is zero — either nothing is playing, or System Audio " +
          "Recording is not granted to DeskRAG.",
        "The loudest sample in the last completed chunk. DeskRAG's own sound is excluded.",
      );
    case "ax": {
      const walks = s.walks ?? 0;
      if (walks === 0) return { led: "ok", figure: "No walk yet", idle: true };
      return {
        led: "ok",
        figure: plural(walks, "walk"),
        idle: false,
        glyph: { kind: "count", text: plural(s.elements ?? 0, "element") },
        note: "Elements in the most recent walk, not a total.",
      };
    }
  }
}

/**
 * The hairline a silent envelope still draws, in viewBox units.
 *
 * A filled shape of zero height paints NOTHING, so a chunk of pure silence would
 * leave an empty box — indistinguishable from a card that has no envelope at all.
 * Silence is a reading and has to look like one: a flat line on the axis, the
 * convention every waveform uses. It is a floor on the DRAWING, never on the
 * number, and the figure beside it says "No signal" in words regardless.
 */
const WAVE_FLOOR = 0.4;

/**
 * An envelope as an SVG path, drawn from the CENTRE both ways.
 *
 * Mirrored rather than a bar chart because that is what an audio envelope looks
 * like everywhere else in this app — the rail draws the same shape from the same
 * `wavPeaks` numbers.
 */
export function wavePath(peaks: readonly number[], w: number, h: number): string {
  const mid = h / 2;
  if (peaks.length === 0) return `M0 ${mid - WAVE_FLOOR}H${w}V${mid + WAVE_FLOOR}H0Z`;
  const step = w / peaks.length;
  const top: string[] = [];
  const bottom: string[] = [];
  peaks.forEach((p, i) => {
    const x = i * step + step / 2;
    const a = Math.max(WAVE_FLOOR, Math.max(0, Math.min(1, p)) * mid);
    top.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${(mid - a).toFixed(2)}`);
    bottom.unshift(`L${x.toFixed(2)} ${(mid + a).toFixed(2)}`);
  });
  return `${top.join("")}${bottom.join("")}Z`;
}
