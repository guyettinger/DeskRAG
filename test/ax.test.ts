import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { RegionRepresenter } from "../src/represent/regions/region-representer.js";
import { StoredAxProvider } from "../src/represent/regions/stored-ax-provider.js";
import { associateFrameAx } from "../src/represent/frame-ax.js";
import { FusedRegionProposer } from "../src/represent/regions/proposer.js";
import { Tier3Retriever } from "../src/retrieve/tier3.js";
import { FrameIngestor, type SampledFrame } from "../src/capture/frame-ingest.js";
import { KeyframeBudget } from "../src/capture/keyframe-budget.js";
import { CaptureSession } from "../src/capture/session.js";
import { FakeDeviceClockSource } from "../src/capture/env/fake.js";
import { AxCapturer } from "../src/capture/ax/ax-capturer.js";
import { NoopAxSource } from "../src/capture/ax/noop.js";
import { SwiftAxSource } from "../src/capture/ax/swift-ax-source.js";
import { parseAxElements, parseAxResult, coerceAxElements } from "../src/capture/ax/parse.js";
import type { AxSource } from "../src/capture/ax/types.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import type { Box } from "../src/represent/regions/geometry.js";
import type { RegionCropper } from "../src/represent/regions/cropper.js";
import type { CaptureContext, Producer } from "../src/capture/types.js";
import type { UIElement } from "../src/embed/types.js";

const saveButton: UIElement = { role: "button", label: "Save", x: 100, y: 100, w: 80, h: 30, focused: true };
const fakeSource = (els: UIElement[]): AxSource => ({ async query() { return els; } });

const cropper: RegionCropper = {
  async crop(_i, _w, _h, b: Box) {
    return Uint8Array.from([Math.round(b.x) & 255, Math.round(b.y) & 255, Math.round(b.w) & 255, Math.round(b.h) & 255]);
  },
};

function gradGray(): Uint8Array {
  const g = new Uint8Array(72);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) g[y * 9 + x] = Math.round((x * 255) / 8);
  return g;
}

describe("parseAxElements", () => {
  it("coerces valid elements and keeps role/label/bbox/focused", () => {
    const els = coerceAxElements([saveButton, { role: "textfield", x: 0, y: 0, w: 10, h: 10 }]);
    expect(els).toHaveLength(2);
    expect(els[0]).toEqual(saveButton);
  });

  it("drops elements missing a role or a bbox coordinate", () => {
    const els = coerceAxElements([
      { label: "no role", x: 0, y: 0, w: 5, h: 5 },
      { role: "button", x: 0, y: 0, w: 5 }, // missing h
      { role: "button", label: "ok", x: 1, y: 2, w: 3, h: 4 },
    ]);
    expect(els).toEqual([{ role: "button", label: "ok", x: 1, y: 2, w: 3, h: 4 }]);
  });

  it("returns [] for malformed JSON or non-array input", () => {
    expect(parseAxElements("not json")).toEqual([]);
    expect(parseAxElements('{"role":"x"}')).toEqual([]);
    expect(parseAxElements(JSON.stringify([saveButton]))).toEqual([saveButton]);
  });
});

describe("SwiftAxSource (best-effort contract)", () => {
  it("resolves to [] when the sidecar binary is missing", async () => {
    const errs: string[] = [];
    const src = new SwiftAxSource({
      binaryPath: "/nonexistent/ax-dump-xyz",
      onError: (m) => errs.push(m),
    });
    expect(await src.query()).toEqual([]);
    expect(errs.length).toBeGreaterThan(0); // logged, never thrown
  });
});

