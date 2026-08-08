/**
 * Session signals → timeline lanes.
 *
 * PURE: rows in, DTO out. No store, no filesystem, no Electron — `DeskRagService`
 * performs the reads and hands the results here, which is what keeps every
 * lane's arithmetic in the fast ROOT suite (the same arrangement as
 * `graph-view.ts` and `graph-layout.ts`).
 *
 * Fifteen lanes, four shapes. A new signal is a builder here plus a line in
 * `buildSessionTracks` — never a new renderer component.
 */

import {
  DEFAULT_BURST_GAP_MS,
  DEFAULT_DWELL_GAP_MS,
  MEANINGFUL_INPUT_KINDS,
  urlPrefix,
  type AxSnapshotRow,
  type EventRow,
  type FrameRow,
  type SegmentRow,
} from "deskrag";
import type {
  KeyframeMarkerDTO,
  SessionTracksDTO,
  TrackGroup,
  TrackLaneDTO,
  TrackMarkDTO,
  TrackSpanDTO,
  TrackTone,
} from "@shared/types";
import {
  bucketCounts,
  bucketHold,
  bucketMax,
  bucketRate,
  mergeAudioPeaks,
  normalize,
  type AudioBlobPeaks,
} from "./track-buckets.js";

/**
 * A lane before it has been assigned to a band.
 *
 * Every builder returns this rather than a full `TrackLaneDTO`, because a lane's
 * BAND is the same kind of decision as its ORDER — a statement about the rail's
 * shape, not about the signal — and both belong in `buildSessionTracks` where
 * they can be read together. `group` stays REQUIRED on the DTO, so a lane added
 * to that table without a band does not compile.
 */
export type LaneBody = Omit<TrackLaneDTO, "group">;

export interface AudioLaneInput {
  media: string;
  blobs: readonly AudioBlobPeaks[];
}

/** One utterance, projected from a `transcript_clip` row. */
export interface TranscriptClipInput {
  tMonoStart: number;
  tMonoEnd: number;
  text: string;
}

export interface LaneInput {
  /** t_mono that offset 0 corresponds to — the video's start when there is one. */
  originMono: number;
  totalSec: number;
  buckets: number;
  events: readonly EventRow[];
  segments: readonly SegmentRow[];
  frames: readonly FrameRow[];
  axSnapshots: readonly AxSnapshotRow[];
  /** Built by `DeskRagService.sessionDetail`, reused so one label rule serves both. */
  keyframes: readonly KeyframeMarkerDTO[];
  regionCounts: ReadonlyMap<string, number>;
  audio: readonly AudioLaneInput[];
  /** Utterance-level speech. Empty for a session transcribed without timings. */
  transcriptClips: readonly TranscriptClipInput[];
}

function secOf(tMono: number, originMono: number): number {
  return (tMono - originMono) / 1000;
}

/**
 * The `t_mono` that lane offset 0 means: the video's FIRST FRAME when there is
 * one, `t_mono` zero otherwise.
 *
 * Stated here once because four callers need it and every one of them used to
 * restate it — the rail, the keyframe markers, a search hit, and the Flows deep
 * link. The last of those got it wrong (raw `tMono / 1000`), which landed every
 * jump early by the pre-roll: capture starts while ffmpeg is still spawning, so
 * a session's first signals are genuinely BEFORE the video's first frame.
 */
export function laneOriginOf(video: { tMonoStart: number } | null | undefined): number {
  return video ? video.tMonoStart : 0;
}

/**
 * A `t_mono` stamp as LANE seconds — the axis the track rail is drawn in, and
 * the axis every cross-screen jump is expressed in.
 *
 * Clamped at 0, because no pixel of the axis means "before zero". The rail
 * declares that stretch separately (`preRollSec`, and the hatched clipped edge);
 * a moment to seek to has no such affordance and must simply land at the start.
 */
export function laneSec(tMono: number, originMono: number): number {
  return Math.max(0, secOf(tMono, originMono));
}

