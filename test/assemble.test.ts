import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { Representer } from "../src/represent/representer.js";
import { associateFrames } from "../src/represent/frame-segments.js";
import { FramePatchRepresenter } from "../src/represent/frame-patch-representer.js";
import { RegionRepresenter } from "../src/represent/regions/region-representer.js";
import { FrameIngestor, type SampledFrame } from "../src/capture/frame-ingest.js";
import { KeyframeBudget } from "../src/capture/keyframe-budget.js";
import { FakeEmbeddingProvider, FakeMultiVectorProvider } from "../src/embed/fake.js";
import { BehaviorFeatureExtractor } from "../src/represent/behavior.js";
import { Retriever, collapseAncestors } from "../src/retrieve/assemble.js";
import { TextViewSearcher, BehaviorViewSearcher } from "../src/retrieve/searchers.js";
import type { EventInsert } from "../src/store/types.js";
import type { UIElement } from "../src/embed/types.js";

const imgA = Uint8Array.from([1, 2, 3, 4]);
const imgB = Uint8Array.from([9, 8, 7, 6]);

// Distinct gradients -> distinct pHashes so both keyframes survive dedup gating.
function grad(reverse = false): Uint8Array {
  const g = new Uint8Array(72);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) {
      const v = Math.round((x * 255) / 8);
      g[y * 9 + x] = reverse ? 255 - v : v;
    }
  return g;
}

