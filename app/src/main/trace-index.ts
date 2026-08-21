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
 *
 * It is also where THE RECORDER IS TAKEN OUT OF THE RECORDING. A session is
 * started and stopped from an application, so every recording is bracketed by
 * it; `excludeFocusedApps` drops those stretches before anything is lifted. That
 * this happens here rather than in `graph-view.ts` is the point — lifting reads
 * rows already on disk, so `rebuildGraph` applies the rule to recordings already
 * taken, where a read-time filter would relabel the routes and leave the cards
 * and the skill steps behind.
 */

import {
  displayIdAt,
  excludeFocusedApps,
  liftTrace,
  mergeTrace,
  type AxSnapshot,
  type DisplayInfo,
  type DualStore,
  type ExcludedFocus,
  type Graph,
  type Keymap,
  type RegionsAtFrame,
  type Trace,
  type TraceEvent,
} from "deskrag";

/** The graph every session merges into. One per install, for now. */
export const DEFAULT_GRAPH_ID = "default";

/** A `t_mono`-stamped environment fact, newest-last. */
export interface Timeline<T> {
  tMono: number;
  value: T;
}

/** Latest at-or-before `tMono`, or undefined if nothing precedes it. */
export function latestAt<T>(timeline: readonly Timeline<T>[], tMono: number): T | undefined {
  let found: T | undefined;
  for (const entry of timeline) {
    if (entry.tMono > tMono) break;
    found = entry.value;
  }
  return found;
}

const asRecord = (d: unknown): Record<string, unknown> =>
  d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};

/**
 * Build the environment timelines from the session's own event stream. Exported
 * because the digest resolves typed text against the SAME keymap timeline —
 * building a second one is how the two would come to disagree.
 */
export function environmentOf(events: readonly TraceEvent[]): {
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
  /** Events dropped as the recorder's own. Disclosure, following `missingKeymap`. */
  excludedEvents: number;
  /** Which applications those were, first-seen order. */
  excludedApps: string[];
}

/** One session lifted, before anything is merged or written. */
export interface LiftedSession {
  trace: Trace;
  /** No `keymap_change` event, so every keystroke was discarded. */
  missingKeymap: boolean;
  /** Events dropped as the recorder's own, and which applications they were. */
  excludedEvents: number;
  excludedApps: string[];
}

/**
 * Whether a `focus_change` names something the graph should leave out.
 *
 * Injected rather than read from settings here, for the reason every callback in
 * this file is injected: `liftSession` is reachable from a rebuild, from the
 * per-session stage and from a probe, and each of them holds the setting already.
 */
export type IsExcludedApp = (focus: ExcludedFocus) => boolean;

/**
 * Lift one session into a `Trace`, touching no graph and writing nothing.
 *
 * Split out from `indexTrace` so a rebuild can merge many sessions into a fresh
 * graph without each one reading back the partially-rebuilt result.
 *
 * Returns undefined when the session produced no events at all — an empty
 * recording should not create a node.
 */