describe("frame_ax store + AxCapturer", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-ax-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedFrame(): Promise<{ sessionId: string; frameId: string }> {
    const sessionId = ulid();
    const frameId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.putFrames([
      { id: frameId, sessionId, tMono: 1, width: 10, height: 10, phash: 1n, frameOffset: 0, segmentIds: [] },
    ]);
    return { sessionId, frameId };
  }

  it("round-trips AX elements and cascades on session delete", async () => {
    const { sessionId, frameId } = await seedFrame();
    await store.putFrameAx(frameId, [saveButton]);
    expect(store.getFrameAx(frameId)).toEqual([saveButton]);
    expect(store.getFrameAx("missing")).toEqual([]);

    await store.deleteSession(sessionId);
    expect(store.getFrameAx(frameId)).toEqual([]); // FK cascade with the frame
  });

  it("AxCapturer stores from a real source and no-ops for NoopAxSource", async () => {
    const { sessionId, frameId } = await seedFrame();
    const count = await new AxCapturer(
      store,
      fakeSource([saveButton]),
      sessionId,
      () => 1,
    ).capture("keyframe", frameId);
    expect(count).toBe(1);
    expect(store.getFrameAx(frameId)).toEqual([saveButton]);

    const { sessionId: s2, frameId: f2 } = await seedFrame();
    expect(
      await new AxCapturer(store, new NoopAxSource(), s2, () => 1).capture("keyframe", f2),
    ).toBe(0);
    expect(store.getFrameAx(f2)).toEqual([]);
  });

  it("writes a row even for an empty result, tagged with its reason", async () => {
    // The old `if (elements.length > 0)` made an AX-blind app indistinguishable
    // from a capture that never ran. `reason` exists to tell them apart and
    // cannot unless the empty row lands.
    const { sessionId } = await seedFrame();
    await new AxCapturer(store, new NoopAxSource(), sessionId, () => 42).capture("focus_change");
    const snap = store.getAxAt(sessionId, 42);
    expect(snap).toBeDefined();
    expect(snap!.elements).toEqual([]);
    expect(snap!.reason).toBe("focus_change");
    expect(snap!.frameId).toBeNull();
  });

  it("stamps a boundary capture with no frame", async () => {
    const { sessionId } = await seedFrame();
    await new AxCapturer(store, fakeSource([saveButton]), sessionId, () => 900).capture("bookmark");
    const snap = store.getAxAt(sessionId, 900)!;
    expect(snap.frameId).toBeNull();
    expect(snap.tMono).toBe(900);
    expect(snap.elements).toEqual([saveButton]);
  });
});

describe("StoredAxProvider through axFilter + fusion", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-axp-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters/fuses stored AX into labeled regions (drops window + sliver)", async () => {
    const sessionId = ulid();
    const frameId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.putFrames([
      { id: frameId, sessionId, tMono: 1, width: 1000, height: 1000, phash: 1n, frameOffset: 0, segmentIds: [] },
    ]);
    await store.putFrameAx(frameId, [
      { role: "window", x: 0, y: 0, w: 1000, h: 1000 }, // whole-window -> dropped
      { role: "button", x: 0, y: 0, w: 3, h: 3 }, // sliver -> dropped
      saveButton, // kept, labeled, focused
    ]);

    const frame = store.getFrame(frameId)!;
    const axTree = new StoredAxProvider(store).provide(frame);
    const regions = new FusedRegionProposer({ useGrid: false }).propose({
      frameW: frame.width,
      frameH: frame.height,
      axTree,
    });

    expect(regions).toHaveLength(1);
    expect(regions[0]!.source).toBe("ax");
    expect(regions[0]!.label).toBe("Save");
    expect(regions[0]!.priority).toBe(5); // base 2 + label 1 + focused 2
  });
});

describe("AX end-to-end: capture -> represent -> Tier 3", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-axe-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("region proposed from stored AX is embedded and found by AX-label FTS", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.putEvents([{ id: ulid(), sessionId, tMono: 0, kind: "mouse_move" }]);
    await store.endSession(sessionId, 1000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);
    const frame: SampledFrame = {
      tMono: 100, width: 1920, height: 1080, gray: gradGray(), grayW: 9, grayH: 8,
      image: { bytes: Uint8Array.from([1, 2, 3, 4]), codec: "png" },
    };
    const kf = await ing.ingest(frame);
    // Capture-time AX snapshot for this keyframe.
    await store.putFrameAx(kf.frameId!, [saveButton]);

    await new Segmenter(store).segment(sessionId);
    const result = await new RegionRepresenter(store, {
      axProvider: new StoredAxProvider(store).provide,
    }).represent(sessionId);
    expect(result.regionCount).toBeGreaterThan(0);

    const hits = await new Tier3Retriever(store).retrieveRegions({ text: "Save" }, [kf.frameId!]);
    const save = hits.find((h) => h.label === "Save")!;
    expect(save).toBeDefined();
    expect(save.bbox).toEqual({ x: 100, y: 100, w: 80, h: 30 });
  });
});

