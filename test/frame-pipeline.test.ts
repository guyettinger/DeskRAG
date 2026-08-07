import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { dHash, resizeNearestGray } from "../src/capture/phash.js";
import { KeyframeBudget } from "../src/capture/keyframe-budget.js";
import { FrameIngestor, type SampledFrame } from "../src/capture/frame-ingest.js";

const ALL_ONES = (1n << 64n) - 1n;

/** A 9x8 grayscale column gradient (identity under dHash's 9x8 downscale). */
function gradient(reverse = false): Uint8Array {
  const g = new Uint8Array(72);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const v = Math.round((x * 255) / 8);
      g[y * 9 + x] = reverse ? 255 - v : v;
    }
  }
  return g;
}

describe("dHash", () => {
  it("is 0 for a strictly increasing gradient and all-ones for a decreasing one", () => {
    expect(dHash(gradient(false), 9, 8)).toBe(0n);
    expect(dHash(gradient(true), 9, 8)).toBe(ALL_ONES);
  });

  it("is stable for identical buffers and rejects size mismatches", () => {
    expect(dHash(gradient(), 9, 8)).toBe(dHash(gradient(), 9, 8));
    expect(() => dHash(new Uint8Array(10), 9, 8)).toThrow();
  });

  it("resizeNearestGray downscales deterministically", () => {
    const src = Uint8Array.from({ length: 16 }, (_, i) => i); // 4x4
    expect(resizeNearestGray(src, 4, 4, 2, 2)).toEqual(Uint8Array.from([0, 2, 8, 10]));
  });
});

describe("KeyframeBudget", () => {
  it("always keeps the first frame, whatever the interval", () => {
    const b = new KeyframeBudget({ minIntervalMs: 1000 });
    expect(b.consider(0)).toBe(true);
  });

  it("keeps the FIRST of a burst and drops the rest inside the interval", () => {
    const b = new KeyframeBudget({ minIntervalMs: 500 });
    expect(b.consider(0)).toBe(true);
    expect(b.consider(100)).toBe(false);
    expect(b.consider(400)).toBe(false);
    expect(b.consider(499)).toBe(false);
    expect(b.consider(500)).toBe(true); // the interval has elapsed
  });

  it("measures from the last KEPT frame, not the last considered one", () => {
    // A steady stream just under the interval must still yield a frame each
    // time the interval elapses — measuring from the last *considered* frame
    // would starve the lane forever.
    const b = new KeyframeBudget({ minIntervalMs: 500 });
    b.consider(0); // kept
    b.consider(400); // dropped
    expect(b.consider(600)).toBe(true); // 600 - 0 >= 500
  });

  it("keeps everything at minIntervalMs 0 — the rule tests want", () => {
    const b = new KeyframeBudget({ minIntervalMs: 0 });
    expect([0, 0, 1, 1].map((t) => b.consider(t))).toEqual([true, true, true, true]);
  });

  it("reset() forgets the last kept frame", () => {
    const b = new KeyframeBudget({ minIntervalMs: 500 });
    b.consider(0);
    expect(b.consider(100)).toBe(false);
    b.reset();
    expect(b.consider(100)).toBe(true);
  });
});

describe("FrameIngestor -> Tier-0 (phashPrefilter)", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-frame-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores only kept keyframes and makes them findable by pHash", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 500 }));

    const frame = (tMono: number, gray: Uint8Array): SampledFrame => ({
      tMono, width: 1920, height: 1080, gray, grayW: 9, grayH: 8,
    });

    // Dedup is ffmpeg's job now (mpdecimate). What the ingestor still enforces
    // is the BUDGET: a second frame 1ms later is the tail of the same burst.
    const a = await ing.ingest(frame(0, gradient(false)));
    const b = await ing.ingest(frame(1, gradient(true))); // inside the interval
    const c = await ing.ingest(frame(600, gradient(true))); // interval elapsed

    expect(a.kept).toBe(true);
    expect(b.kept).toBe(false);
    expect(c.kept).toBe(true);
    expect(ing.keptCount).toBe(2);
    expect(a.frameId).not.toBe(c.frameId);

    // Tier-0: a pHash query returns the near frame, not the far one.
    expect(store.phashPrefilter(0n, 5)).toEqual([a.frameId]);
    expect(store.phashPrefilter(ALL_ONES, 5)).toEqual([c.frameId]);
    // A wide radius returns both kept keyframes (and never the skipped one).
    expect(new Set(store.phashPrefilter(0n, 64))).toEqual(new Set([a.frameId, c.frameId]));
  });
});
