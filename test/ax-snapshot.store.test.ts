import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import type { UIElement } from "../src/embed/types.js";
import { FakeEmbeddingProvider, namespaceFor } from "../src/index.js";

let dir: string;
let store: DualStore;
let sessionId: string;

const provider = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
const ns = namespaceFor("digest", provider);

const els = (role: string): UIElement[] => [{ role, x: 0, y: 0, w: 10, h: 10 }];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "deskrag-axsnap-"));
  store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  await store.registerVectorSpace({
    namespace: ns, view: "digest", providerId: provider.id,
    model: provider.model, dimensions: provider.dimensions, sharedTextSpace: false,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const frame = async (id: string): Promise<void> => {
  await store.putFrames([
    { id, sessionId, tMono: 10, width: 100, height: 100, phash: 0n, frameOffset: 0, segmentIds: [] },
  ]);
};

describe("ax_snapshot", () => {
  it("round-trips a boundary snapshot with no frame", async () => {
    const row = {
      id: ulid(),
      sessionId,
      tMono: 1000,
      frameId: null,
      reason: "focus_change" as const,
      walkMs: 42.5,
      elements: els("AXWindow"),
    };
    await store.putAxSnapshot(row);
    expect(store.getAxAt(sessionId, 1000)).toEqual(row);
  });

  it("returns the nearest snapshot AT OR BEFORE the requested t_mono", async () => {
    for (const t of [100, 500, 900]) {
      await store.putAxSnapshot({
        id: ulid(), sessionId, tMono: t, frameId: null,
        reason: "focus_change", walkMs: 1, elements: els(`R${t}`),
      });
    }
    expect(store.getAxAt(sessionId, 700)?.tMono).toBe(500);
    expect(store.getAxAt(sessionId, 900)?.tMono).toBe(900);
    expect(store.getAxAt(sessionId, 5000)?.tMono).toBe(900);
  });

  it("returns undefined when nothing precedes the requested t_mono", async () => {
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 500, frameId: null,
      reason: "bookmark", walkMs: 1, elements: els("AXWindow"),
    });
    expect(store.getAxAt(sessionId, 100)).toBeUndefined();
  });

  it("does not leak snapshots across sessions", async () => {
    const other = ulid();
    await store.putSession({ id: other, startedAt: Date.now(), epochMono: 0 });
    await store.putAxSnapshot({
      id: ulid(), sessionId: other, tMono: 100, frameId: null,
      reason: "bookmark", walkMs: 1, elements: els("Other"),
    });
    expect(store.getAxAt(sessionId, 5000)).toBeUndefined();
  });

  it("STORES AN EMPTY RESULT — 'captured nothing' must differ from 'never captured'", async () => {
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 100, frameId: null,
      reason: "focus_change", walkMs: 3, elements: [],
    });
    const got = store.getAxAt(sessionId, 100);
    expect(got).toBeDefined();
    expect(got!.elements).toEqual([]);
    expect(got!.reason).toBe("focus_change");
  });

  it("serves getFrameAx from ax_snapshot when a frame is attached", async () => {
    const frameId = ulid();
    await frame(frameId);
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 10, frameId,
      reason: "keyframe", walkMs: 2, elements: els("AXButton"),
    });
    expect(store.getFrameAx(frameId)).toEqual(els("AXButton"));
  });

  it("falls back to legacy frame_ax for sessions recorded before this change", async () => {
    const frameId = ulid();
    await frame(frameId);
    await store.putFrameAx(frameId, els("AXLegacy"));
    expect(store.getFrameAx(frameId)).toEqual(els("AXLegacy"));
  });

  it("prefers ax_snapshot over legacy frame_ax for the same frame", async () => {
    const frameId = ulid();
    await frame(frameId);
    await store.putFrameAx(frameId, els("AXLegacy"));
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 10, frameId,
      reason: "keyframe", walkMs: 2, elements: els("AXNew"),
    });
    expect(store.getFrameAx(frameId)).toEqual(els("AXNew"));
  });

  it("cascades on session delete", async () => {
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 100, frameId: null,
      reason: "bookmark", walkMs: 1, elements: els("AXWindow"),
    });
    await store.deleteSession(sessionId);
    expect(store.getAxAt(sessionId, 5000)).toBeUndefined();
  });

  it("registers NO vector space", async () => {
    const before = store.listVectorSpaces();
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 1, frameId: null,
      reason: "bookmark", walkMs: 1, elements: els("AXWindow"),
    });
    expect(store.listVectorSpaces()).toEqual(before);
  });

  it("returns every snapshot for a session, in t_mono order", async () => {
    // Written out of order on purpose: a caller drawing these on a timeline
    // must not depend on insertion order.
    for (const tMono of [300, 100, 200]) {
      await store.putAxSnapshot({
        id: ulid(), sessionId, tMono, frameId: null,
        reason: "focus_change", walkMs: 80, elements: els("Button"),
      });
    }
    const rows = store.getAxSnapshotsBySession(sessionId);
    expect(rows.map((r) => r.tMono)).toEqual([100, 200, 300]);
    expect(rows[0]!.elements).toHaveLength(1);
  });

  it("returns an empty array for a session with no snapshots", () => {
    expect(store.getAxSnapshotsBySession("nope")).toEqual([]);
  });
});

describe("getRegionsByFrame", () => {
  it("returns a frame's regions in priority order", async () => {
    const frameId = ulid();
    const segmentId = ulid();
    await frame(frameId);
    await store.putSegments([
      { id: segmentId, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 100 },
    ]);
    const mk = (id: string, priority: number, x: number) => ({
      id, frameId, segmentId, sessionId, x, y: 0, w: 10, h: 10,
      source: "ax", priority,
      vector: { namespace: ns, vector: new Float32Array([1, 0, 0, 0]) },
    });
    await store.putRegions([mk("r_lo", 0.1, 0), mk("r_hi", 0.9, 20)]);

    const got = store.getRegionsByFrame(frameId);
    expect(got.map((r) => r.id)).toEqual(["r_hi", "r_lo"]);
    expect(got[0]).toMatchObject({ x: 20, w: 10 });
  });

  it("returns [] for a frame with no regions and for an unknown frame", async () => {
    const frameId = ulid();
    await frame(frameId);
    expect(store.getRegionsByFrame(frameId)).toEqual([]);
    expect(store.getRegionsByFrame("nope")).toEqual([]);
  });
});
