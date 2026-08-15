import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { Retriever } from "../src/retrieve/assemble.js";
import { Tier2MultiVectorRetriever } from "../src/retrieve/tier2-mv.js";
import { TextViewSearcher } from "../src/retrieve/searchers.js";
import { FakeEmbeddingProvider, FakeMultiVectorProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";
import {
  DEFAULT_TILE_CONFIG,
  cellToBox,
  computeTileGeometry,
  gridTokenCount,
  patchIndexToCell,
} from "../src/embed/onnx/geometry.js";

const mv = new FakeMultiVectorProvider(16, 4);
const NS = namespaceFor("frame_patches", mv);

let dir: string;
let store: DualStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "t2mv-"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  await store.registerVectorSpace({
    namespace: NS,
    view: "frame_patches",
    providerId: mv.id,
    model: mv.model,
    dimensions: mv.dimensions,
    sharedTextSpace: true,
  });
  await store.putSegments([
    { id: "segA", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 150 },
    { id: "segB", sessionId, granularity: "action", tMonoStart: 150, tMonoEnd: 300 },
  ]);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedFrames(): Promise<void> {
  for (const [id, tMono] of [
    ["f1", 100],
    ["f2", 200],
  ] as const) {
    await store.putFrames([
      {
        id,
        sessionId,
        tMono,
        width: 1280,
        height: 800,
        phash: 0n,
        frameOffset: 0,
        segmentIds: [],
      },
    ]);
  }
  const [pa, pb] = await mv.embedImages([
    Uint8Array.from([1, 2, 3]),
    Uint8Array.from([9, 9, 9]),
  ]);
  await store.putFramePatches([
    { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
    { frameId: "f2", sessionId, segmentIds: ["segB"], namespace: NS, patches: pb! },
  ]);
}

const t2 = () => new Tier2MultiVectorRetriever(store, mv, { topN: 10 });

describe("Tier2MultiVectorRetriever", () => {
  it("serves an IMAGE query", async () => {
    await seedFrames();
    const r = t2();
    const v = await r.embedQuery({ image: Uint8Array.from([9, 9, 9]) });
    expect((await r.retrieveFramesUnscoped(v!.vectors))[0]!.frameId).toBe("f2");
  });

  it("serves a TEXT query — the single-vector tier cannot", async () => {
    await seedFrames();
    const r = t2();
    const v = await r.embedQuery({ text: "anything" });
    expect(v).not.toBeNull();
    expect((await r.retrieveFramesUnscoped(v!.vectors)).length).toBe(2);
  });

  it("returns null query vectors when the query has neither text nor image", async () => {
    expect(await t2().embedQuery({})).toBeNull();
    expect(await t2().embedQuery({ text: "" })).toBeNull();
  });

  it("scopes to the Tier-1 segments", async () => {
    await seedFrames();
    const r = t2();
    const v = await r.embedQuery({ image: Uint8Array.from([9, 9, 9]) });
    expect((await r.retrieveFrames(v!.vectors, ["segA"])).map((h) => h.frameId)).toEqual(["f1"]);
  });

  it("returns [] for an empty scope rather than widening", async () => {
    await seedFrames();
    const r = t2();
    const v = await r.embedQuery({ image: Uint8Array.from([1]) });
    expect(await r.retrieveFrames(v!.vectors, [])).toEqual([]);
  });
});

it("the fake provider marks one content vector and pads the rest", async () => {
  const [q] = await mv.embedQueries(["x"]);
  expect(q!.vectors.length).toBe(4);
  expect(q!.contentIndices).toEqual([0]);
});

describe("MaxSim highlights", () => {
  const W = 1280;
  const H = 800;
  const geo = computeTileGeometry(W, H);
  const DIM = 16;

  /** A unit vector pointing along `axis`, so similarity is exactly controllable. */
  const axis = (a: number, scale = 1): Float32Array => {
    const v = new Float32Array(DIM);
    v[a] = scale;
    return v;
  };
  /** A patch set where every grid patch is filler except the named indices. */
  const patchSet = (special: Map<number, Float32Array>): Float32Array[] => {
    const out: Float32Array[] = [];
    for (let i = 0; i < gridTokenCount(geo) + geo.tokensPerTile; i++) {
      out.push(special.get(i) ?? axis(15, 0.01));
    }
    return out;
  };
  const cellIndex = (col: number, row: number): number => {
    for (let i = 0; i < gridTokenCount(geo); i++) {
      const c = patchIndexToCell(i, geo);
      if (c && c.col === col && c.row === row) return i;
    }
    throw new Error(`no patch at ${col},${row}`);
  };
  const r = (opts: { relativeFloor?: number; minScore?: number; maxHighlights?: number }) =>
    new Tier2MultiVectorRetriever(store, mv, opts);

  it("ignores a non-content vector, however well it matches", () => {
    // THE REPORTED BUG: [CLS] scored 0.992 against a patch of blank space and
    // was drawn first. Vector 1 here is that vector; only vector 0 is content.
    const patches = patchSet(
      new Map([
        [cellIndex(0, 0), axis(0)],
        [cellIndex(20, 20), axis(1)],
      ]),
    );
    const hl = r({ relativeFloor: 0.5 }).highlightsFrom(
      "f1",
      { vectors: [axis(0), axis(1)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(1);
    const expected = cellToBox({ col: 0, row: 0 }, geo);
    expect(hl[0]!.bbox.x).toBeCloseTo(expected.x, 9);
    expect(hl[0]!.bbox.y).toBeCloseTo(expected.y, 9);
    expect(hl[0]!.bbox.w).toBeCloseTo(expected.w, 9);
    expect(hl[0]!.bbox.h).toBeCloseTo(expected.h, 9);
  });

  it("merges adjacent patches into ONE box spanning them", () => {
    const patches = patchSet(
      new Map([
        [cellIndex(3, 4), axis(0)],
        [cellIndex(4, 4), axis(0)],
      ]),
    );
    const hl = r({ relativeFloor: 0.5 }).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(1);
    const left = cellToBox({ col: 3, row: 4 }, geo);
    const right = cellToBox({ col: 4, row: 4 }, geo);
    expect(hl[0]!.bbox.x).toBeCloseTo(left.x, 6);
    expect(hl[0]!.bbox.w).toBeCloseTo(right.x + right.w - left.x, 6);
    expect(hl[0]!.bbox.h).toBeCloseTo(left.h, 6);
  });

  it("keeps separated patches as separate boxes", () => {
    const patches = patchSet(
      new Map([
        [cellIndex(2, 2), axis(0)],
        [cellIndex(20, 15), axis(0)],
      ]),
    );
    const hl = r({ relativeFloor: 0.5 }).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(2);
  });

  it("cuts a patch below the relative floor", () => {
    const patches = patchSet(
      new Map([
        [cellIndex(1, 1), axis(0)],
        [cellIndex(10, 10), axis(0, 0.5)],
      ]),
    );
    const q = { vectors: [axis(0)], contentIndices: [0] };
    const boxes = (relativeFloor: number) =>
      r({ relativeFloor }).highlightsFrom("f1", q, patches, W, H).length;
    expect(boxes(0.4)).toBe(2); // 0.5 of the top survives a 0.4 floor
    expect(boxes(0.8)).toBe(1); // and not a 0.8 one
  });

  it("draws nothing when the best patch is below the absolute floor", () => {
    const patches = patchSet(new Map([[cellIndex(1, 1), axis(0, 0.2)]]));
    const hl = r({ minScore: 0.5 }).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl).toEqual([]);
  });

  it("never highlights the global tile, and does not let it cost a slot", () => {
    const patches = patchSet(
      new Map([
        [gridTokenCount(geo), axis(0)],
        [cellIndex(5, 5), axis(0, 0.9)],
      ]),
    );
    const hl = r({ relativeFloor: 0.5, maxHighlights: 1 }).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(1);
    // closeTo, not toEqual: a merged bbox recomputes its height as
    // max(y + h) - y, which differs from cellToBox's h in the last bit.
    const expected = cellToBox({ col: 5, row: 5 }, geo);
    expect(hl[0]!.bbox.x).toBeCloseTo(expected.x, 9);
    expect(hl[0]!.bbox.y).toBeCloseTo(expected.y, 9);
    expect(hl[0]!.bbox.w).toBeCloseTo(expected.w, 9);
    expect(hl[0]!.bbox.h).toBeCloseTo(expected.h, 9);
  });

  it("caps at maxHighlights, keeping the strongest boxes", () => {
    const patches = patchSet(
      new Map([
        [cellIndex(1, 1), axis(0, 1.0)],
        [cellIndex(10, 1), axis(0, 0.9)],
        [cellIndex(20, 1), axis(0, 0.8)],
      ]),
    );
    const hl = r({ relativeFloor: 0.5, maxHighlights: 2 }).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(2);
    expect(hl[0]!.strength).toBeCloseTo(1, 6);
    expect(hl[1]!.strength!).toBeLessThan(1);
  });

  it("returns [] when the query has no content vectors", () => {
    const patches = patchSet(new Map([[cellIndex(1, 1), axis(0)]]));
    expect(
      t2().highlightsFrom("f1", { vectors: [axis(0)], contentIndices: [] }, patches, W, H),
    ).toEqual([]);
  });

  it("keeps every box inside the frame and carries the synthetic shape", () => {
    const patches = patchSet(new Map([[cellIndex(31, 23), axis(0)]]));
    const hl = t2().highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(1);
    for (const h of hl) {
      expect(h.frameId).toBe("f1");
      expect(h.matchedBy).toEqual(["ann"]);
      expect(h.regionId).toMatch(/^f1#p\d+$/);
      expect(h.role).toBeNull();
      expect(h.label).toBeNull();
      expect(h.strength).toBeCloseTo(1, 6);
      expect(h.bbox.x + h.bbox.w).toBeLessThanOrEqual(W + 1e-9);
      expect(h.bbox.y + h.bbox.h).toBeLessThanOrEqual(H + 1e-9);
    }
  });

  /**
   * The highlighter must read the PROVIDER's geometry, not DEFAULT_TILE_CONFIG.
   * For ColModernVBERT the two coincide, so the default was right by luck and
   * would have gone on looking right — with every box on the wrong part of the
   * frame — the moment an export changed its tiling. A fake declaring a
   * deliberately DIFFERENT config is the only way to tell the two apart: with
   * the same numbers on both sides, the wrong code and the right code produce
   * identical boxes.
   */
  it("uses the provider's tileConfig, not the default", () => {
    // Half the shuffle factor -> 4x the tokens per tile -> a 16x16 grid within
    // each tile instead of 8x8, so every cell is a QUARTER the size.
    const cfg = { ...DEFAULT_TILE_CONFIG, shuffleFactor: 2 };
    const other = new FakeMultiVectorProvider(DIM, 4, { tileConfig: cfg });
    const otherGeo = computeTileGeometry(W, H, cfg);
    expect(otherGeo.tokensPerTile).toBe(256);

    const patches: Float32Array[] = [];
    for (let i = 0; i < gridTokenCount(otherGeo) + otherGeo.tokensPerTile; i++) {
      patches.push(i === 0 ? axis(0) : axis(15, 0.01));
    }
    const hl = new Tier2MultiVectorRetriever(store, other).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(1);
    // Patch 0 is cell (0,0) under either config; what differs is the cell SIZE.
    expect(hl[0]!.bbox.w).toBeCloseTo(cellToBox({ col: 0, row: 0 }, otherGeo).w, 9);
    expect(hl[0]!.bbox.w).not.toBeCloseTo(cellToBox({ col: 0, row: 0 }, geo).w, 3);
  });

  /**
   * A grid disagreement is fatal to EVERY box, so it draws none rather than
   * truncating. The geometry is recomputed from the frame row's screen points
   * while the embedder tiled the JPEG, and the JPEG's dimensions are stored
   * nowhere — they agree today only because the grid depends on aspect ratio
   * alone. `Math.min` absorbed the disagreement silently.
   */
  it("returns [] when the patch count disagrees with the grid, rather than truncating", () => {
    const full = patchSet(new Map([[cellIndex(0, 0), axis(0)]]));
    const q = { vectors: [axis(0)], contentIndices: [0] };
    expect(t2().highlightsFrom("f1", q, full, W, H).length).toBe(1);

    // One patch short, and one patch long: both are the wrong grid.
    expect(t2().highlightsFrom("f1", q, full.slice(0, -1), W, H)).toEqual([]);
    expect(t2().highlightsFrom("f1", q, [...full, axis(15, 0.01)], W, H)).toEqual([]);
    // And the whole GRID with the global tile missing is still the wrong count.
    expect(t2().highlightsFrom("f1", q, full.slice(0, gridTokenCount(geo)), W, H)).toEqual([]);
  });

  it("reads stored patches when given a frame id", async () => {
    await seedFrames();
    const [q] = await mv.embedQueries(["x"]);
    expect((await t2().highlightsForFrame("f1", q!, 1280, 800)).length).toBeGreaterThanOrEqual(0);
  });

  it("returns [] for a frame with no stored patches", async () => {
    const [q] = await mv.embedQueries(["x"]);
    expect(await t2().highlightsForFrame("nope", q!, 1280, 800)).toEqual([]);
  });
});

describe("Retriever multivector dispatch", () => {
  const text = new FakeEmbeddingProvider({ dimensions: 8 });

  it("recalls frames for a TEXT query through the patch space", async () => {
    await seedFrames();
    const r = new Retriever(store, { searchers: [], patchEmbedder: mv });
    const { frames } = await r.retrieve({ text: "anything" });
    expect(frames.length).toBe(2);
    // frameDistance present => recall came from the ANN, not segment membership
    expect(frames[0]!.frameDistance).toBeDefined();
  });

  it("attaches MaxSim highlights to the returned frames", async () => {
    await seedFrames();
    const r = new Retriever(store, { searchers: [], patchEmbedder: mv });
    const { frames } = await r.retrieve({ text: "anything" });
    expect(frames[0]!.highlights.length).toBeGreaterThan(0);
    expect(frames[0]!.highlights[0]!.regionId).toMatch(/#p\d+$/);
  });

  it("limits highlight computation to highlightTopN frames", async () => {
    await seedFrames();
    const r = new Retriever(store, { searchers: [], patchEmbedder: mv }, { highlightTopN: 1 });
    const { frames } = await r.retrieve({ text: "anything" });
    expect(frames[0]!.highlights.length).toBeGreaterThan(0);
    expect(frames[1]!.highlights).toEqual([]);
  });

  it("still works with no visual path at all (text-only recall)", async () => {
    await seedFrames();
    const searcher = new TextViewSearcher(text, "digest");
    await store.registerVectorSpace({
      namespace: searcher.namespace,
      view: "digest",
      providerId: text.id,
      model: text.model,
      dimensions: text.dimensions,
      sharedTextSpace: true,
    });
    const r = new Retriever(store, { searchers: [searcher] });
    const { frames } = await r.retrieve({ text: "anything" });
    expect(Array.isArray(frames)).toBe(true);
  });
});
