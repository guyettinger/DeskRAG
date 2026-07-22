import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { dHash, resizeNearestGray } from "../src/capture/phash.js";
import { KeyframeGate } from "../src/capture/keyframe.js";
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

describe("KeyframeGate", () => {
  it("keeps the first frame, dedups near-duplicates, keeps distinct frames", () => {
    const gate = new KeyframeGate({ hammingThreshold: 10, sceneChangeThreshold: 25 });
    expect(gate.consider(0n).keep).toBe(true); // first
    expect(gate.consider(0b111n).keep).toBe(false); // 3 bits from last kept -> dedup
    expect(gate.consider(0xfffn).keep).toBe(true); // 12 bits -> distinct
  });

  it("forces a keyframe on a frame-to-frame scene-change spike", () => {
    const gate = new KeyframeGate({ hammingThreshold: 10, sceneChangeThreshold: 25 });
    gate.consider(0n); // keep (first)
    gate.consider(0n); // dup, skipped; lastConsidered = 0
    const d = gate.consider(ALL_ONES); // 64-bit jump vs previous
    expect(d.keep).toBe(true);
    expect(d.forced).toBe(true);
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
    const ing = new FrameIngestor(store, sessionId, new KeyframeGate({ hammingThreshold: 10 }));

    const frame = (tMono: number, gray: Uint8Array): SampledFrame => ({
      tMono, width: 1920, height: 1080, gray, grayW: 9, grayH: 8,
    });

    const a = await ing.ingest(frame(0, gradient(false))); // hash 0 -> kept
    const b = await ing.ingest(frame(1, gradient(false))); // identical -> skipped
    const c = await ing.ingest(frame(2, gradient(true))); // all-ones -> kept

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