function asRecord(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/**
 * Stable application name → palette slot, so one app is one colour across every
 * lane and every session. Position in the timeline must never decide a colour;
 * a recording made tomorrow has to look like the same app.
 */
export function appTone(name: string): TrackTone {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  return `app-${h % 8}` as TrackTone;
}

// --- attention ---------------------------------------------------------------

export function appsLane(input: LaneInput): LaneBody {
  const changes = input.events.filter((e) => e.kind === "focus_change");
  const spans: TrackSpanDTO[] = [];
  for (let i = 0; i < changes.length; i++) {
    const label = String(asRecord(changes[i]!.data).app ?? "unknown");
    const startSec = secOf(changes[i]!.tMono, input.originMono);
    const next = changes[i + 1];
    // The last span runs to the end of the axis: focus does not end, the
    // recording does.
    const endSec = next ? secOf(next.tMono, input.originMono) : input.totalSec;
    if (endSec <= startSec) continue;
    spans.push({ startSec, endSec, label, tone: appTone(label) });
  }
  return {
    id: "apps",
    title: "apps",
    shape: "span",
    showLabels: true,
    spans,
    emptyReason:
      spans.length === 0
        ? "no focus changes recorded — the active-window signal was off or unavailable"
        : null,
    warning: null,
  };
}

export function webLane(input: LaneInput): LaneBody {
  const marks: TrackMarkDTO[] = [];
  for (const e of input.events) {
    if (e.kind !== "url_change") continue;
    const raw = asRecord(e.data).url;
    if (typeof raw !== "string") continue;
    // The trace IR's own site-prefix rule, imported rather than re-derived: two
    // URLs that merge into one graph node must read as one site here too.
    marks.push({
      atSec: secOf(e.tMono, input.originMono),
      label: urlPrefix(raw) ?? raw,
      tone: "accent",
    });
  }
  return {
    id: "web",
    title: "web",
    shape: "mark",
    showLabels: false,
    marks,
    emptyReason:
      marks.length === 0
        ? "no page URLs recorded — no browser was focused, or AXURL was unavailable"
        : null,
    warning: null,
  };
}

const MARKER_LABELS: Record<string, string> = {
  keymap_change: "keyboard layout",
  display_change: "displays changed",
  bookmark: "bookmark",
};

export function markersLane(input: LaneInput): LaneBody {
  const marks: TrackMarkDTO[] = input.events
    .filter((e) => e.kind in MARKER_LABELS)
    .map((e) => ({
      atSec: secOf(e.tMono, input.originMono),
      label: MARKER_LABELS[e.kind]!,
      tone: e.kind === "bookmark" ? ("ok" as TrackTone) : ("neutral" as TrackTone),
    }));
  return {
    id: "markers",
    title: "markers",
    shape: "mark",
    showLabels: false,
    marks,
    emptyReason: marks.length === 0 ? "no bookmarks or environment changes recorded" : null,
    warning: null,
  };
}

// --- input -------------------------------------------------------------------

/** Counts per bucket expressed as a per-second rate, then normalized. */
function rateLane(
  input: LaneInput,
  id: string,
  title: string,
  kind: string,
  unit: string,
  absent: string,
): { lane: LaneBody; count: number } {
  const secs = input.events
    .filter((e) => e.kind === kind)
    .map((e) => secOf(e.tMono, input.originMono));
  const perBucketSec = input.totalSec / input.buckets;
  // Smoothed over at least a second: a raw per-bucket rate turns one keystroke
  // in a 40ms bucket into "25 keys/s", which is true and useless.
  const rate = bucketRate(bucketCounts(secs, input.totalSec, input.buckets), perBucketSec);
  const { values, peak } = normalize(rate);
  return {
    lane: {
      id,
      title,
      shape: "density",
      showLabels: false,
      density: { values, peak, unit },
      emptyReason: secs.length === 0 ? absent : null,
      warning: null,
    },
    count: secs.length,
  };
}

export function typingLane(input: LaneInput): LaneBody {
  const { lane, count } = rateLane(
    input,
    "typing",
    "typing",
    "key_down",
    "keys/s",
    "no keys were pressed, or the input signal was off",
  );
  const hasKeymap = input.events.some((e) => e.kind === "keymap_change");
  return {
    ...lane,
    // The lane is NOT empty and still cannot be trusted. `resolveKeys` needs the
    // session's own keymap to turn a keycode into a character, so a recording
    // with keys and no keymap lost every character it typed, silently, at lift.
    warning:
      count > 0 && !hasKeymap
        ? "no keyboard layout was captured — every typed character was dropped at lift"
        : null,
  };
}

export function scrollLane(input: LaneInput): LaneBody {
  return rateLane(input, "scroll", "scroll", "scroll", "events/s", "no scrolling recorded").lane;
}

export function clicksLane(input: LaneInput): LaneBody {
  const ups = input.events.filter((e) => e.kind === "mouse_up");
  const marks: TrackMarkDTO[] = input.events
    .filter((e) => e.kind === "mouse_down")
    .map((d) => {
      // The first mouse_up at or after this down closes it. Overlapping
      // multi-button presses are rare enough that pairing in order is right.
      const up = ups.find((u) => u.tMono >= d.tMono);
      const heldMs = up ? up.tMono - d.tMono : 0;
      const moved =
        up && d.x !== null && d.y !== null && up.x !== null && up.y !== null
          ? Math.hypot(up.x - d.x, up.y - d.y)
          : 0;
      // 4px of slop: a click on a trackpad travels a pixel or two, and calling
      // that a drag would label almost every click one.
      const isDrag = moved > 4;
      return {
        atSec: secOf(d.tMono, input.originMono),
        label: isDrag ? `drag ${Math.round(heldMs)}ms · ${Math.round(moved)}px` : "click",
        tone: isDrag ? ("warn" as TrackTone) : ("accent" as TrackTone),
      };
    });
  return {
    id: "clicks",
    title: "clicks",
    shape: "mark",
    showLabels: false,
    marks,
    emptyReason: marks.length === 0 ? "no clicks recorded" : null,
    warning: null,
  };
}

/**
 * Inactivity — the INTENT signal, shown as itself.
 *
 * It used to cut `action` segments, which conflated "the user paused" with
 * "the state changed". Those are different questions and only the second one
 * segments a recording, so the gaps live here now.
 *
 * The rule is imported from the boundary detector rather than restated:
 * MEANINGFUL_INPUT_KINDS and both gap constants come from `deskrag`, because
 * two readers of one rule is the drift hazard that already bit ax-dump/ax-exec.
 */
export function idleLane(input: LaneInput): LaneBody {
  const spans: TrackSpanDTO[] = [];
  let lastT: number | undefined;
  let lastMeaningfulT: number | undefined;
  for (const e of input.events) {
    const meaningful = MEANINGFUL_INPUT_KINDS.has(e.kind);
    if (lastT !== undefined && e.tMono - lastT > DEFAULT_DWELL_GAP_MS) {
      spans.push({
        startSec: secOf(lastT, input.originMono),
        endSec: secOf(e.tMono, input.originMono),
        label: `idle ${((e.tMono - lastT) / 1000).toFixed(1)}s`,
        tone: "warn",
      });
    } else if (
      // `else`, so a dwell gap is never ALSO reported as a pause: one stretch
      // of time is one fact, and the stronger name for it wins.
      meaningful &&
      lastMeaningfulT !== undefined &&
      e.tMono - lastMeaningfulT > DEFAULT_BURST_GAP_MS
    ) {
      spans.push({
        startSec: secOf(lastMeaningfulT, input.originMono),
        endSec: secOf(e.tMono, input.originMono),
        label: `pause ${((e.tMono - lastMeaningfulT) / 1000).toFixed(1)}s`,
        tone: "neutral",
      });
    }
    lastT = e.tMono;
    if (meaningful) lastMeaningfulT = e.tMono;
  }
  return {
    id: "idle",
    title: "idle",
    shape: "span",
    showLabels: false,
    spans,
    emptyReason: spans.length === 0 ? "no idle gaps — input was continuous throughout" : null,
    warning: null,
  };
}

// --- the index ---------------------------------------------------------------

/** Boundary reason → tone. The union is `BoundaryReason` in `src/segment/types.ts`. */
const BOUNDARY_TONE: Record<string, TrackTone> = {
  session_start: "ok",
  session_end: "ok",
  focus_change: "accent",
  scene_change: "accent",
  dwell_gap: "warn",
  burst_gap: "warn",
  bookmark: "ok",
  window: "neutral",
};

/**
 * The granularity with the most segments — `action` against `task` in every
 * recording so far.
 *
 * Presence lanes (transcript, caption) need ONE granularity or their spans
 * stack on top of each other, and the finest is the one that shows where a view
 * actually stops and starts.
 */
export function finestGranularity(segments: readonly SegmentRow[]): string | null {
  const counts = new Map<string, number>();
  for (const s of segments) counts.set(s.granularity, (counts.get(s.granularity) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [g, n] of counts) {
    if (n > bestN) {
      best = g;
      bestN = n;
    }
  }
  return best;
}

function segmentLabel(s: SegmentRow): string {
  // Caption first for the same reason `keyframeLabel` prefers it: the VLM
  // describes the pixels, the digest is a template over events.
  return s.caption ?? s.digest ?? s.boundaryReason ?? "segment";
}

export function segmentLanes(input: LaneInput): LaneBody[] {
  const byGranularity = new Map<string, SegmentRow[]>();
  for (const s of input.segments) {
    const list = byGranularity.get(s.granularity) ?? [];
    list.push(s);
    byGranularity.set(s.granularity, list);
  }
  // Sorted so lane order is stable across reads; Map iteration would otherwise
  // follow whatever order SQLite happened to return.
  return [...byGranularity.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([granularity, rows]) => ({
      id: `seg-${granularity}`,
      title: granularity,
      shape: "span" as const,
      showLabels: false,
      spans: rows
        .slice()
        .sort((a, b) => a.tMonoStart - b.tMonoStart)
        .map((s) => ({
          startSec: secOf(s.tMonoStart, input.originMono),
          endSec: secOf(s.tMonoEnd, input.originMono),
          label: segmentLabel(s),
          tone: BOUNDARY_TONE[s.boundaryReason ?? "window"] ?? "neutral",
        })),
      emptyReason: null,
      warning: null,
    }));
}

function presenceLane(
  input: LaneInput,
  id: string,
  title: string,
  pick: (s: SegmentRow) => string | null,
  absent: string,
): LaneBody {
  const g = finestGranularity(input.segments);
  const spans: TrackSpanDTO[] = input.segments
    .filter((s) => s.granularity === g && pick(s) !== null)
    .sort((a, b) => a.tMonoStart - b.tMonoStart)
    .map((s) => ({
      startSec: secOf(s.tMonoStart, input.originMono),
      endSec: secOf(s.tMonoEnd, input.originMono),
      label: pick(s) ?? "",
      tone: "ok" as TrackTone,
    }));
  return {
    id,
    title,
    shape: "span",
    showLabels: false,
    spans,
    emptyReason: spans.length === 0 ? absent : null,
    warning: null,
  };
}

/**
 * Speech, at the extent it was actually spoken.
 *
 * Clips carry the provider's own timings, so a two-second sentence is a
 * two-second bar. Without them the only record is the SEGMENT that contained
 * the speech — which is what this lane used to draw, giving a 10s bar for that
 * same sentence and repeating the text across every segment the blob touched.
 * That fallback is kept, because a transcript at the wrong extent still beats
 * no transcript, but it is DISCLOSED rather than smoothed over — the same rule
 * `observations` vs `sources` follows on the Flows screen.
 */
export function transcriptLane(input: LaneInput): LaneBody {
  if (input.transcriptClips.length > 0) {
    return {
      id: "transcript",
      title: "transcript",
      shape: "span",
      showLabels: false,
      spans: input.transcriptClips
        .slice()
        .sort((a, b) => a.tMonoStart - b.tMonoStart)
        .map((c) => ({
          startSec: secOf(c.tMonoStart, input.originMono),
          endSec: secOf(c.tMonoEnd, input.originMono),
          label: c.text,
          tone: "ok" as TrackTone,
        })),
      emptyReason: null,
      warning: null,
    };
  }
  // Hedged deliberately: the store cannot prove retroactively that a provider
  // was absent, only that nothing carries the view.
  const fallback = presenceLane(
    input,
    "transcript",
    "transcript",
    (s) => s.transcript,
    "nothing was transcribed — most likely no whisper model was configured when this was indexed",
  );
  return {
    ...fallback,
    warning:
      fallback.emptyReason === null
        ? "no utterance timings were recorded — these bars are the SEGMENTS that contain speech, not the speech itself"
        : null,
  };
}

export function captionLane(input: LaneInput): LaneBody {
  return presenceLane(
    input,
    "caption",
    "caption",
    (s) => s.caption,
    "nothing was captioned — most likely no captioner was configured when this was indexed",
  );
}

export function axLane(input: LaneInput): LaneBody {
  const marks: TrackMarkDTO[] = input.axSnapshots
    .slice()
    .sort((a, b) => a.tMono - b.tMono)
    .map((s) => {
      const n = s.elements.length;
      return {
        atSec: secOf(s.tMono, input.originMono),
        label: `${s.reason} · ${n} elements · ${Math.round(s.walkMs)}ms`,
        // An empty result is a real row, written precisely so that "captured
        // nothing" stays distinguishable from "never captured". Zero elements
        // is the failure this lane exists to surface.
        tone:
          n === 0
            ? ("alarm" as TrackTone)
            : s.reason === "keyframe"
              ? ("accent" as TrackTone)
              : ("neutral" as TrackTone),
      };
    });
  return {
    id: "ax",
    title: "ax walks",
    shape: "mark",
    showLabels: false,
    marks,
    emptyReason:
      marks.length === 0
        ? "no accessibility snapshots — the AX sidecar was unavailable or permission was not granted"
        : null,
    warning: null,
  };
}

export function framesLane(input: LaneInput): LaneBody {
  const thumbs = input.keyframes.map((marker) => ({
    atSec: marker.offsetSec,
    // The marker travels whole rather than being flattened to a string, so
    // `keyframeLabel()` in the renderer stays the ONE place a keyframe is named.
    marker,
    regionCount: input.regionCounts.get(marker.frameId) ?? 0,
  }));
  return {
    id: "frames",
    title: "keyframes",
    shape: "thumb",
    showLabels: false,
    thumbs,
    emptyReason:
      thumbs.length === 0
        ? "no keyframes were indexed — the screen was settled throughout, or the Screen signal was off"
        : null,
    warning: null,
  };
}

// --- pointer motion ----------------------------------------------------------

/**
 * Screen extent for normalizing pointer coordinates.
 *
 * From recorded display topology when there is any — that is what
 * `display_change` exists for, and it is resolved latest-first like every other
 * environment fact. Otherwise the largest coordinate actually observed, which
 * is a floor rather than a guess.
 */
function screenBounds(events: readonly EventRow[]): { w: number; h: number } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "display_change") continue;
    const displays = asRecord(e.data).displays;
    if (!Array.isArray(displays)) continue;
    let w = 0;
    let h = 0;
    for (const d of displays) {
      const r = asRecord(d);
      // DisplayInfo is x/y/w/h in global screen coordinates — NOT width/height.
      const right = Number(r.x ?? 0) + Number(r.w ?? 0);
      const bottom = Number(r.y ?? 0) + Number(r.h ?? 0);
      if (Number.isFinite(right)) w = Math.max(w, right);
      if (Number.isFinite(bottom)) h = Math.max(h, bottom);
    }
    if (w > 0 && h > 0) return { w, h };
  }
  let w = 1;
  let h = 1;
  for (const e of events) {
    if (e.x !== null) w = Math.max(w, e.x);
    if (e.y !== null) h = Math.max(h, e.y);
  }
  return { w, h };
}

