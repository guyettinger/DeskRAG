/**
 * Lift one recorded session into a linear Trace.
 *
 * Reuses `computeBoundaries` rather than inventing a second notion of where
 * things break: focus_change / dwell_gap / bookmark are already the moments
 * where state settles, and `bookmark` is already a user-placed keypoint.
 *
 * Anchors resolve against the AX tree captured AT THAT MOMENT, never live — the
 * rule `StoredAxProvider` already enforces at represent time.
 *
 * Ids are deterministic (prefix + ordinal), not ULIDs: re-lifting after a
 * heuristic change must be diffable against the previous lift.
 */

import { computeBoundaries } from "../segment/boundaries.js";
import { resolveChar } from "../capture/env/keymap.js";
import type { Keymap } from "../capture/env/types.js";
import { buildAnchor } from "./anchors.js";
import { groupGestures, type Gesture, type GestureOptions } from "./gestures.js";
import { fitPath } from "./paths.js";
import { extractPredicates, predicateKey, type PredicateContext } from "./predicates.js";
import type {
  Action,
  Anchor,
  AnchorRegion,
  Predicate,
  Rect,
  Slot,
  Trace,
  TraceEdge,
  TraceEvent,
  TraceNode,
  UIElement,
  Vec2,
} from "./types.js";

export interface AxSnapshot {
  elements: readonly UIElement[];
  /** Absent for a boundary-triggered snapshot, which has no keyframe. */
  frameId?: string;
  framePhash?: string;
}

export interface LiftInput {
  sessionId: string;
  events: readonly TraceEvent[];
  endTMono: number;
  /** The stored AX snapshot nearest at/just before `tMono`. */
  axAt?(tMono: number): AxSnapshot | undefined;
  regionsAt?(tMono: number): readonly AnchorRegion[];
  /**
   * The display a point belongs to, at that t_mono. The t_mono is required
   * because topology CHANGES mid-session (a monitor plugged in), and resolving a
   * coordinate against the wrong topology is a silent misattribution — the exact
   * failure `display_change` events exist to prevent.
   */
  displayIdAt?(p: Vec2, tMono: number): string;
  windowBoundsAt?(tMono: number): Rect | undefined;
  /** The keyboard layout in force at `tMono`, for character resolution. */
  keymapAt?(tMono: number): Keymap | undefined;
  dwellGapMs?: number;
  gestures?: GestureOptions;
  /** Defaults to `sessionId`. Ids are `${prefix}:n0`, `${prefix}:e0`, ... */
  idPrefix?: string;
}

const MIN_WAIT_TIMEOUT_MS = 3000;

/** `AXTextField` + `To` -> `axtextfield_to`; without AX, `text_<index>`. */
export function slotNameFor(anchor: Anchor | undefined, index: number): string {
  const ax = anchor?.ax;
  if (ax === undefined) return `text_${index}`;
  const raw = `${ax.role}_${ax.label ?? ""}`;
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean.length > 0 ? clean : `text_${index}`;
}

/**
 * Fill in `data.char` on key events from the layout in force at each event's
 * t_mono, so `groupGestures` — which is pure and unchanged — can read it.
 *
 * The consume-and-strip rule in `resolveChar` is what keeps a capital letter
 * text rather than a chord: `groupGestures` treats any surviving modifier as
 * chord-forming, so shift has to be gone by the time it looks.
 */
export function resolveKeys(
  events: readonly TraceEvent[],
  keymapAt: (tMono: number) => Keymap | undefined,
): TraceEvent[] {
  return events.map((e) => {
    if (e.kind !== "key_down" && e.kind !== "key_up") return e;
    const km = keymapAt(e.tMono);
    if (km === undefined) return e;
    const d =
      e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
    const keycode = typeof d.keycode === "number" ? d.keycode : undefined;
    if (keycode === undefined) return e;
    const mods = Array.isArray(d.modifiers)
      ? d.modifiers.filter((m): m is string => typeof m === "string")
      : [];
    const { char, modifiers } = resolveChar(km, keycode, mods);
    return {
      ...e,
      data: { ...d, modifiers, ...(char !== undefined ? { char } : {}) },
    };
  });
}

