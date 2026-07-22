import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { Representer } from "../src/represent/representer.js";
import { buildDigest, type DigestEvent } from "../src/represent/digest.js";
import { BehaviorFeatureExtractor, type BehaviorEvent } from "../src/represent/behavior.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import type { EventInsert } from "../src/store/types.js";

describe("buildDigest", () => {
  it("templates counts, scroll intensity, and per-app attribution", () => {
    const evs: DigestEvent[] = [{ tMono: 0, kind: "focus_change", data: { app: "Slack" } }];
    let t = 1;
    for (let i = 0; i < 42; i++) evs.push({ tMono: t++, kind: "mouse_down" });
    for (let i = 0; i < 10; i++) evs.push({ tMono: t++, kind: "scroll" });
    for (let i = 0; i < 5; i++) evs.push({ tMono: t++, kind: "key_down" });
    evs.push({ tMono: t++, kind: "focus_change", data: { app: "VS Code" } });
    for (let i = 0; i < 3; i++) evs.push({ tMono: t++, kind: "mouse_down" });

    const d = buildDigest(evs);
    expect(d).toContain("app focus: Slack → VS Code");
    expect(d).toContain("45 clicks");
    expect(d).toContain("heavy scrolling");
    expect(d).toContain("5 keystrokes");
    expect(d).toContain("typed in Slack");
    expect(d).toContain("clicked in VS Code");
  });

  it("uses light scrolling under threshold and singular units", () => {
    const d = buildDigest([
      { tMono: 0, kind: "mouse_down" },
      { tMono: 1, kind: "scroll" },
    ]);
    expect(d).toContain("1 click");
    expect(d).not.toContain("1 clicks");
    expect(d).toContain("light scrolling");
  });

  it("returns 'idle segment' for no activity", () => {
    expect(buildDigest([])).toBe("idle segment");
  });

  it("summarizes activity even with no app context", () => {
    expect(buildDigest([{ tMono: 0, kind: "key_down" }])).toBe("1 keystroke.");
  });
});

describe("BehaviorFeatureExtractor", () => {
  const ext = new BehaviorFeatureExtractor();
  const win = { tMonoStart: 0, tMonoEnd: 1000 };

  it("has a stable identity and dimensionality (its own non-shared namespace)", () => {
    expect(ext.id).toBe("builtin");
    expect(ext.model).toBe("input-dynamics-v1");
    expect(ext.dimensions).toBe(12);
    expect(ext.sharedTextSpace).toBe(false);
  });

  it("scales rates and keeps every feature in [0,1]", () => {
    const evs: BehaviorEvent[] = [];
    for (const t of [100, 200, 300, 400, 500]) evs.push({ tMono: t, kind: "mouse_down" });
    const v = ext.extract(evs, win);
    expect(v).toHaveLength(12);
    expect(Array.from(v).every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(v[0]).toBeCloseTo(1, 5); // 5 clicks/sec capped at 5 -> 1
    expect(v[6]).toBe(1); // all clicks, no keys -> click/key ratio 1
    const quarters = v[8]! + v[9]! + v[10]! + v[11]!;
    expect(quarters).toBeCloseTo(1, 5); // distribution sums to 1
  });

  it("path entropy: 0 for straight-line motion, high for varied directions", () => {
    const straight: BehaviorEvent[] = [0, 10, 20, 30].map((x, i) => ({
      tMono: i * 100, kind: "mouse_move", x, y: 0,
    }));
    expect(ext.extract(straight, win)[5]).toBe(0);

    // E, N, W, S -> four distinct direction bins -> entropy log2(4)/log2(8) = 2/3.
    const varied: BehaviorEvent[] = [
      { tMono: 0, kind: "mouse_move", x: 0, y: 0 },
      { tMono: 100, kind: "mouse_move", x: 10, y: 0 },
      { tMono: 200, kind: "mouse_move", x: 10, y: 10 },
      { tMono: 300, kind: "mouse_move", x: 0, y: 10 },
      { tMono: 400, kind: "mouse_move", x: 0, y: 0 },
    ];
    expect(ext.extract(varied, win)[5]).toBeCloseTo(2 / 3, 5);
  });

  it("returns an all-zero vector for an empty window", () => {
    const v = ext.extract([], win);
    expect(Array.from(v)).toEqual(new Array(12).fill(0));
  });
});

describe("Representer (integration)", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-rep-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes digest text + digest/behavior vectors, and reconcile stays clean", async () => {
    const sessionId = ulid();
    const mkEv = (tMono: number, kind: string, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono, kind, ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mkEv(0, "mouse_move"),
      mkEv(5000, "focus_change", { app: "Slack" }),
      mkEv(6000, "key_down"),
    ]);
    await store.endSession(sessionId, 9000); // endTMono = 8000

    await new Segmenter(store).segment(sessionId);

    const digestEmbedder = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });
    const rep = new Representer(store, { digestEmbedder });
    const result = await rep.represent(sessionId);

    expect(result.segmentCount).toBe(3); // 2 actions + 1 task
    expect(result.digestNamespace).toBe("digest:fake:m:8");
    expect(result.behaviorNamespace).toBe("behavior:builtin:input-dynamics-v1:12");

    // Digest text persisted; the Slack action attributes the keystroke.
    const segs = store.getSegmentsBySession(sessionId);
    expect(segs.every((s) => s.digest !== null)).toBe(true);
    const slackAction = segs.find(
      (s) => s.granularity === "action" && s.tMonoStart === 5000,
    );
    expect(slackAction!.digest).toContain("typed in Slack");

    // Every segment has a digest AND a behavior vector in Lance.
    const [dq] = await digestEmbedder.embed(["query"]);
    const digestHits = await store.searchSegments(result.digestNamespace, dq!, 50);
    expect(digestHits).toHaveLength(3);
    const behaviorHits = await store.searchSegments(
      result.behaviorNamespace,
      new Float32Array(12),
      50,
    );
    expect(behaviorHits).toHaveLength(3);

    // Nothing missing, nothing orphaned: the enrich write path is consistent.
    const rec = await store.reconcile();
    expect(rec.missing).toHaveLength(0);
    expect(rec.orphansPruned).toBe(0);
  });
});