function moves(input: LaneInput): EventRow[] {
  return input.events.filter((e) => e.kind === "mouse_move" && e.x !== null && e.y !== null);
}

export function mouseSpeedLane(input: LaneInput): LaneBody {
  const ms = moves(input);
  const samples: { sec: number; value: number }[] = [];
  for (let i = 1; i < ms.length; i++) {
    const a = ms[i - 1]!;
    const b = ms[i]!;
    const dt = (b.tMono - a.tMono) / 1000;
    if (dt <= 0) continue;
    samples.push({
      sec: secOf(b.tMono, input.originMono),
      value: Math.hypot(b.x! - a.x!, b.y! - a.y!) / dt,
    });
  }
  const { values, peak } = normalize(bucketMax(samples, input.totalSec, input.buckets));
  return {
    id: "mouse-speed",
    title: "mouse speed",
    shape: "density",
    showLabels: false,
    density: { values, peak, unit: "px/s" },
    emptyReason: samples.length === 0 ? "no pointer movement recorded" : null,
    warning: null,
  };
}

export function mouseXyLane(input: LaneInput): LaneBody {
  const ms = moves(input);
  const bounds = screenBounds(input.events);
  const xs = ms.map((e) => ({ sec: secOf(e.tMono, input.originMono), value: e.x! / bounds.w }));
  const ys = ms.map((e) => ({ sec: secOf(e.tMono, input.originMono), value: e.y! / bounds.h }));
  return {
    id: "mouse-xy",
    title: "mouse x/y",
    shape: "density",
    showLabels: false,
    density: {
      // Already 0–1 by construction, so these are NOT re-normalized: rescaling
      // would make the traces depend on how far the pointer happened to travel
      // rather than on where it actually was.
      values: bucketHold(xs, input.totalSec, input.buckets),
      values2: bucketHold(ys, input.totalSec, input.buckets),
      peak: 1,
      unit: "screen",
    },
    emptyReason: ms.length === 0 ? "no pointer movement recorded" : null,
    warning: null,
  };
}

