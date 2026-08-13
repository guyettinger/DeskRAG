import { describe, expect, it } from "vitest";
import {
  buildOutline,
  renderOutline,
  type OutlineInput,
  type OutlineSegment,
} from "../app/src/main/mcp/outline.js";

const seg = (
  id: string,
  granularity: string,
  tMonoStart: number,
  tMonoEnd: number,
  extra: Partial<OutlineSegment> = {},
): OutlineSegment => ({
  id,
  granularity,
  tMonoStart,
  tMonoEnd,
  digest: null,
  caption: null,
  ...extra,
});

/**
 * A recording composed all the way up: session → process → task → action.
 *
 *   root ─ p1 ─ t1 ─ a1, a2
 *        └ p1 ─ t2 ─ a3
 */
function fullLadder(): OutlineInput {
  return {
    segments: [
      seg("root", "session", 0, 8000),
      seg("p1", "level:2", 0, 8000),
      seg("t1", "level:1", 0, 4000),
      seg("t2", "level:1", 4000, 8000),
      seg("a1", "action", 0, 1000, { caption: "the calculator, showing 7" }),
      seg("a2", "action", 1000, 4000, { digest: "clicked Add" }),
      seg("a3", "action", 4000, 8000, { caption: "TextEdit with a note open" }),
    ],
    summaries: new Map([
      ["root", { text: "Add some numbers, then write them down", source: "llm" }],
      ["p1", { text: "Doing the arithmetic", source: "llm" }],
      ["t1", { text: "Add numbers from 1 to 6", source: "llm" }],
      ["t2", { text: "Write the total into a note", source: "template" }],
    ]),
    children: new Map([
      ["root", ["p1"]],
      ["p1", ["t1", "t2"]],
      ["t1", ["a1", "a2"]],
      ["t2", ["a3"]],
    ]),
    laneOrigin: 0,
  };
}

describe("buildOutline", () => {
  it("walks the ladder depth-first and names each row by its OWN level", () => {
    const out = buildOutline(fullLadder());
    expect(out.composed).toBe(true);
    expect(out.nodes.map((n) => [n.id, n.level, n.depth])).toEqual([
      ["root", "session", 0],
      ["p1", "process", 1],
      ["t1", "task", 2],
      ["a1", "action", 3],
      ["a2", "action", 3],
      ["t2", "task", 2],
      ["a3", "action", 3],
    ]);
  });

  it("takes a composed row's text from its summary and carries the source", () => {
    const out = buildOutline(fullLadder());
    const t2 = out.nodes.find((n) => n.id === "t2");
    // `template` vs `llm` travels with the text everywhere else in this app: it
    // is what stops a structurally-composed hierarchy reading as a summarized
    // one, and an agent weighing evidence needs it more than a skimming reader.
    expect(t2).toMatchObject({ text: "Write the total into a note", source: "template" });
  });

  it("prefers an action's caption over its digest — the VLM saw the pixels", () => {
    const out = buildOutline(fullLadder());
    expect(out.nodes.find((n) => n.id === "a1")?.text).toBe("the calculator, showing 7");
    expect(out.nodes.find((n) => n.id === "a2")?.text).toBe("clicked Add");
    // An action's text is its own; there is no summary row behind it to source.
    expect(out.nodes.find((n) => n.id === "a1")?.source).toBeNull();
  });

  it("measures seconds from the lane origin, not from t_mono zero", () => {
    // Capture runs while ffmpeg is still spawning — measured 450-1800ms of
    // pre-roll on real recordings — so lane offset 0 is the video's first frame.
    const input = { ...fullLadder(), laneOrigin: 1000 };
    const out = buildOutline(input);
    expect(out.nodes.find((n) => n.id === "a2")).toMatchObject({ startSec: 0, endSec: 3 });
  });
});