export function liftSession(
  store: DualStore,
  sessionId: string,
  isExcluded?: IsExcludedApp,
): LiftedSession | undefined {
  const all = store.getEventsBySession(sessionId) as unknown as TraceEvent[];
  // The recorder's own stretches, gone — before boundaries, before gestures,
  // before anything reads a focus. A recording that never left the recorder
  // empties here and correctly produces no node.
  const excluded =
    isExcluded === undefined
      ? { events: all, dropped: 0, apps: [] as string[] }
      : excludeFocusedApps(all, isExcluded);
  const events = excluded.events;
  if (events.length === 0) return undefined;

  // BOTH ends come from what SURVIVED. The left edge especially: pinned at zero
  // it manufactures a boundary before every remaining event, with no focus, no
  // AX and no keyframe behind it — the `n0 — no state` card.
  const startTMono = events[0]!.tMono;
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

  /**
   * The keyframe that best SHOWS the state at a boundary: the nearer of the
   * first frame at-or-after and the latest at-or-before, ties to at-or-after.
   *
   * `frameAt` above is at-or-before and stays that way — a click landed on the
   * screen as it was. A NODE is the settled state AFTER its boundary, so
   * at-or-before hands its card the OUTGOING application's screen: the same
   * off-by-one that paired every focus_change node with the previous app's AX
   * tree until `getAxForBoundary` was introduced (measured at 54% of nodes).
   *
   * Nearest rather than strictly at-or-after, because the two boundary kinds
   * differ. A focus change IS a visual change, so `mpdecimate` keeps a frame
   * right after it; a dwell-gap boundary on a settled screen may have no
   * following frame for minutes, and reaching forward to the NEXT state would be
   * a worse lie than reaching back to this one.
   */
  const visualAt = (tMono: number): { frameId: string; framePhash: string } | undefined => {
    const before = frameAt(tMono);
    const after = frames.find((f) => f.tMono >= tMono);
    const pick =
      after === undefined
        ? before
        : before === undefined
          ? after
          : after.tMono - tMono <= tMono - before.tMono
            ? after
            : before;
    return pick === undefined
      ? undefined
      : { frameId: pick.id, framePhash: pick.phash.toString(16) };
  };

  const trace = liftTrace({
    sessionId,
    events,
    startTMono,
    endTMono,

    axAt: (tMono): AxSnapshot | undefined => {
      // Prefer the walk taken FOR this boundary. A boundary walk is written
      // after its boundary (settle delay + walk budget), so the "latest
      // at-or-before" fallback returns whatever was on screen BEFORE the
      // boundary — which paired every focus_change node with the outgoing app's
      // AX tree while its app/window predicates named the incoming one.
      const snap = store.getAxForBoundary(sessionId, tMono) ?? store.getAxAt(sessionId, tMono);
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

    visualAt,

    keymapAt: (tMono) => latestAt(keymaps, tMono),
    windowBoundsAt: (tMono) => latestAt(bounds, tMono),
    displayIdAt: (p, tMono) => displayIdAt(latestAt(displays, tMono) ?? [], p),
  });

  return {
    trace,
    missingKeymap: keymaps.length === 0,
    excludedEvents: excluded.dropped,
    excludedApps: excluded.apps,
  };
}

const actionsIn = (trace: Trace): number => trace.edges.reduce((n, e) => n + e.actions.length, 0);

/**
 * mergeTrace seeds a NEW graph's id from the session it was lifted from; pin it
 * so every session accretes into the one install graph rather than producing one
 * graph per recording.
 */
async function mergeInto(existing: Graph | undefined, trace: Trace): Promise<Graph> {
  const merged = await mergeTrace(existing, trace);
  return { ...merged, id: DEFAULT_GRAPH_ID };
}

const summarize = (
  graph: Graph,
  actions: number,
  missingKeymap: boolean,
  excludedEvents: number,
  excludedApps: string[],
): TraceIndexResult => ({
  nodes: graph.nodes.length,
  edges: graph.edges.length,
  variables: graph.slots.filter((s) => s.samples.length > 1).length,
  actions,
  missingKeymap,
  excludedEvents,
  excludedApps,
});

/**
 * Lift one session and merge it into the install's graph. The incremental path,
 * run as the last stage of indexing a fresh recording.
 */
export async function indexTrace(
  store: DualStore,
  sessionId: string,
  isExcluded?: IsExcludedApp,
): Promise<TraceIndexResult | undefined> {
  const lifted = liftSession(store, sessionId, isExcluded);
  if (lifted === undefined) return undefined;
  const graph = await mergeInto(store.getGraph(DEFAULT_GRAPH_ID), lifted.trace);
  await store.putGraph(graph);
  return summarize(
    graph,
    actionsIn(lifted.trace),
    lifted.missingKeymap,
    lifted.excludedEvents,
    lifted.excludedApps,
  );
}

export interface RebuildResult extends TraceIndexResult {
  /** Sessions that produced a trace and were merged. */
  sessions: number;
  /**
   * Sessions that produced no node. Empty recordings, and — since the recorder
   * is filtered out before lifting — recordings that never left it.
   */
  skipped: number;
}

/**
 * Rebuild the whole graph by re-lifting every session, oldest first.
 *
 * **This is a rebuild rather than a per-session re-lift, and that is forced.**
 * A graph accretes: `mergeTrace` folds a session into what is already there,
 * incrementing `observations` and appending slot samples. Re-lifting one session
 * into a graph that already contains it would count it twice — inflating the
 * evidence behind every edge it touches and corrupting exactly the counts
 * `edgeCost` uses to choose a path. So the only correct re-index discards the
 * graph and replays every session in its original order.
 *
 * Nothing is re-recorded: lifting reads `ax_snapshot` and the event stream,
 * which are already on disk. That is what makes a corrected predicate filter or
 * lift rule applicable to recordings already taken.
 *
 * One `putGraph` at the end, never per session. It is delete-then-insert, so a
 * partial rebuild would leave the store holding a graph that describes fewer
 * sessions than it claims; writing once means a failure mid-rebuild leaves the
 * previous graph intact.
 */
export async function rebuildGraph(
  store: DualStore,
  onProgress?: (done: number, total: number, sessionId: string) => void,
  isExcluded?: IsExcludedApp,
): Promise<RebuildResult> {
  // Oldest first, so the rebuilt graph accretes in the same order the
  // incremental path produced it. Merge order decides which node a revisited
  // state collapses into, so replaying out of order would not reproduce it.
  const sessions = [...store.listSessions()].sort((a, b) => a.startedAt - b.startedAt);

  let graph: Graph | undefined;
  let actions = 0;
  let merged = 0;
  let skipped = 0;
  let missingKeymap = false;
  let excludedEvents = 0;
  const excludedApps: string[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    onProgress?.(i, sessions.length, session.id);
    const lifted = liftSession(store, session.id, isExcluded);
    if (lifted === undefined) {
      skipped++;
      continue;
    }
    actions += actionsIn(lifted.trace);
    missingKeymap = missingKeymap || lifted.missingKeymap;
    excludedEvents += lifted.excludedEvents;
    for (const a of lifted.excludedApps) if (!excludedApps.includes(a)) excludedApps.push(a);
    graph = await mergeInto(graph, lifted.trace);
    merged++;
  }

  onProgress?.(sessions.length, sessions.length, "");

  // Every session was empty. Writing an empty graph would be a destructive act
  // dressed as a no-op, so leave whatever is on disk alone and say nothing was
  // rebuilt — the caller reports `sessions: 0`.
  if (graph === undefined) {
    return {
      nodes: 0,
      edges: 0,
      variables: 0,
      actions: 0,
      missingKeymap,
      excludedEvents,
      excludedApps,
      sessions: 0,
      skipped,
    };
  }

  await store.putGraph(graph);
  return {
    ...summarize(graph, actions, missingKeymap, excludedEvents, excludedApps),
    sessions: merged,
    skipped,
  };
}
