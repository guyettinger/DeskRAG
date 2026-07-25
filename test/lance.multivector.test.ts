import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanceStore } from "../src/store/lance/tables.js";

const NS = "frame_patches:fake:fake-mv:16";
const D = 16;

/** Deterministic unit vector; `k` picks an axis so sets are separable. */
function vec(k: number): number[] {
  const v = Array.from({ length: D }, (_, i) => (i === k % D ? 1 : 0.01));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

let dir: string;
let store: LanceStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mv-"));
  store = await LanceStore.open(dir);
  await store.ensureTable(NS);
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("multivector table", () => {
  it("round-trips rows with DIFFERENT patch counts", async () => {
    await store.addPatches(NS, [
      { id: "f1", session_id: "s", segment_ids: ["segA"], patches: [vec(0), vec(1)] },
      {
        id: "f2",
        session_id: "s",
        segment_ids: ["segA"],
        patches: [vec(2), vec(3), vec(4), vec(5), vec(6)],
      },
      {
        id: "f3",
        session_id: "s",
        segment_ids: ["segB"],
        patches: Array.from({ length: 40 }, (_, i) => vec(i + 7)),
      },
    ]);
    const ids = (
      await store.searchFramePatches(NS, [Float32Array.from(vec(0))], 10)
    ).map((r) => r.id);
    expect(ids).toContain("f1");
    expect(ids.length).toBe(3);
  });

  it("scores by MaxSim, not by the first query vector alone", async () => {
    await store.addPatches(NS, [
      { id: "onlyA", session_id: "s", segment_ids: ["x"], patches: [vec(0), vec(9)] },
      { id: "bothAB", session_id: "s", segment_ids: ["x"], patches: [vec(0), vec(1)] },
      { id: "onlyB", session_id: "s", segment_ids: ["x"], patches: [vec(8), vec(1)] },
    ]);
    // Query carries both axes. Under MaxSim `bothAB` must win outright;
    // under first-vector-only it would tie with `onlyA`.
    const two = await store.searchFramePatches(
      NS,
      [Float32Array.from(vec(0)), Float32Array.from(vec(1))],
      3,
    );
    expect(two[0]!.id).toBe("bothAB");
    expect(two[0]!.distance).toBeLessThan(two[1]!.distance);
  });

  it("pre-filters by segment scope and still fills the limit", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`,
      session_id: "s",
      segment_ids: i % 3 === 0 ? ["segA"] : ["segB"],
      patches: [vec(i), vec(i + 1)],
    }));
    await store.addPatches(NS, rows);
    const hits = await store.searchFramePatches(NS, [Float32Array.from(vec(0))], 10, {
      segmentIds: ["segA"],
    });
    // 10 of 30 rows are segA. A post-filter would return ~3 here.
    expect(hits.length).toBe(10);
    expect(hits.every((h) => Number(h.id.slice(1)) % 3 === 0)).toBe(true);
  });

  it("scopes by frame id", async () => {
    await store.addPatches(NS, [
      { id: "a", session_id: "s", segment_ids: ["x"], patches: [vec(0)] },
      { id: "b", session_id: "s", segment_ids: ["x"], patches: [vec(1)] },
    ]);
    const hits = await store.searchFramePatches(NS, [Float32Array.from(vec(0))], 5, {
      frameIds: ["b"],
    });
    expect(hits.map((h) => h.id)).toEqual(["b"]);
  });

  it("returns [] for an empty frame scope rather than searching everything", async () => {
    await store.addPatches(NS, [
      { id: "a", session_id: "s", segment_ids: ["x"], patches: [vec(0)] },
    ]);
    expect(
      await store.searchFramePatches(NS, [Float32Array.from(vec(0))], 5, { frameIds: [] }),
    ).toEqual([]);
  });

  it("returns [] for an empty query", async () => {
    await store.addPatches(NS, [
      { id: "a", session_id: "s", segment_ids: ["x"], patches: [vec(0)] },
    ]);
    expect(await store.searchFramePatches(NS, [], 5)).toEqual([]);
  });

  it("builds a cosine index once there are enough rows, and search still works", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: `f${i}`,
      session_id: "s",
      segment_ids: ["segA"],
      patches: [vec(i), vec(i + 1), vec(i + 2)],
    }));
    await store.addPatches(NS, rows);
    expect(await store.ensurePatchIndex(NS, 256)).toBe(true);
    const hits = await store.searchFramePatches(NS, [Float32Array.from(vec(5))], 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("declines to index a table too small to train, without throwing", async () => {
    await store.addPatches(NS, [
      { id: "a", session_id: "s", segment_ids: ["x"], patches: [vec(0)] },
    ]);
    expect(await store.ensurePatchIndex(NS, 256)).toBe(false);
  });

  it("proves l2 is rejected for multivector, which is why cosine is unconditional", async () => {
    // Guards the trap: an UNINDEXED table brute-forces with metric=l2 and returns
    // plausible ordering, so nothing surfaces until index build — here.
    const lancedb = await import("@lancedb/lancedb");
    await store.addPatches(
      NS,
      Array.from({ length: 400 }, (_, i) => ({
        id: `f${i}`,
        session_id: "s",
        segment_ids: ["segA"],
        patches: [vec(i), vec(i + 1), vec(i + 2)],
      })),
    );
    const conn = await lancedb.connect(dir);
    const tbl = await conn.openTable(NS.replace(/:/g, "__"));
    await expect(
      tbl.createIndex("patches", {
        config: lancedb.Index.ivfPq({
          distanceType: "l2",
          numPartitions: 16,
          numSubVectors: 8,
        }),
      }),
    ).rejects.toThrow(/cosine/i);
  });

  it("reads back a frame's stored patch set, and null for an unknown id", async () => {
    await store.addPatches(NS, [
      { id: "f1", session_id: "s", segment_ids: ["x"], patches: [vec(0), vec(1), vec(2)] },
    ]);
    const got = await store.getFramePatches(NS, "f1");
    expect(got!.length).toBe(3);
    expect(got![0]!.length).toBe(D);
    expect(await store.getFramePatches(NS, "nope")).toBeNull();
  });
});
