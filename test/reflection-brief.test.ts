import { describe, expect, it } from "vitest";
import { reflectionBriefFor } from "../app/src/main/reflection-brief.js";
import type { EventRow, SegmentRow } from "../src/store/types.js";

/**
 * What a reflection is written OVER, decided with no store and no model.
 *
 * Three of the decisions here are not obvious from the type, and each is a way
 * the note goes wrong quietly: reflecting over actions instead of composed
 * steps gives a list too long to judge; reflecting over ONE step gives a note
 * that restates it and still costs a model call; and a step elided down to a
 * leaf has no summary row at all, so falling back to its digest is the
 * difference between a named step and "(unnamed step)".
 */

const seg = (over: Partial<SegmentRow> & { id: string }): SegmentRow => ({
  sessionId: "s1",
  granularity: "action",
  tMonoStart: 0,
  tMonoEnd: 1000,
  boundaryReason: null,
  transcript: null,
  digest: null,
  caption: null,
  ...over,
});

const ROOT = seg({ id: "root", granularity: "session", tMonoStart: 0, tMonoEnd: 600_000 });

interface World {
  segments: SegmentRow[];
  children: Record<string, string[]>;
  leaves: Record<string, string[]>;
  summaries: Map<string, string>;
  events: EventRow[];
}

const world = (over: Partial<World> = {}) => {
  const w: World = {
    segments: [
      ROOT,
      seg({ id: "a", granularity: "level:1", tMonoStart: 0, tMonoEnd: 60_000 }),
      seg({ id: "b", granularity: "level:1", tMonoStart: 60_000, tMonoEnd: 600_000 }),
    ],
    children: { root: ["a", "b"] },
    leaves: { a: ["l1", "l2"], b: ["l3"] },
    summaries: new Map([
      ["root", "prepare the release notes"],
      ["a", "read the changelog"],
      ["b", "hunt for the issue numbers"],
    ]),
    events: [],
    ...over,
  };
  return reflectionBriefFor({
    segments: w.segments,
    summaries: w.summaries,
    childrenOf: (id) => w.children[id] ?? [],
    leavesOf: (id) => w.leaves[id] ?? [id],
    events: w.events,
    // Constructed in LOCAL time on purpose: the note is headed with the day the
    // user recorded on, so this assertion has to hold in every timezone.
    recordedAt: new Date(2026, 7, 19, 14, 0, 0).getTime(),
  });
};

describe("reflectionBriefFor", () => {
  it("reads the composed root's children as the steps, in time order", () => {
    const b = world()!;
    expect(b.purpose).toBe("prepare the release notes");
    expect(b.steps.map((s) => s.name)).toEqual([
      "read the changelog",
      "hunt for the issue numbers",
    ]);
    expect(b.steps.map((s) => s.actions)).toEqual([2, 1]);
  });

  it("puts the steps in time order however the tree hands them back", () => {
    const b = world({ children: { root: ["b", "a"] } })!;
    expect(b.steps[0]!.name).toBe("read the changelog");
  });

  it("speaks seconds, because t_mono is milliseconds", () => {
    const b = world()!;
    expect(b.durationSec).toBe(600);
    expect(b.steps.map((s) => s.seconds)).toEqual([60, 540]);
  });

  /**
   * `composeLadder` ADOPTS a lone child rather than wrapping it, so a leaf can
   * hang directly off the root — and a leaf never has a summary row. Its digest
   * is right there.
   */
  it("names an elided leaf from its digest when it has no summary", () => {
    const b = world({
      segments: [
        ROOT,
        seg({ id: "a", granularity: "level:1", tMonoEnd: 60_000 }),
        seg({ id: "b", tMonoStart: 60_000, tMonoEnd: 600_000, digest: "clicked Save in TextEdit" }),
      ],
      summaries: new Map([["a", "read the changelog"]]),
    })!;
    expect(b.steps[1]!.name).toBe("clicked Save in TextEdit");
    expect(b.purpose).toBeNull();
  });

  it("falls back to a placeholder only when there is neither summary nor digest", () => {
    const b = world({ summaries: new Map([["root", "x"], ["a", "read the changelog"]]) })!;
    expect(b.steps[1]!.name).toBe("(unnamed step)");
  });

  /**
   * Null is a real answer. A note over one step can only restate it, and a
   * recording that was never composed has no root to hang one off.
   */
  it("declines a session composed into fewer than two steps", () => {
    expect(world({ children: { root: ["a"] } })).toBeNull();
    expect(world({ children: {} })).toBeNull();
  });

  it("declines a recording that was never composed", () => {
    expect(world({ segments: [seg({ id: "a" }), seg({ id: "b" })] })).toBeNull();
  });

  it("lists applications in the order they were first reached, once each", () => {
    const ev = (tMono: number, app: string): EventRow => ({
      id: `e${tMono}`,
      sessionId: "s1",
      tMono,
      kind: "focus_change",
      x: null,
      y: null,
      data: { app },
    });
    const b = world({
      events: [
        ev(300, "Google Chrome"),
        ev(100, "Ghostty"),
        ev(500, "Ghostty"),
        { ...ev(700, "ignored"), kind: "click" },
      ],
    })!;
    expect(b.apps).toEqual(["Ghostty", "Google Chrome"]);
  });

  it("dates the note by the recording, not by the indexing run", () => {
    expect(world()!.recordedOn).toBe("2026-08-19");
  });
});