// --- sound -------------------------------------------------------------------

export function audioLanes(input: LaneInput): LaneBody[] {
  if (input.audio.length === 0) {
    return [
      {
        id: "audio-none",
        title: "audio",
        shape: "density",
        showLabels: false,
        density: { values: new Array(input.buckets).fill(null), peak: 0, unit: "amplitude" },
        emptyReason: "no audio was captured — the Audio signal was off, or every blob is missing",
        warning: null,
      },
    ];
  }
  return input.audio.map((a) => {
    const values = mergeAudioPeaks(a.blobs, input.totalSec, input.buckets);
    let peak = 0;
    let covered = false;
    for (const v of values) {
      if (v === null) continue;
      covered = true;
      if (v > peak) peak = v;
    }
    return {
      id: `audio-${a.media}`,
      title: a.media === "mic" ? "audio (mic)" : `audio (${a.media})`,
      shape: "density" as const,
      showLabels: false,
      // NOT re-normalized: amplitude is already 0–1 against full scale, and
      // rescaling to the loudest moment would make a whisper look like a shout.
      density: { values, peak, unit: "amplitude" },
      emptyReason: covered ? null : "every audio blob for this medium was unreadable or missing",
      warning: null,
    };
  });
}

// --- assembly ----------------------------------------------------------------

