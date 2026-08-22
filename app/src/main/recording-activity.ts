/**
 * SignalTally — folds the capture session's live activity into what the Record
 * screen shows, one counter per signal.
 *
 * Pure and root-tested, the `session-tracks.ts` / `index-graph.ts` split: main
 * decides what an activity MEANS, the renderer decides how it reads. It holds no
 * timers and touches nothing — the caller observes, the caller snapshots.
 *
 * Two rules it exists to keep:
 *
 * - **`attached` comes from what actually STARTED, never from Settings.** The
 *   microphone is dropped when its permission is refused and a native producer
 *   that fails to load is never added, so a card driven by the settings alone has
 *   been showing green for a signal that is not recording.
 * - **Nothing is inferred.** No rate, no ETA, no staleness verdict. A signal that
 *   has produced nothing reports zero, which is exactly the reading that exposes
 *   a screen producer that found no display and returned without spawning.
 */

import type { CaptureActivity } from "deskrag";
import type { RecordingSignalDTO, RecordingTickDTO, SignalKind } from "@shared/types";
import { appTone } from "./session-tracks.js";

const KINDS: SignalKind[] = ["screen", "input", "active-win", "audio", "desktop-audio", "ax"];

interface Counters {
  keyframes: number;
  lastFrameBlobId?: string;
  keys: number;
  clicks: number;
  app?: string;
  focusChanges: number;
  walks: number;
  elements: number;
}

const empty = (): Counters => ({
  keyframes: 0,
  keys: 0,
  clicks: 0,
  focusChanges: 0,
  walks: 0,
  elements: 0,
});

/**
 * Per-source audio tallies.
 *
 * SEPARATE, because `CaptureActivity` has always carried `media` and this fold
 * used to throw it away: with the microphone and the tap both running, one
 * counter would be the sum of two sources and one envelope would flicker
 * between them — and a dead tap would hide behind a live microphone, which is
 * precisely the thing the lamp exists to prevent.
 */
interface AudioCounters {
  chunks: number;
  peaks?: number[] | null;
}

/** Which signal card a captured medium reports to. */
const KIND_FOR_MEDIA = {
  mic: "audio",
  desktop_audio: "desktop-audio",
} as const satisfies Record<"mic" | "desktop_audio", SignalKind>;

export class SignalTally {
  private readonly c = empty();
  private readonly audio: Record<"mic" | "desktop_audio", AudioCounters> = {
    mic: { chunks: 0 },
    desktop_audio: { chunks: 0 },
  };
  private readonly attached: ReadonlySet<SignalKind>;

  constructor(attached: readonly SignalKind[]) {
    this.attached = new Set(attached);
  }

  /**
   * Fold one activity in. Called on the capture path once per event, so it does
   * arithmetic and nothing else — no allocation per call beyond the app string.
   */
  observe(a: CaptureActivity): void {
    switch (a.kind) {
      case "frame":
        // DROPPED frames are not counted: `mpdecimate` rejecting a frame means
        // the screen did not change, which is the pipeline working. The number a
        // reader can act on is how many keyframes exist.
        if (!a.kept) return;
        this.c.keyframes += 1;
        if (a.blobId !== undefined) this.c.lastFrameBlobId = a.blobId;
        return;
      case "audio": {
        const c = this.audio[a.media];
        c.chunks += 1;
        c.peaks = a.peaks;
        return;
      }
      case "ax":
        this.c.walks += 1;
        this.c.elements = a.elements;
        return;
      case "event":
        this.event(a.eventKind, a.data);
        return;
    }
  }

  /**
   * Keys and clicks, and deliberately not scroll or pointer movement.
   *
   * These two are the gestures the digest is built from — typed text, and the
   * label of what was clicked — so they are the two a reader can check their own
   * session against. A well holds two figures; a third would push the row past
   * the width a five-up card has.
   */
  private event(kind: string, data: unknown): void {
    if (kind === "key_down") this.c.keys += 1;
    else if (kind === "mouse_down") this.c.clicks += 1;
    else if (kind === "focus_change") {
      this.c.focusChanges += 1;
      const app = (data as { app?: unknown } | undefined)?.app;
      if (typeof app === "string" && app.length > 0) this.c.app = app;
    }
  }

  /** One medium's readout, attached against the card it reports to. */
  private audioDto(media: "mic" | "desktop_audio"): RecordingSignalDTO {
    const a = this.audio[media];
    return {
      attached: this.attached.has(KIND_FOR_MEDIA[media]),
      chunks: a.chunks,
      ...(a.peaks !== undefined ? { peaks: a.peaks } : {}),
    };
  }

  snapshot(sessionId: string, atMs: number): RecordingTickDTO {
    const c = this.c;
    const per: Record<SignalKind, RecordingSignalDTO> = {
      screen: {
        attached: this.attached.has("screen"),
        keyframes: c.keyframes,
        ...(c.lastFrameBlobId !== undefined ? { lastFrameBlobId: c.lastFrameBlobId } : {}),
      },
      input: { attached: this.attached.has("input"), keys: c.keys, clicks: c.clicks },
      "active-win": {
        attached: this.attached.has("active-win"),
        focusChanges: c.focusChanges,
        // ONE hash for the whole app, imported rather than repeated: an
        // application is one colour on the rail, in Flows, on a search row and
        // here. A second copy of it is the `ax-dump`/`ax-exec` drift hazard.
        ...(c.app !== undefined ? { app: c.app, appTone: appTone(c.app) } : {}),
      },
      audio: this.audioDto("mic"),
      "desktop-audio": this.audioDto("desktop_audio"),
      ax: { attached: this.attached.has("ax"), walks: c.walks, elements: c.elements },
    };
    return { sessionId, atMs, signals: per };
  }
}

/** The zero snapshot, for a signal set with nothing recorded yet. */
export function emptyTick(sessionId: string, attached: readonly SignalKind[], atMs: number): RecordingTickDTO {
  return new SignalTally(attached).snapshot(sessionId, atMs);
}

export { KINDS as SIGNAL_KINDS };