describe("buildOutline — elision", () => {
  it("prints an action hanging directly off the root at the depth it actually has", () => {
    // A node that would hold exactly one child is dissolved, so an edge can span
    // two levels. On the 286-action recording 33% of actions are direct children
    // of the session root; a formatter that assumed depth would misreport them.
    const out = buildOutline({
      segments: [
        seg("root", "session", 0, 3000),
        seg("t1", "level:1", 0, 2000),
        seg("a1", "action", 0, 2000, { digest: "typed a note" }),
        seg("a9", "action", 2000, 3000, { digest: "closed the window" }),
      ],
      summaries: new Map([
        ["root", { text: "Take a note", source: "llm" }],
        ["t1", { text: "Write it", source: "llm" }],
      ]),
      children: new Map([
        ["root", ["t1", "a9"]],
        ["t1", ["a1"]],
      ]),
      laneOrigin: 0,
    });
    expect(out.nodes.map((n) => [n.id, n.level, n.depth])).toEqual([
      ["root", "session", 0],
      ["t1", "task", 1],
      ["a1", "action", 2],
      ["a9", "action", 1],
    ]);
  });

  it("handles a session with no Process level at all", () => {
    // Process is model-only: a default install with no summarizer produces
    // Action -> Task -> Session and no phases. The tree is flatter, never absent.
    const out = buildOutline({
      segments: [
        seg("root", "session", 0, 2000),
        seg("t1", "level:1", 0, 2000),
        seg("a1", "action", 0, 2000, { digest: "clicked" }),
      ],
      summaries: new Map([
        ["root", { text: "A short recording", source: "template" }],
        ["t1", { text: "Click something", source: "template" }],
      ]),
      children: new Map([
        ["root", ["t1"]],
        ["t1", ["a1"]],
      ]),
      laneOrigin: 0,
    });
    expect(out.nodes.map((n) => n.level)).toEqual(["session", "task", "action"]);
  });
});

describe("buildOutline — recordings with no hierarchy", () => {
  it("reports a MISSING ROOT as never-composed rather than inventing a shape", () => {
    // `composeLadder` writes a root on every run where composing executed at
    // all, even a one-action session. So a root's ABSENCE marks a recording
    // indexed before the compose stage — exactly as `session_clock`'s absence
    // marks a pre-calibration one. Presenting its flat action list as a
    // hierarchy would assert a grouping no model ever made.
    const out = buildOutline({
      segments: [
        seg("a1", "action", 0, 1000, { digest: "clicked Add" }),
        seg("a2", "action", 1000, 2000, { digest: "typed 42" }),
      ],
      summaries: new Map(),
      children: new Map(),
      laneOrigin: 0,
    });
    expect(out.composed).toBe(false);
    expect(out.reason).toMatch(/never composed|re-?index/i);
    // The actions are still worth returning — flat, and labelled flat.
    expect(out.nodes.map((n) => [n.id, n.depth])).toEqual([
      ["a1", 0],
      ["a2", 0],
    ]);
    expect(renderOutline(out)).toMatch(/never composed/i);
  });

  it("says so for a session with no segments at all", () => {
    const out = buildOutline({
      segments: [],
      summaries: new Map(),
      children: new Map(),
      laneOrigin: 0,
    });
    expect(out.composed).toBe(false);
    expect(out.nodes).toEqual([]);
    expect(out.reason).toBeTruthy();
  });
});

describe("buildOutline — malformed trees", () => {
  it("surfaces segments unreachable from the root instead of dropping them", () => {
    const out = buildOutline({
      segments: [
        seg("root", "session", 0, 2000),
        seg("a1", "action", 0, 1000, { digest: "reachable" }),
        seg("a2", "action", 1000, 2000, { digest: "orphaned" }),
      ],
      summaries: new Map([["root", { text: "Something", source: "llm" }]]),
      children: new Map([["root", ["a1"]]]),
      laneOrigin: 0,
    });
    // Silently omitting it would make the outline disagree with the rail and
    // with every count the app reports, with nothing saying why.
    expect(out.orphans.map((n) => n.id)).toEqual(["a2"]);
    expect(renderOutline(out)).toMatch(/orphan/i);
  });

  it("terminates on a cycle rather than recursing forever", () => {
    const out = buildOutline({
      segments: [
        seg("root", "session", 0, 2000),
        seg("t1", "level:1", 0, 2000),
      ],
      summaries: new Map(),
      children: new Map([
        ["root", ["t1"]],
        ["t1", ["root"]],
      ]),
      laneOrigin: 0,
    });
    expect(out.nodes.map((n) => n.id)).toEqual(["root", "t1"]);
  });
});

describe("renderOutline", () => {
  it("indents by depth and stamps every row with its own span", () => {
    const text = renderOutline(buildOutline(fullLadder()));
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/SESSION/);
    expect(lines[0]).toMatch(/Add some numbers/);
    // Two spaces per level, so a reader can see the shape at a glance.
    expect(lines[1]).toMatch(/^ {2}\S/);
    expect(lines[2]).toMatch(/^ {4}\S/);
    expect(lines[3]).toMatch(/^ {6}\S/);
    expect(text).toMatch(/0:00\.0/);
    expect(text).toMatch(/0:08\.0/);
  });

  it("marks a template summary so a reader can discount it", () => {
    expect(renderOutline(buildOutline(fullLadder()))).toMatch(/template/);
  });
});
