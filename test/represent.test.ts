import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { Representer } from "../src/represent/representer.js";
import { buildDigest, type DigestEvent } from "../src/represent/digest.js";
import { typedRuns, typedTextOverlapping } from "../src/represent/typed-runs.js";
import type { TraceEvent } from "../src/trace/types.js";
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

  /**
   * The signals that were on disk and reached no view. Tallies alone left 61% of
   * real action segments carrying `1 click.` / `mouse movement.` / `idle
   * segment` — byte-identical strings that embed to one vector.
   */
  it("carries the window title, which was parsed and thrown away", () => {
    const d = buildDigest([
      { tMono: 0, kind: "focus_change", data: { app: "Google Chrome", title: "PR #39 · DeskRAG" } },
      { tMono: 1, kind: "mouse_down" },
    ]);
    expect(d).toContain("Google Chrome");
    expect(d).toContain("PR #39 · DeskRAG");
  });

  it("carries the URL and its bare host, so a query naming just the site matches", () => {
    const d = buildDigest([
      { tMono: 0, kind: "url_change", data: { url: "https://github.com/guyettinger/DeskRAG/pull/39" } },
    ]);
    expect(d).toContain("https://github.com/guyettinger/DeskRAG/pull/39");
    expect(d).toContain("github.com");
  });

  const key = (tMono: number, scancode: number): DigestEvent => ({
    tMono, kind: "key_down", data: { keycode: scancode, modifiers: [] },
  });

  it("carries the text actually typed, as resolved at session scope", () => {
    const evs: DigestEvent[] = [
      { tMono: 0, kind: "focus_change", data: { app: "TextEdit", title: "Untitled" } },
    ];
    const d = buildDigest(evs, { typedTextAt: () => ["has"] }, { tMonoStart: 0, tMonoEnd: 100 });
    expect(d).toContain('typed "has"');
  });

  it("emits NO typed text without a keymap — never a US-QWERTY guess", () => {
    const d = buildDigest([key(10, 35), key(20, 30)], {}, { tMonoStart: 0, tMonoEnd: 100 });
    expect(d).not.toContain('typed "');
    expect(d).toContain("2 keystrokes"); // the tally still records that keys happened
  });

  it("caps typed text so one long run cannot swamp the segment's embedding", () => {
    const d = buildDigest(
      [],
      { typedTextAt: () => ["a".repeat(500)], maxTypedChars: 20 },
      { tMonoStart: 0, tMonoEnd: 100 },
    );
    expect(d).toContain("…");
    expect(d.length).toBeLessThan(200);
  });

  it("carries a run WHOLE into every segment it passes through", () => {
    const phrase = "This is a test of the emergency broadcast system";
    const runs = [{ text: phrase, tMonoStart: 1000, tMonoEnd: 9000 }];
    // Three consecutive segments, each holding only a slice of the typing.
    for (const w of [
      { tMonoStart: 1000, tMonoEnd: 3000 },
      { tMonoStart: 3000, tMonoEnd: 6000 },
      { tMonoStart: 6000, tMonoEnd: 9000 },
    ]) {
      const d = buildDigest([], { typedTextAt: () => typedTextOverlapping(runs, w.tMonoStart, w.tMonoEnd) }, w);
      expect(d).toContain(phrase);
    }
  });

  it("names what was clicked, from the labels of the regions under the point", () => {
    const d = buildDigest(
      [
        { tMono: 0, kind: "focus_change", data: { app: "Calculator" } },
        { tMono: 10, kind: "mouse_down", x: 100, y: 200 },
        { tMono: 20, kind: "mouse_down", x: 400, y: 500 },
      ],
      { labelAt: (p) => (p.x === 100 ? "All Clear" : undefined) },
    );
    expect(d).toContain('clicked "All Clear"');
    // The unlabelled click contributes nothing rather than an empty quote.
    expect(d).not.toContain('clicked ""');
  });
});

/**
 * The coalescer that fixes the fragmentation. `groupGestures` cannot serve this
 * purpose: it flushes on ANY non-key event because a replayable `type` action
 * must be contiguous, and the digest fed it one segment at a time while `action`
 * cuts at every visual state change — and typing IS a visual state change.
 */