export function liftTrace(input: LiftInput): Trace {
  const prefix = input.idPrefix ?? input.sessionId;
  const sorted = [...input.events].sort((a, b) => a.tMono - b.tMono);
  const events = input.keymapAt !== undefined ? resolveKeys(sorted, input.keymapAt) : sorted;
  const boundaries = computeBoundaries(events, input.endTMono, input.dwellGapMs);

  const nodes: TraceNode[] = boundaries.map((b, i) =>
    buildNode(`${prefix}:n${i}`, b.tMono, events, input),
  );

  const edges: TraceEdge[] = [];
  const slots = new Map<string, Slot>();
  let textIndex = 0;

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!.tMono;
    const end = boundaries[i + 1]!.tMono;
    // Half-open [start, end), EXCEPT for the final span. `session_end` sits at
    // the last event by construction, so a half-open last span would put that
    // event outside every span — silently dropping the end of every recording
    // (typically a mouse_up, which then reads as a broken gesture).
    const isLast = i === boundaries.length - 2;
    const span = events.filter(
      (e) => e.tMono >= start && (isLast ? e.tMono <= end : e.tMono < end),
    );
    const { gestures, warnings } = groupGestures(span, input.gestures);

    const actions: Action[] = [];
    for (const g of gestures) {
      const action = toAction(
        g,
        input,
        nodes[i]!,
        nodes[i + 1]!,
        () => {
          const name = slotNameFor(focusedAnchor(g.tMonoStart, input), textIndex);
          textIndex += 1;
          return name;
        },
        warnings,
      );
      if (action !== undefined) actions.push(action);
      if (action?.kind === "type") {
        const existing = slots.get(action.slot);
        if (existing === undefined) {
          slots.set(action.slot, { name: action.slot, samples: [action.recorded], secret: false });
        } else if (!existing.samples.includes(action.recorded)) {
          existing.samples.push(action.recorded);
        }
      }
    }

    // A gap at or above `dwellGapMs` is cut by `computeBoundaries` into a
    // dwell_gap boundary, so it falls BETWEEN spans and never surfaces as an
    // intra-span idle gesture. That case is the canonical wait — the user paused
    // and the state then settled, which is why a boundary exists at all — so the
    // closing boundary's reason has to be read here. Intra-span idles (gaps above
    // the gesture threshold but below `dwellGapMs`) are handled above.
    if (boundaries[i + 1]!.reason === "dwell_gap") {
      const lastActivity = span.length > 0 ? span[span.length - 1]!.tMono : start;
      const until = newlyTruePredicate(nodes[i]!, nodes[i + 1]!);
      if (until === undefined) {
        warnings.push(
          `dwell gap ending at ${end} produced no newly-true predicate; wait dropped rather than emitted as a no-op`,
        );
      } else {
        actions.push({
          kind: "wait",
          until,
          timeoutMs: Math.max(MIN_WAIT_TIMEOUT_MS, Math.round((end - lastActivity) * 3)),
        });
      }
    }

    edges.push({
      id: `${prefix}:e${i}`,
      from: nodes[i]!.id,
      to: nodes[i + 1]!.id,
      actions,
      provenance: "recorded",
      observations: 1,
      outcomes: { attempts: 0, successes: 0 },
      ...(warnings.length > 0 ? { liftWarnings: warnings } : {}),
    });
  }

  return { sessionId: input.sessionId, nodes, edges, slots: [...slots.values()] };
}

function buildNode(id: string, tMono: number, events: readonly TraceEvent[], input: LiftInput): TraceNode {
  const snap = input.axAt?.(tMono);
  const ctx = focusContext(tMono, events);
  const predicates = extractPredicates(snap?.elements ?? [], ctx);
  return {
    id,
    predicates,
    // A boundary snapshot has no frame, so no visual layer. Node identity is
    // predicate-primary; visual only corroborates, so this degrades gracefully.
    ...(snap?.frameId !== undefined && snap.framePhash !== undefined
      ? { visual: { frameBlobId: snap.frameId, phash: snap.framePhash } }
      : {}),
    intervene: "select",
    observations: 1,
  };
}

