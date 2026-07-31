/**
 * Trace indexing — the stage that turns a recorded session into a graph.
 *
 * `liftTrace` takes its world through injected callbacks so `src/trace/` can stay
 * a leaf that never imports the store. This module is where those callbacks are
 * actually bound to one, and it is the only place that knows both.
 *
 * The environment callbacks (`keymapAt`, `displayIdAt`, `windowBoundsAt`) all
 * follow one rule — **latest at-or-before the t_mono** — because display topology
 * and keyboard layout are recorded as events precisely so they can change
 * mid-session. Resolving against the wrong one is a silent corruption: a
 * coordinate attributed to the wrong display, text decoded with the wrong layout.
 *
 * A graph accretes across sessions: each lift is merged into the existing graph
 * rather than replacing it, which is what makes a second recording of the same
 * task produce a branch (or fill a slot) instead of a second disconnected chain.
 */

import {
  displayIdAt,
  liftTrace,
  mergeTrace,
  type AxSnapshot,
  type DisplayInfo,
  type DualStore,
  type Graph,
  type Keymap,
  type RegionsAtFrame,
  type TraceEvent,
} from "deskrag";

/** The graph every session merges into. One per install, for now. */
export const DEFAULT_GRAPH_ID = "default";

/** A `t_mono`-stamped environment fact, newest-last. */
interface Timeline<T> {
  tMono: number;
  value: T;
}

/** Latest at-or-before `tMono`, or undefined if nothing precedes it. */
function latestAt<T>(timeline: readonly Timeline<T>[], tMono: number): T | undefined {
  let found: T | undefined;
  for (const entry of timeline) {
    if (entry.tMono > tMono) break;
    found = entry.value;
  }
  return found;
}

const asRecord = (d: unknown): Record<string, unknown> =>
  d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};

/** Build the environment timelines from the session's own event stream. */
function environmentOf(events: readonly TraceEvent[]): {
  keymaps: Timeline<Keymap>[];
  displays: Timeline<DisplayInfo[]>[];
  bounds: Timeline<{ x: number; y: number; w: number; h: number }>[];
} {
  const keymaps: Timeline<Keymap>[] = [];
  const displays: Timeline<DisplayInfo[]>[] = [];
  const bounds: Timeline<{ x: number; y: number; w: number; h: number }>[] = [];

  for (const e of events) {
    const d = asRecord(e.data);
    if (e.kind === "keymap_change") {
      const km = d as unknown as Keymap;
      if (typeof km.layoutId === "string" && km.entries !== undefined) {
        keymaps.push({ tMono: e.tMono, value: km });
      }
    } else if (e.kind === "display_change") {
      if (Array.isArray(d.displays)) {
        displays.push({ tMono: e.tMono, value: d.displays as DisplayInfo[] });
      }
    } else if (e.kind === "focus_change") {
      const b = asRecord(d.bounds);
      if (
        typeof b.x === "number" &&
        typeof b.y === "number" &&
        typeof b.w === "number" &&
        typeof b.h === "number"
      ) {
        bounds.push({ tMono: e.tMono, value: { x: b.x, y: b.y, w: b.w, h: b.h } });
      }
    }
  }
  return { keymaps, displays, bounds };
}

export interface TraceIndexResult {
  /** Nodes and edges in the graph AFTER merging this session in. */
  nodes: number;
  edges: number;
  /** Slots with more than one observed value — the discovered variables. */
  variables: number;
  /** Actions lifted from this session alone. */
  actions: number;
  /** True when no keymap was ever captured, so typed text could not resolve. */
  missingKeymap: boolean;
}

/**
 * Lift one session and merge it into the install's graph.
 *
 * Returns undefined when the session produced no events at all — an empty
 * recording should not create a node.
 */
export async function indexTrace(
  store: DualStore,
  sessionId: string,
): Promise<TraceIndexResult | undefined> {
  const events = store.getEventsBySession(sessionId) as unknown as TraceEvent[];
  if (events.length === 0) return undefined;

  const endTMono = events[events.length - 1]!.tMono;
  const { keymaps, displays, bounds } = environmentOf(events);

  // Frames, newest-last, so a t_mono can find the keyframe that was current.
  const frames = store.getFramesBySession(sessionId);
  const frameAt = (tMono: number): (typeof frames)[number] | undefined => {
    let found: (typeof frames)[number] | undefined;
    for (const f of frames) {
      if (f.tMono > tMono) break;
      found = f;
    }
    return found;
  };

  const trace = liftTrace({
    sessionId,
    events,
    endTMono,

    axAt: (tMono): AxSnapshot | undefined => {
      const snap = store.getAxAt(sessionId, tMono);
      if (snap === undefined) return undefined;
      // A boundary snapshot has no frame, so no pHash to corroborate with. The
      // node still carries its predicates, which are what identity keys on.
      const frame = snap.frameId !== null ? store.getFrame(snap.frameId) : undefined;
      return {
        elements: snap.elements,
        ...(snap.frameId !== null ? { frameId: snap.frameId } : {}),
        ...(frame !== undefined ? { framePhash: frame.phash.toString(16) } : {}),
      };
    },

    // Regions AND the pHash of the frame they came from, as one value. Most AX
    // snapshots are boundary-triggered and carry no frame, so taking the pHash
    // from the snapshot instead left the visual anchor layer absent almost
    // everywhere despite regions being available right here.
    regionsAt: (tMono): RegionsAtFrame | undefined => {
      const frame = frameAt(tMono);
      if (frame === undefined) return undefined;
      return {
        frameId: frame.id,
        framePhash: frame.phash.toString(16),
        regions: store.getRegionsByFrame(frame.id).map((r) => ({
          id: r.id,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
        })),
      };
    },

    keymapAt: (tMono) => latestAt(keymaps, tMono),
    windowBoundsAt: (tMono) => latestAt(bounds, tMono),
    displayIdAt: (p, tMono) => displayIdAt(latestAt(displays, tMono) ?? [], p),
  });

  const existing = store.getGraph(DEFAULT_GRAPH_ID);
  const merged = await mergeTrace(existing, trace);
  // mergeTrace seeds a new graph's id from the session; pin it so every session
  // accretes into the same graph rather than one graph per recording.
  const graph: Graph = { ...merged, id: DEFAULT_GRAPH_ID };
  await store.putGraph(graph);

  const actions = trace.edges.reduce((n, e) => n + e.actions.length, 0);
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    variables: graph.slots.filter((s) => s.samples.length > 1).length,
    actions,
    missingKeymap: keymaps.length === 0,
  };
}