describe("Retriever (assembly capstone)", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });
  const mv = new FakeMultiVectorProvider(16, 4);
  const behavior = new BehaviorFeatureExtractor();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-asm-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const sessionId = ulid();
    const mk = (t: number, kind: string, x?: number, y?: number, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind,
      ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mk(0, "mouse_move", 0, 0),
      mk(5000, "focus_change", undefined, undefined, { app: "Slack" }),
      mk(6000, "mouse_down", 500, 500),
      mk(6100, "mouse_down", 505, 505),
      mk(6200, "key_down"),
    ]);
    await store.endSession(sessionId, 9000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);
    const frame = (t: number, gray: Uint8Array, image: Uint8Array): SampledFrame => ({
      tMono: t, width: 1920, height: 1080, gray, grayW: 9, grayH: 8, image: { bytes: image, codec: "png" },
    });
    const a = await ing.ingest(frame(1000, grad(false), imgA));
    const b = await ing.ingest(frame(6000, grad(true), imgB));

    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder: fake, behavior }).represent(sessionId);
    await new FramePatchRepresenter(store, {
      patchEmbedder: mv,
      blobStore: blobs,
    }).represent(sessionId);
    const axEl: UIElement = { role: "button", label: "Save", x: 480, y: 480, w: 60, h: 24 };
    await new RegionRepresenter(store, { axProvider: () => [axEl] }).represent(sessionId);

    // Frame B is a scene_change boundary, so the action span holding it STARTS
    // at t=6000. Boundaries here are [0 start, 1000 scene, 5000 focus,
    // 6000 scene, 8000 end] and action does not subdivide.
    const late = store.getSegmentsBySession(sessionId).find((s) => s.granularity === "action" && s.tMonoStart === 6000)!;
    return { sessionId, frameA: a.frameId!, frameB: b.frameId!, late };
  }

  function retriever() {
    return new Retriever(store, {
      searchers: [new TextViewSearcher(fake, "digest"), new BehaviorViewSearcher(behavior)],
      patchEmbedder: mv,
    });
  }

  it("combined text+image: the exact-match frame in the matching segment ranks #1 with highlights", async () => {
    const { frameB, late } = await setup();
    const res = await retriever().retrieve({ text: late.digest!, image: imgB });

    expect(res.segments.map((s) => s.segmentId)).toContain(late.id);
    expect(res.frames[0]!.frameId).toBe(frameB);
    // MaxSim distance is a NEGATED similarity summed over query vectors, so an
    // exact match is the most NEGATIVE number here, not zero — which is why
    // `assemble` ranks frames by position rather than through 1/(1+d).
    expect(res.frames[0]!.frameDistance!).toBeLessThan(0);
    expect(res.frames[0]!.segmentId).toBe(late.id);
    expect(res.frames[0]!.highlights.length).toBeGreaterThan(0);
    // scores are sorted descending
    const scores = res.frames.map((f) => f.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("pure image query: unscoped frame recall ranks the exact match first, with highlights", async () => {
    const { frameB } = await setup();
    const res = await retriever().retrieve({ image: imgB });

    expect(res.segments).toEqual([]); // Tier 1 not engaged without text/behavior
    expect(res.frames[0]!.frameId).toBe(frameB);
    // Best MaxSim = most negative; every other frame must score worse.
    for (const f of res.frames.slice(1)) {
      expect(res.frames[0]!.frameDistance!).toBeLessThan(f.frameDistance!);
    }
    expect(res.frames[0]!.highlights.length).toBeGreaterThan(0);
  });

  it("text-only query with NO visual path: frames come from segment membership", async () => {
    const { frameA, frameB, late } = await setup();
    // No patchEmbedder — so no frame ANN, no distance, and no patch highlights.
    const res = await new Retriever(store, {
      searchers: [new TextViewSearcher(fake, "digest"), new BehaviorViewSearcher(behavior)],
    }).retrieve({ text: late.digest! });

    expect(res.segments[0]!.segmentId).toBe(late.id);
    const ids = res.frames.map((f) => f.frameId);
    expect(ids).toContain(frameB);
    expect(ids).toContain(frameA);
    expect(res.frames.every((f) => f.frameDistance === undefined)).toBe(true);
    // the frame in the top-scoring segment sorts first
    expect(res.frames[0]!.frameId).toBe(frameB);
  });

  /**
   * The DEFAULT app configuration: no image provider at all. Cases above build
   * the Retriever with one and run FramePatchRepresenter, which is exactly why
   * this shipped broken — frame↔segment links were written only by the image
   * stages, so text-only recall (which finds frames purely by segment
   * membership) returned nothing over a fully indexed library.
   */
  it("text-only, NO image provider: frames are still recalled via segment membership", async () => {
    const sessionId = ulid();
    const mk = (t: number, kind: string, x?: number, y?: number, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind,
      ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mk(0, "mouse_move", 0, 0),
      mk(5000, "focus_change", undefined, undefined, { app: "Slack", title: "general" }),
      mk(6000, "mouse_down", 500, 500),
    ]);
    await store.endSession(sessionId, 9000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);
    const frame = (t: number, gray: Uint8Array, image: Uint8Array): SampledFrame => ({
      tMono: t, width: 1920, height: 1080, gray, grayW: 9, grayH: 8, image: { bytes: image, codec: "png" },
    });
    await ing.ingest(frame(1000, grad(false), imgA));
    const b = await ing.ingest(frame(6000, grad(true), imgB));

    // Exactly the always-on stages, in order — no patch stage, no regions.
    await new Segmenter(store).segment(sessionId);
    await associateFrames(store, sessionId);
    await new Representer(store, { digestEmbedder: fake, behavior }).represent(sessionId);

    const late = store
      .getSegmentsBySession(sessionId)
      .find((s) => s.granularity === "action" && s.tMonoStart === 6000)!;

    // No patchEmbedder — the default install.
    const res = await new Retriever(store, {
      searchers: [new TextViewSearcher(fake, "digest"), new BehaviorViewSearcher(behavior)],
    }).retrieve({ text: late.digest! });

    expect(res.segments[0]!.segmentId).toBe(late.id);
    expect(res.frames.length).toBeGreaterThan(0);
    expect(res.frames.map((f) => f.frameId)).toContain(b.frameId!);
  });

  /**
   * `score` cannot say whether a hit is any good — every term is max-normalized
   * across the candidate set, so the best hit of every query sits at the weight
   * ceiling. `evidence` is what can: the lists this frame actually appeared in.
   */
  describe("evidence", () => {
    it("names the ranked lists behind a hit, best rank first", async () => {
      const { late } = await setup();
      const res = await retriever().retrieve({ text: late.digest! });

      const top = res.frames[0]!;
      expect(top.evidence.lanes.length).toBeGreaterThan(0);
      // Sorted by rank, so the strongest reason a row is here reads first.
      const ranks = top.evidence.lanes.map((l) => l.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      // Every lane is a real list with a 1-based position in it.
      for (const lane of top.evidence.lanes) {
        expect(lane.key).not.toBe("");
        expect(lane.rank).toBeGreaterThanOrEqual(1);
      }
      expect(top.evidence.lanes.map((l) => l.key)).toContain("digest");
    });

    /**
     * The breakdown EXPLAINS the score rather than restating it: weight the
     * three terms and add, and the number comes back. That is what lets the UI
     * show a bar and a reason without them being able to disagree.
     */
    it("carries the same three terms the score is summed from", async () => {
      const { late } = await setup();
      const res = await retriever().retrieve({ text: late.digest!, image: imgB });

      for (const f of res.frames) {
        const w = { frame: 1, region: 0.5, segment: 0.5 };
        const recomputed =
          w.frame * f.evidence.frame +
          w.region * f.evidence.region +
          w.segment * f.evidence.segment;
        expect(recomputed).toBeCloseTo(f.score, 10);
        for (const term of [f.evidence.frame, f.evidence.region, f.evidence.segment]) {
          expect(term).toBeGreaterThanOrEqual(0);
          expect(term).toBeLessThanOrEqual(1);
        }
      }
    });

    /**
     * A region lane is the ONLY per-frame evidence a text query has, and its
     * count is what the UI prints as `on-screen label x7`. Dense ranks mean
     * several regions legitimately share one — that is not a tie to break.
     */
    it("reports the best AX-label rank and how many regions matched", async () => {
      const { late } = await setup();
      const res = await retriever().retrieve({ text: `${late.digest!} Save` });

      const withLabels = res.frames.find((f) =>
        f.evidence.lanes.some((l) => l.key === "region_label"),
      );
      expect(withLabels).toBeDefined();
      const lane = withLabels!.evidence.lanes.find((l) => l.key === "region_label")!;
      expect(lane.rank).toBeGreaterThanOrEqual(1);
      expect(lane.count).toBeGreaterThanOrEqual(1);
      expect(lane.count).toBe(
        withLabels!.highlights.filter((h) => h.ftsRank !== undefined).length,
      );
    });

    /**
     * ONLY the lanes that actually ran, on the DEFAULT configuration — no image
     * provider and no captioner, which is the setup nobody tests and most people
     * have. The UI prints these names verbatim, so a lane appearing here that
     * never searched would be the row telling the reader a flat lie about why
     * its hit is on screen.
     */
    it("names no lane that did not run", async () => {
      const sessionId = ulid();
      await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
      await store.putEvents([
        { id: ulid(), sessionId, tMono: 0, kind: "focus_change", data: { app: "Slack" } },
        { id: ulid(), sessionId, tMono: 6000, kind: "mouse_down", x: 500, y: 500 },
      ]);
      await store.endSession(sessionId, 9000);

      const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);
      await ing.ingest({
        tMono: 1000, width: 1920, height: 1080,
        gray: grad(false), grayW: 9, grayH: 8, image: { bytes: imgA, codec: "png" },
      });
      await new Segmenter(store).segment(sessionId);
      await associateFrames(store, sessionId);
      await new Representer(store, { digestEmbedder: fake, behavior }).represent(sessionId);

      const seg = store.getSegmentsBySession(sessionId).find((s) => s.digest)!;
      // No patchEmbedder, and only the digest view registered.
      const res = await new Retriever(store, {
        searchers: [new TextViewSearcher(fake, "digest")],
      }).retrieve({ text: seg.digest! });

      expect(res.frames.length).toBeGreaterThan(0);
      const keys = new Set(res.frames.flatMap((f) => f.evidence.lanes.map((l) => l.key)));
      // Non-empty, or every assertion below is vacuous.
      expect(keys.has("digest")).toBe(true);
      // Never a namespace that was never registered — those spaces do not exist
      // until something has been indexed by a captioner.
      expect(keys.has("caption")).toBe(false);
      expect(keys.has("app_caption")).toBe(false);
      // And every key that IS here is one the retriever was actually given.
      for (const key of keys) {
        expect(["digest", "lexical", "region_label"]).toContain(key);
      }
    });
  });

  /**
   * The defect: for a text query, frames are recalled by segment MEMBERSHIP and
   * carry no ANN distance, so `frameScore` was 0 for every one of them and every
   * frame sharing a segment scored identically. Measured on a real library, one
   * query returned 11 frames tied to six decimal places, ordered arbitrarily.
   *
   * Tier 3's AX-label half is the per-frame evidence that breaks it — and it
   * needs no model, so it works on the default configuration.
   */
  it("text query: frames in ONE segment are ranked by their own AX labels, not tied", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      { id: ulid(), sessionId, tMono: 0, kind: "focus_change", data: { app: "TextEdit" } },
    ]);
    await store.endSession(sessionId, 9000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);
    const a = await ing.ingest({
      tMono: 1000, width: 1920, height: 1080, gray: grad(false), grayW: 9, grayH: 8,
      image: { bytes: imgA, codec: "png" },
    });
    const b = await ing.ingest({
      tMono: 2000, width: 1920, height: 1080, gray: grad(true), grayW: 9, grayH: 8,
      image: { bytes: imgB, codec: "png" },
    });

    await new Segmenter(store).segment(sessionId);
    await associateFrames(store, sessionId);
    await new Representer(store, { digestEmbedder: fake, behavior }).represent(sessionId);

    // Both frames sit in the SAME segment — one focus_change at t=0 means
    // segmentation cuts once — so segment-level scoring cannot separate them.
    // Only frame B shows the button.
    const seg = store.getSegmentsBySession(sessionId).find((s) => s.granularity === "action")!;
    await store.putRegions([
      { id: ulid(), frameId: a.frameId!, segmentId: seg.id, sessionId, x: 0, y: 0, w: 10, h: 10,
        source: "ax", role: "button", label: "Cancel", priority: 1 },
      { id: ulid(), frameId: b.frameId!, segmentId: seg.id, sessionId, x: 0, y: 0, w: 10, h: 10,
        source: "ax", role: "button", label: "Publish", priority: 1 },
    ]);

    // No image provider at all — the default.
    const res = await new Retriever(store, {
      searchers: [new TextViewSearcher(fake, "digest")],
    }).retrieve({ text: "Publish" });

    const scoreOf = (id: string) => res.frames.find((f) => f.frameId === id)?.score ?? -1;
    expect(scoreOf(b.frameId!)).toBeGreaterThan(scoreOf(a.frameId!));

    // And the match is shown, not merely scored: a text query gets highlights.
    const hit = res.frames.find((f) => f.frameId === b.frameId)!;
    expect(hit.highlights.map((h) => h.label)).toContain("Publish");
    expect(hit.highlights[0]!.matchedBy).toContain("fts");
  });

  it("ties are ordered by time, deterministically — never by Map insertion order", async () => {
    const { frameA, frameB, late } = await setup();
    const res = await new Retriever(store, {
      searchers: [new TextViewSearcher(fake, "digest"), new BehaviorViewSearcher(behavior)],
    }).retrieve({ text: late.digest! });
    const tied = res.frames.filter(
      (f, _i, all) => all.filter((g) => g.score === f.score).length > 1,
    );
    for (let i = 1; i < tied.length; i++) {
      if (tied[i - 1]!.score !== tied[i]!.score) continue;
      expect(tied[i - 1]!.frame!.tMono).toBeLessThanOrEqual(tied[i]!.frame!.tMono);
    }
    expect([frameA, frameB].every((id) => res.frames.some((f) => f.frameId === id))).toBe(true);
  });

  it("associateFrames links a frame to every level-0 segment covering it", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      { id: ulid(), sessionId, tMono: 5000, kind: "focus_change", data: { app: "Slack" } },
    ]);
    await store.endSession(sessionId, 9000);
    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);
    const a = await ing.ingest({
      tMono: 6000, width: 1920, height: 1080, gray: grad(true), grayW: 9, grayH: 8,
      image: { bytes: imgB, codec: "png" },
    });
    await new Segmenter(store).segment(sessionId);

    expect(await associateFrames(store, sessionId)).toBe(1);
    const granularities = store
      .getFrame(a.frameId!)!
      .segmentIds.map((id) => store.getSegment(id)!.granularity);
    // Segmentation produces level 0 only; the composed levels get their frame
    // links from `ComposeRepresenter`, as the union of their children's.
    expect(new Set(granularities)).toEqual(new Set(["action"]));

    // Idempotent: the image stages associate too, and re-indexing re-runs this.
    expect(await associateFrames(store, sessionId)).toBe(1);
    expect(store.getFrame(a.frameId!)!.segmentIds.length).toBe(granularities.length);
  });
});