/** The most recent `focus_change` at or before `tMono` supplies app/window. */
function focusContext(tMono: number, events: readonly TraceEvent[]): PredicateContext {
  let ctx: PredicateContext = {};
  for (const e of events) {
    if (e.tMono > tMono) break;
    if (e.kind !== "focus_change") continue;
    const d = e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
    ctx = {
      ...(typeof d.app === "string" ? { app: d.app } : {}),
      ...(typeof d.title === "string" ? { windowTitle: d.title } : {}),
    };
  }
  return ctx;
}

function anchorFor(point: Vec2, tMono: number, input: LiftInput): Anchor {
  const snap = input.axAt?.(tMono);
  const bounds = input.windowBoundsAt?.(tMono);
  return buildAnchor({
    point,
    displayId: input.displayIdAt?.(point, tMono) ?? "D0",
    ...(bounds !== undefined ? { windowBounds: bounds } : {}),
    ...(snap !== undefined
      ? {
          ax: snap.elements,
          ...(snap.framePhash !== undefined ? { framePhash: snap.framePhash } : {}),
        }
      : {}),
    ...(input.regionsAt !== undefined ? { regions: input.regionsAt(tMono) } : {}),
  });
}

/** Anchor of whatever had focus, used only to name a slot. */
function focusedAnchor(tMono: number, input: LiftInput): Anchor | undefined {
  const snap = input.axAt?.(tMono);
  const focused = snap?.elements.find((e) => e.focused === true);
  if (snap === undefined || focused === undefined) return undefined;
  return anchorFor({ x: focused.x + focused.w / 2, y: focused.y + focused.h / 2 }, tMono, input);
}

function toAction(
  g: Gesture,
  input: LiftInput,
  before: TraceNode,
  after: TraceNode,
  nextSlotName: () => string,
  warnings: string[],
): Action | undefined {
  switch (g.type) {
    case "click":
      return { kind: "click", anchor: anchorFor(g.point, g.tMonoStart, input), button: g.button, count: g.count };
    case "drag":
      return {
        kind: "drag",
        from: anchorFor(g.from, g.tMonoStart, input),
        to: anchorFor(g.to, g.tMonoEnd, input),
        path: fitPath(g.samples),
        button: g.button,
      };
    case "hover":
      return { kind: "hover", anchor: anchorFor(g.point, g.tMonoStart, input), dwellMs: g.dwellMs };
    case "scroll":
      return { kind: "scroll", anchor: anchorFor(g.point, g.tMonoStart, input), delta: g.delta, steps: g.steps };
    case "text":
      return { kind: "type", slot: nextSlotName(), recorded: g.text };
    case "chord":
      return { kind: "chord", keys: g.keys };
    case "idle": {
      const until = newlyTruePredicate(before, after);
      if (until === undefined) {
        warnings.push(
          `idle gap at ${g.tMonoStart} produced no newly-true predicate; wait dropped rather than emitted as a no-op`,
        );
        return undefined;
      }
      return {
        kind: "wait",
        until,
        timeoutMs: Math.max(MIN_WAIT_TIMEOUT_MS, Math.round(g.durationMs * 3)),
      };
    }
  }
}

/**
 * The first predicate true after the gap but not before. A `wait` on something
 * already true is a no-op that LOOKS like a check, which is worse than no wait
 * at all — so return undefined and let the caller warn.
 */
function newlyTruePredicate(before: TraceNode, after: TraceNode): Predicate | undefined {
  const had = new Set(before.predicates.map(predicateKey));
  const fresh = after.predicates.find((p) => !had.has(predicateKey(p)));
  if (fresh !== undefined) return fresh;
  return after.predicates.find((p) => p.kind === "ax_focused");
}
