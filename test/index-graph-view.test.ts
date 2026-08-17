import { describe, expect, it } from "vitest";
import type { IndexStageDTO } from "../app/src/shared/types.js";
import {
  CHANNEL_W,
  MIN_GUTTER,
  NODE_H,
  ROW_GAP,
  layoutStages,
  stageElapsed,
  stageTone,
} from "../app/src/renderer/src/screens/index-graph-view.js";
import { buildStageGraph } from "../app/src/main/index-graph.js";
import { initialStages } from "../app/src/main/index-queue.js";

/**
 * The ladder's geometry — the renderer's half of the split that `session-tracks`
 * and `track-view` already make: main decides what a row MEANS, this decides
 * where it is drawn.
 *
 * Reachable from the root suite only because it is `.ts` and imports nothing
 * from `api.ts`, which evaluates `window.deskrag` at module scope.
 */

const ALL_ON = { patchEmbedder: true, captioner: true, hasAudio: true, whisper: true };
const ladder = (): IndexStageDTO[] => buildStageGraph(initialStages("record", ALL_ON));

describe("layoutStages", () => {
  it("places one node per stage", () => {
    const stages = ladder();
    expect(layoutStages(stages, 500).nodes).toHaveLength(stages.length);
  });

  /**
   * Reading top to bottom IS the execution order, because `runStages` is a
   * sequential loop. A layout that let two nodes share a y would be claiming
   * they run together.
   */
  it("gives every row a distinct, increasing y", () => {
    const { nodes } = layoutStages(ladder(), 500);
    const ys = nodes.map((n) => n.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(ys.length);
    expect(ys[1]! - ys[0]!).toBe(NODE_H + ROW_GAP);
  });

  it("indents by dependency depth, and only by that", () => {
    const stages = ladder();
    const { nodes, gutter } = layoutStages(stages, 500);
    for (const n of nodes) expect(n.x).toBe(gutter + n.stage.col * 34);
    // Segmenting is a root; the search index is the deepest thing in the table.
    const seg = nodes.find((n) => n.stage.id === "segment")!;
    const idx = nodes.find((n) => n.stage.id === "searchIndex")!;
    expect(seg.x).toBeLessThan(idx.x);
  });

  it("is tall enough for its last row and no taller", () => {
    const stages = ladder();
    const { height } = layoutStages(stages, 500);
    expect(height).toBe((stages.length - 1) * (NODE_H + ROW_GAP) + NODE_H);
  });

  it("has no height at all when there is nothing to draw", () => {
    expect(layoutStages([], 500).height).toBe(0);
    expect(layoutStages([], 500).wires).toEqual([]);
  });

  it("draws one wire per declared need", () => {
    const stages = ladder();
    const expected = stages.reduce((n, s) => n + s.needs.length, 0);
    expect(layoutStages(stages, 500).wires).toHaveLength(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("keys every wire uniquely, so React never collapses two", () => {
    const { wires } = layoutStages(ladder(), 500);
    expect(new Set(wires.map((w) => w.key)).size).toBe(wires.length);
  });

  /**
   * The defect the screenshot caught and the DOM assertions did not: twenty-one
   * wires bowed into one 18px gutter drew a vertical stripe of overlap that read
   * as static. Every wire was individually correct and the picture said nothing.
   *
   * Two wires may share a channel only when their row ranges do not even TOUCH —
   * contiguous vertical segments at the same x read as one wire spanning both.
   */
  it("never lets two overlapping wires share a channel", () => {
    const stages = ladder();
    const { wires } = layoutStages(stages, 500);
    const byId = new Map(stages.map((s) => [s.id, s]));
    const spans = wires.map((w) => {
      const [from, to] = w.key.split("->");
      return { channel: w.channel, lo: byId.get(from!)!.row, hi: byId.get(to!)!.row };
    });
    for (const a of spans) {
      for (const b of spans) {
        if (a === b || a.channel !== b.channel) continue;
        expect(a.lo <= b.hi && a.hi >= b.lo, `channel ${a.channel} collides`).toBe(false);
      }
    }
  });

  it("gives every wire a distinct path", () => {
    const { wires } = layoutStages(ladder(), 500);
    expect(new Set(wires.map((w) => w.d)).size).toBe(wires.length);
  });

  /**
   * The gutter is SIZED BY the channels rather than fixed, so a wire can never
   * be routed off the left edge — which is what a fixed gutter would do the
   * moment a thirteenth stage added one more overlapping dependency.
   */
  it("widens the gutter to fit every channel, and never routes off-canvas", () => {
    const stages = ladder();
    const { wires, gutter } = layoutStages(stages, 500);
    const channels = Math.max(...wires.map((w) => w.channel)) + 1;
    expect(gutter).toBeGreaterThanOrEqual(channels * CHANNEL_W);
    for (const w of wires) {
      const xs = [...w.d.matchAll(/[ML] (-?[\d.]+) /g)].map((m) => Number(m[1]));
      for (const x of xs) expect(x, w.key).toBeGreaterThan(0);
    }
  });

  it("falls back to a minimum gutter when there are no wires", () => {
    expect(layoutStages([], 500).gutter).toBe(MIN_GUTTER);
  });

  /**
   * The first frame renders before the ResizeObserver has fired, so width is 0.
   * Nothing may come back negative or NaN — the boxes are sized from these
   * numbers, and a negative width is the kind of thing that only shows up as a
   * flash on mount.
   */
  it("survives a zero width, which is what the first frame actually has", () => {
    const layout = layoutStages(ladder(), 0);
    for (const n of layout.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    for (const w of layout.wires) expect(w.d).not.toMatch(/NaN/);
  });

  it("does not move nodes when the pane resizes — only their width changes", () => {
    const narrow = layoutStages(ladder(), 320);
    const wide = layoutStages(ladder(), 900);
    expect(wide.nodes.map((n) => [n.x, n.y])).toEqual(narrow.nodes.map((n) => [n.x, n.y]));
  });
});

describe("stageTone", () => {
  it("maps every state to a defined tone slot", () => {
    // These are the `[data-tone]` names in styles.css. A tone with no rule sets
    // no `--tone`, and every consumer reads `var(--tone, <fallback>)`, so a typo
    // here fails SILENTLY as a grey node.
    const known = new Set(["ok", "accent", "alarm", "neutral"]);
    for (const s of ["pending", "running", "done", "skipped", "failed"] as const) {
      expect(known.has(stageTone(s)), s).toBe(true);
    }
  });

  it("does not paint pending as an outcome", () => {
    expect(stageTone("pending")).toBe("neutral");
    expect(stageTone("done")).not.toBe(stageTone("failed"));
  });
});

/**
 * Half the pipeline is pure SQLite over rows already on disk. Rounding those to
 * "0s" would make eight of twelve nodes read identically and bury the two that
 * actually cost something.
 */
describe("stageElapsed", () => {
  it("says nothing for a stage that never ran", () => {
    expect(stageElapsed(null)).toBeNull();
  });

  it("reports sub-second stages in milliseconds", () => {
    expect(stageElapsed(0)).toBe("0ms");
    expect(stageElapsed(42)).toBe("42ms");
    expect(stageElapsed(999)).toBe("999ms");
  });

  it("reports seconds with one decimal", () => {
    expect(stageElapsed(1000)).toBe("1.0s");
    expect(stageElapsed(18_200)).toBe("18.2s");
  });

  it("reports minutes for the stages that take them", () => {
    expect(stageElapsed(60_000)).toBe("1m 00s");
    expect(stageElapsed(605_000)).toBe("10m 05s");
  });

  /**
   * "4m 60s" — printed by the real Frame patches stage, at 299.6s, in the
   * running app. Rounding the seconds remainder separately from the minutes
   * lets it carry to 60 and never roll over. Every test above passed: none of
   * them happened to land in the last half-second of a minute, which is a
   * one-in-120 window and exactly why the screenshot found it first.
   */
  it("rolls a rounded-up remainder into the minute instead of printing 60s", () => {
    expect(stageElapsed(299_600)).toBe("5m 00s");
    expect(stageElapsed(119_500)).toBe("2m 00s");
    // Still under a minute, so still the seconds branch — the rollover applies
    // to the minutes format only.
    expect(stageElapsed(59_600)).toBe("59.6s");
    for (let ms = 60_000; ms < 3_600_000; ms += 97) {
      expect(stageElapsed(ms), `${ms}ms`).not.toMatch(/\b60s$/);
    }
  });
});