export interface TrackInput extends LaneInput {
  sessionId: string;
  anchoredToVideo: boolean;
}

/**
 * Lanes in reading order: screen → attention → index → hands → sound.
 *
 * Every lane is emitted even when it is empty. Absence is the answer to two of
 * the four questions this rail exists to answer, so a missing lane and a lane
 * that says why it is missing are very different things.
 */
/**
 * Lane order AND lane band, in one table.
 *
 * Bands are named for the SIGNAL a lane comes from, never its shape: `keyframes`
 * and `apps` are both "screen" though one is a thumbnail lane and one a span,
 * because what a reader collapses is "not looking at the screen right now". The
 * table is listed in band order, so the rail's rendering order falls straight
 * out of it and no separate sort is needed.
 */
function bandedLanes(input: TrackInput): readonly [TrackGroup, LaneBody | LaneBody[]][] {
  return [
    ["screen", framesLane(input)],
    ["screen", appsLane(input)],
    ["screen", webLane(input)],
    ["screen", axLane(input)],
    ["segments", segmentLanes(input)],
    ["segments", captionLane(input)],
    ["audio", transcriptLane(input)],
    ["audio", audioLanes(input)],
    ["input", typingLane(input)],
    ["input", clicksLane(input)],
    ["input", scrollLane(input)],
    ["input", mouseSpeedLane(input)],
    ["input", mouseXyLane(input)],
    ["input", idleLane(input)],
    ["marks", markersLane(input)],
  ];
}

export function buildSessionTracks(input: TrackInput): SessionTracksDTO {
  return {
    sessionId: input.sessionId,
    totalSec: input.totalSec,
    anchoredToVideo: input.anchoredToVideo,
    lanes: bandedLanes(input).flatMap(([group, body]) =>
      (Array.isArray(body) ? body : [body]).map((lane) => ({ ...lane, group })),
    ),
  };
}