/**
 * The hierarchy's two retrieval rules, both pure.
 *
 * `collapseAncestors` removes the redundancy the hierarchy exists to remove,
 * one layer up: without it, Tier 1 returns a task AND several of its own
 * actions as separate results for the same query.
 */
describe("collapseAncestors", () => {
  const tree: Record<string, string[]> = { root: ["task"], task: ["a", "b"] };
  const childrenOf = (id: string): string[] => tree[id] ?? [];

  it("keeps the higher-ranked of an ancestor/descendant pair", () => {
    // Hits arrive best-first.
    expect(collapseAncestors([{ segmentId: "task" }, { segmentId: "a" }], childrenOf)).toEqual([
      { segmentId: "task" },
    ]);
    expect(collapseAncestors([{ segmentId: "a" }, { segmentId: "task" }], childrenOf)).toEqual([
      { segmentId: "a" },
    ]);
  });

  it("collapses across more than one generation", () => {
    expect(collapseAncestors([{ segmentId: "root" }, { segmentId: "b" }], childrenOf)).toEqual([
      { segmentId: "root" },
    ]);
    expect(collapseAncestors([{ segmentId: "b" }, { segmentId: "root" }], childrenOf)).toEqual([
      { segmentId: "b" },
    ]);
  });

  it("keeps unrelated hits — two siblings are two answers, not one", () => {
    expect(collapseAncestors([{ segmentId: "a" }, { segmentId: "b" }], childrenOf)).toEqual([
      { segmentId: "a" },
      { segmentId: "b" },
    ]);
  });

  it("preserves rank order among what it keeps", () => {
    const out = collapseAncestors(
      [{ segmentId: "a" }, { segmentId: "task" }, { segmentId: "b" }],
      childrenOf,
    );
    expect(out.map((h) => h.segmentId)).toEqual(["a", "b"]);
  });

  it("is a no-op with no tree at all — every recording before composing", () => {
    expect(collapseAncestors([{ segmentId: "x" }, { segmentId: "y" }], () => [])).toEqual([
      { segmentId: "x" },
      { segmentId: "y" },
    ]);
  });

  it("carries the hit's other fields through untouched", () => {
    const out = collapseAncestors([{ segmentId: "a", score: 0.9 }], childrenOf);
    expect(out).toEqual([{ segmentId: "a", score: 0.9 }]);
  });
});
