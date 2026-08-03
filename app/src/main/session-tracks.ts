/**
 * Session signals → timeline lanes.
 *
 * PURE: rows in, DTO out. No store, no filesystem, no Electron — `DeskRagService`
 * performs the reads and hands the results here, which is what keeps every
 * lane's arithmetic in the fast ROOT suite (the same arrangement as
 * `plan-view.ts` and `graph-layout.ts`).
 *
 * Fifteen lanes, four shapes. A new signal is a builder here plus a line in
 * `buildSessionTracks` — never a new renderer component.
 */

import {
  urlPrefix,
  type AxSnapshotRow,
  type EventRow,
  type FrameRow,
  type SegmentRow,
} from "deskrag";
import type {
  KeyframeMarkerDTO,
  SessionTracksDTO,
  TrackLaneDTO,
  TrackMarkDTO,
  TrackSpanDTO,
  TrackTone,
} from "@shared/types";
import {
  bucketCounts,
  bucketHold,
  bucketMax,
  mergeAudioPeaks,
  normalize,
  type AudioBlobPeaks,
} from "./track-buckets.js";

export interface AudioLaneInput {
  media: string;
  blobs: readonly AudioBlobPeaks[];
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
}

function secOf(tMono: number, originMono: number): number {
  return (tMono - originMono) / 1000;
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

export function appsLane(input: LaneInput): TrackLaneDTO {
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
    spans,
    emptyReason:
      spans.length === 0
        ? "no focus changes recorded — the active-window signal was off or unavailable"
        : null,
    warning: null,
  };
}

export function webLane(input: LaneInput): TrackLaneDTO {
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

export function markersLane(input: LaneInput): TrackLaneDTO {
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
): { lane: TrackLaneDTO; count: number } {
  const secs = input.events
    .filter((e) => e.kind === kind)
    .map((e) => secOf(e.tMono, input.originMono));
  const perBucketSec = input.totalSec / input.buckets;
  const rate = bucketCounts(secs, input.totalSec, input.buckets).map((c) =>
    perBucketSec > 0 ? c / perBucketSec : 0,
  );
  const { values, peak } = normalize(rate);
  return {
    lane: {
      id,
      title,
      shape: "density",
      density: { values, peak, unit },
      emptyReason: secs.length === 0 ? absent : null,
      warning: null,
    },
    count: secs.length,
  };
}

export function typingLane(input: LaneInput): TrackLaneDTO {
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

export function scrollLane(input: LaneInput): TrackLaneDTO {
  return rateLane(input, "scroll", "scroll", "scroll", "events/s", "no scrolling recorded").lane;
}

export function clicksLane(input: LaneInput): TrackLaneDTO {
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
    marks,
    emptyReason: marks.length === 0 ? "no clicks recorded" : null,
    warning: null,
  };
}

// --- the index ---------------------------------------------------------------

/** Boundary reason → tone. The union is `BoundaryReason` in `src/segment/types.ts`. */
const BOUNDARY_TONE: Record<string, TrackTone> = {
  session_start: "ok",
  session_end: "ok",
  focus_change: "accent",
  dwell_gap: "warn",
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

export function segmentLanes(input: LaneInput): TrackLaneDTO[] {
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
): TrackLaneDTO {
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
    spans,
    emptyReason: spans.length === 0 ? absent : null,
    warning: null,
  };
}

export function transcriptLane(input: LaneInput): TrackLaneDTO {
  // Hedged deliberately: the store cannot prove retroactively that a provider
  // was absent, only that nothing carries the view.
  return presenceLane(
    input,
    "transcript",
    "transcript",
    (s) => s.transcript,
    "nothing was transcribed — most likely no whisper model was configured when this was indexed",
  );
}

export function captionLane(input: LaneInput): TrackLaneDTO {
  return presenceLane(
    input,
    "caption",
    "caption",
    (s) => s.caption,
    "nothing was captioned — most likely no captioner was configured when this was indexed",
  );
}

export function axLane(input: LaneInput): TrackLaneDTO {
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
    marks,
    emptyReason:
      marks.length === 0
        ? "no accessibility snapshots — the AX sidecar was unavailable or permission was not granted"
        : null,
    warning: null,
  };
}

export function framesLane(input: LaneInput): TrackLaneDTO {
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

export function mouseSpeedLane(input: LaneInput): TrackLaneDTO {
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
    density: { values, peak, unit: "px/s" },
    emptyReason: samples.length === 0 ? "no pointer movement recorded" : null,
    warning: null,
  };
}

export function mouseXyLane(input: LaneInput): TrackLaneDTO {
  const ms = moves(input);
  const bounds = screenBounds(input.events);
  const xs = ms.map((e) => ({ sec: secOf(e.tMono, input.originMono), value: e.x! / bounds.w }));
  const ys = ms.map((e) => ({ sec: secOf(e.tMono, input.originMono), value: e.y! / bounds.h }));
  return {
    id: "mouse-xy",
    title: "mouse x/y",
    shape: "density",
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

export function audioLanes(input: LaneInput): TrackLaneDTO[] {
  if (input.audio.length === 0) {
    return [
      {
        id: "audio-none",
        title: "audio",
        shape: "density",
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
export function buildSessionTracks(input: TrackInput): SessionTracksDTO {
  return {
    sessionId: input.sessionId,
    totalSec: input.totalSec,
    anchoredToVideo: input.anchoredToVideo,
    lanes: [
      framesLane(input),
      appsLane(input),
      webLane(input),
      ...segmentLanes(input),
      transcriptLane(input),
      captionLane(input),
      axLane(input),
      typingLane(input),
      clicksLane(input),
      scrollLane(input),
      mouseSpeedLane(input),
      mouseXyLane(input),
      ...audioLanes(input),
      markersLane(input),
    ],
  };
}
