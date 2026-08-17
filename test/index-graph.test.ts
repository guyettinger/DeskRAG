import { describe, expect, it } from "vitest";
import {
  INDEX_STAGES,
  stageOrderViolations,
  type StageFacts,
  type StageId,
} from "../app/src/main/index-plan.js";
import { initialStages } from "../app/src/main/index-queue.js";
import { STAGE_COLUMNS, buildStageGraph } from "../app/src/main/index-graph.js";

/**
 * The stage ladder is a PROJECTION of the plan table, so the test's job is to
 * pin the two things a projection can get wrong: that it shows everything, and
 * that its geometry does not assert something false.
 *
 * The false thing it could assert is concurrency. `runStages` is a strictly
 * sequential loop; a free DAG layout would put Captions, Transcribing and Frame
 * patches side by side, because all three depend only on Segmenting. Hence: row
 * is execution order, column is depth.
 */

const ALL_ON: StageFacts = {
  patchEmbedder: true,
  captioner: true,
  hasAudio: true,
  whisper: true,
};
const DEFAULT_INSTALL: StageFacts = {
  patchEmbedder: false,
  captioner: false,
  hasAudio: true,
  whisper: true,
};

const ladder = (facts: StageFacts = ALL_ON) => buildStageGraph(initialStages("record", facts));

describe("buildStageGraph", () => {
  it("draws every stage in the table, exactly once", () => {
    const nodes = ladder();
    expect(nodes).toHaveLength(INDEX_STAGES.length);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(INDEX_STAGES.length);
  });

  /**
   * The array IS the order. Deriving it from `needs` instead would be wrong in
   * a way nothing fails on: `trace` has depth 2 and runs LAST.
   */
  it("rows follow the plan table, not the dependency depth", () => {
    const nodes = ladder();
    expect(nodes.map((n) => n.id)).toEqual(INDEX_STAGES.map((s) => s.id));
    expect(nodes.map((n) => n.row)).toEqual(nodes.map((_, i) => i));

    const trace = nodes.find((n) => n.id === "trace")!;
    expect(trace.row, "trace runs last").toBe(nodes.length - 1);
    expect(trace.col, "but sits shallow in the dependency graph").toBeLessThan(
      nodes.find((n) => n.id === "searchIndex")!.col,
    );
  });

  /**
   * The invariant that makes the drawing tractable: every wire points downward,
   * so nothing doubles back and the renderer needs no back-edge case. It holds
   * because `stageOrderViolations` is empty, which is checked here too — if that
   * ever stopped being true, this is the drawing that would start lying.
   */
  it("every wire points at a strictly smaller row", () => {
    expect(stageOrderViolations(INDEX_STAGES.map((s) => s.id))).toEqual([]);
    const nodes = ladder();
    const rowOf = new Map(nodes.map((n) => [n.id, n.row]));
    for (const n of nodes) {
      for (const need of n.needs) {
        expect(rowOf.get(need), `${n.id} -> ${need}`).toBeLessThan(n.row);
      }
    }
  });

  it("never draws a wire to a stage that is not on this ladder", () => {
    const ids = new Set(ladder().map((n) => n.id));
    for (const n of ladder()) for (const need of n.needs) expect(ids.has(need)).toBe(true);

    // A trace rebuild is one node, and `trace` declares three needs — none of
    // which are present. A wire into mid-air is the defect being avoided.
    const rebuild = buildStageGraph(initialStages("trace-rebuild", ALL_ON));
    expect(rebuild).toHaveLength(1);
    expect(rebuild[0]!.needs).toEqual([]);
  });

  /**
   * A gate must not move the ladder. Two runs of the same pipeline under
   * different settings have to READ as the same pipeline, or the difference the
   * screen exists to show — which stages were skipped — is drowned out by the
   * whole shape changing.
   */
  it("keeps its geometry when a gate removes a stage", () => {
    const full = ladder(ALL_ON);
    const lean = ladder(DEFAULT_INSTALL);
    expect(lean.map((n) => [n.id, n.row, n.col])).toEqual(full.map((n) => [n.id, n.row, n.col]));
    expect(lean.filter((n) => n.state === "skipped").map((n) => n.id)).toEqual([
      "framePatches",
      "captions",
      "appCaptions",
    ]);
  });

  it("carries each skipped stage's reason onto its node", () => {
    const by = new Map(ladder(DEFAULT_INSTALL).map((n) => [n.id, n]));
    expect(by.get("captions")!.detail).toMatch(/captioner/i);
    expect(by.get("framePatches")!.detail).toMatch(/image model/i);
  });

  it("reports no elapsed time for a stage that has not started", () => {
    for (const n of ladder()) expect(n.elapsedMs).toBeNull();
  });

  it("measures a finished stage from its own stamps", () => {
    const stages = initialStages("record", ALL_ON).map((s) =>
      s.id === "segment"
        ? { ...s, state: "done" as const, startedAt: 1_000, endedAt: 1_450 }
        : s,
    );
    const seg = buildStageGraph(stages).find((n) => n.id === "segment")!;
    expect(seg.elapsedMs).toBe(450);
  });

  it("measures a running stage against now, so its timer moves", () => {
    const stages = initialStages("record", ALL_ON).map((s) =>
      s.id === "segment" ? { ...s, state: "running" as const, startedAt: Date.now() - 200 } : s,
    );
    const seg = buildStageGraph(stages).find((n) => n.id === "segment")!;
    expect(seg.elapsedMs).toBeGreaterThanOrEqual(200);
  });

  it("labels every node — a blank node is not a node", () => {
    for (const n of ladder()) expect(n.label.length).toBeGreaterThan(0);
  });

  it("exposes a column count wide enough for every node", () => {
    expect(STAGE_COLUMNS).toBeGreaterThan(0);
    for (const n of ladder()) expect(n.col).toBeLessThan(STAGE_COLUMNS);
  });

  it("draws whatever an older build stored, without back-filling", () => {
    const partial: { id: StageId; state: "done"; detail: null; startedAt: null; endedAt: null }[] =
      [
        { id: "segment", state: "done", detail: null, startedAt: null, endedAt: null },
        { id: "digest", state: "done", detail: null, startedAt: null, endedAt: null },
      ];
    const nodes = buildStageGraph(partial);
    expect(nodes.map((n) => n.id)).toEqual(["segment", "digest"]);
    // `digest` needs segment AND regions; regions is not on this ladder.
    expect(nodes[1]!.needs).toEqual(["segment"]);
  });
});