describe("typedRuns", () => {
  const KEYMAP = {
    layoutId: "com.apple.keylayout.US",
    entries: {
      0: ["a", "A", "å", "Å"], 1: ["s", "S", "ß", "Í"], 4: ["h", "H", "˙", "Ó"],
      49: [" ", " ", " ", " "],
    } as Record<number, [string, string, string, string]>,
  };
  const at = () => KEYMAP;
  // scancode -> vk: 35->4 "h", 30->0 "a", 31->1 "s", 57->49 " "
  const ev = (tMono: number, kind: string, data?: unknown): TraceEvent => ({
    tMono, kind, x: null, y: null, data: data ?? null,
  });
  const k = (tMono: number, scancode: number, modifiers: string[] = []) =>
    ev(tMono, "key_down", { keycode: scancode, modifiers });

  it("keeps one phrase together across mouse activity mid-sentence", () => {
    const runs = typedRuns(
      [
        k(0, 35), k(10, 30), k(20, 31),
        // A caret reposition. groupGestures flushes here; composing does not stop.
        ev(25, "mouse_move"), ev(26, "mouse_down"),
        k(30, 35), k(40, 30), k(50, 31),
      ],
      at,
    );
    expect(runs.length).toBe(1);
    expect(runs[0]!.text).toBe("hashas");
    expect(runs[0]!.tMonoStart).toBe(0);
    expect(runs[0]!.tMonoEnd).toBe(50);
  });

  it("ends a run at a focus change — text composed in another app is another run", () => {
    const runs = typedRuns(
      [k(0, 35), k(10, 30), ev(20, "focus_change", { app: "Chrome" }), k(30, 31)],
      at,
    );
    expect(runs.map((r) => r.text)).toEqual(["ha", "s"]);
  });

  it("ends a run at a long idle — the next keystroke is a new thought", () => {
    const runs = typedRuns([k(0, 35), k(10, 30), k(10_000, 31)], at);
    expect(runs.map((r) => r.text)).toEqual(["ha", "s"]);
  });

  it("ends a run at a command chord — ⌘S is an instruction, not content", () => {
    const runs = typedRuns([k(0, 35), k(10, 30), k(20, 31, ["cmd"]), k(30, 35)], at);
    expect(runs.map((r) => r.text)).toEqual(["ha", "h"]);
  });

  it("returns nothing without a keymap, never a US-QWERTY guess", () => {
    expect(typedRuns([k(0, 35), k(10, 30)], () => undefined)).toEqual([]);
  });

  /**
   * Backspace is scancode 14 and types no character, so `resolveChar` correctly
   * reports none — which left the typist's own corrections in the run. Measured
   * on a real recording, that produced "the mergeemergency braoadcast system",
   * matching no query for what is plainly on the screen. Applying it yielded
   * exactly "this is a test of the emergency broadcast system".
   */
  it("applies backspace, so a run is what ended up ON SCREEN", () => {
    // "has", backspace, "a" -> "haa"
    const runs = typedRuns([k(0, 35), k(10, 30), k(20, 31), k(30, 14), k(40, 30)], at);
    expect(runs[0]!.text).toBe("haa");
  });

  it("a backspace with nothing to delete is a no-op, not a crash", () => {
    // It ate text typed before this run began; that text is not ours to guess.
    const runs = typedRuns([k(0, 14), k(10, 35), k(20, 30)], at);
    expect(runs.map((r) => r.text)).toEqual(["ha"]);
    expect(typedRuns([k(0, 14)], at)).toEqual([]);
  });

  it("overlap is inclusive of every segment a run passes through", () => {
    const runs = [{ text: "hello world", tMonoStart: 100, tMonoEnd: 900 }];
    expect(typedTextOverlapping(runs, 0, 100)).toEqual([]); // ends before the run
    expect(typedTextOverlapping(runs, 0, 200)).toEqual(["hello world"]);
    expect(typedTextOverlapping(runs, 300, 400)).toEqual(["hello world"]); // wholly inside
    expect(typedTextOverlapping(runs, 800, 1000)).toEqual(["hello world"]);
    expect(typedTextOverlapping(runs, 901, 1000)).toEqual([]); // starts after
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

    expect(result.segmentCount).toBe(2); // 2 actions — level 0 is all segmentation emits
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
    expect(digestHits).toHaveLength(2); // 2 actions — level 0 is all there is here
    const behaviorHits = await store.searchSegments(
      result.behaviorNamespace,
      new Float32Array(12),
      50,
    );
    expect(behaviorHits).toHaveLength(2);

    // Nothing missing, nothing orphaned: the enrich write path is consistent.
    const rec = await store.reconcile();
    expect(rec.missing).toHaveLength(0);
    expect(rec.orphansPruned).toBe(0);
  });
});