describe("CaptureSession AX wiring", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-axs-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  class OneFrameProducer implements Producer {
    readonly id = "screen";
    async start(ctx: CaptureContext): Promise<void> {
      await ctx.ingestFrame({ tMono: ctx.clock.now(), width: 10, height: 10, gray: gradGray(), grayW: 9, grayH: 8 });
    }
    stop(): void {}
  }

  it("captures the AX tree for each kept keyframe, and links it at represent time", async () => {
    const session = new CaptureSession(store, {
      deviceClockSource: new FakeDeviceClockSource(0),
      clock: MonotonicClock.start(),
      keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),
      axSource: fakeSource([saveButton]),
    });
    session.addProducer(new OneFrameProducer());
    const sessionId = await session.start();
    await session.stop();

    const frames = store.getFramesBySession(sessionId);
    expect(frames).toHaveLength(1);

    // The walk happens at capture, but it is NOT linked to a frame there: it
    // reads the screen a whole capture latency after the pixels the triggering
    // frame shows, so that frame is the wrong one by construction.
    const walks = store.getAxSnapshotsBySession(sessionId).filter((s) => s.reason === "keyframe");
    expect(walks).toHaveLength(1);
    expect(walks[0]!.frameId).toBeNull();
    expect(store.getFrameAx(frames[0]!.id)).toEqual([]);

    // `associateFrameAx` is what makes it readable — the always-on represent
    // stage that assigns each walk to the frame nearest its own t_mono.
    await associateFrameAx(store, sessionId);
    expect(store.getFrameAx(frames[0]!.id)).toEqual([saveButton]);
  });
});

describe("coerceAxElements — identifier", () => {
  it("carries a non-empty identifier through", () => {
    expect(
      coerceAxElements([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1, identifier: "send-btn" }]),
    ).toEqual([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1, identifier: "send-btn" }]);
  });

  it("omits the key entirely when absent or empty", () => {
    const [a] = coerceAxElements([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1 }]);
    expect("identifier" in a!).toBe(false);
    const [b] = coerceAxElements([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1, identifier: "" }]);
    expect("identifier" in b!).toBe(false);
  });

  it("ignores a non-string identifier", () => {
    const [a] = coerceAxElements([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1, identifier: 42 }]);
    expect("identifier" in a!).toBe(false);
  });
});

describe("parseAxResult", () => {
  it("reads the object shape the current sidecar emits", () => {
    const r = parseAxResult(
      '{"elements":[{"role":"Button","x":0,"y":0,"w":1,"h":1}],"url":"https://a.example/b"}',
    );
    expect(r.elements).toHaveLength(1);
    expect(r.url).toBe("https://a.example/b");
  });

  it("still reads a BARE ARRAY, so a stale binary loses only the url", () => {
    // A stale sidecar is this repo's classic silent failure — ax-dump ignored
    // --keymap for two days and every recording lost its typed text. Tolerating
    // the old shape means an un-rebuilt binary degrades instead of returning
    // nothing at all.
    const r = parseAxResult('[{"role":"Button","x":0,"y":0,"w":1,"h":1}]');
    expect(r.elements).toHaveLength(1);
    expect(r.url).toBeUndefined();
  });

  it("omits an empty url rather than carrying a meaningless one", () => {
    expect(parseAxResult('{"elements":[],"url":""}').url).toBeUndefined();
  });

  it("degrades to no elements on malformed json", () => {
    expect(parseAxResult("not json").elements).toEqual([]);
  });
});
