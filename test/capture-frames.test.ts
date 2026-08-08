import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { CaptureSession } from "../src/capture/session.js";
import { FakeDeviceClockSource } from "../src/capture/env/fake.js";
import { KeyframeBudget } from "../src/capture/keyframe-budget.js";
import type { CaptureContext, Producer } from "../src/capture/types.js";
import type { SampledFrame } from "../src/capture/frame-ingest.js";

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

/** A frame producer that pushes scripted gray frames through ctx.ingestFrame. */
class SyntheticFrameProducer implements Producer {
  readonly id = "screen";
  constructor(private readonly frames: Uint8Array[]) {}
  async start(ctx: CaptureContext): Promise<void> {
    for (const gray of this.frames) {
      const f: SampledFrame = { tMono: ctx.clock.now(), width: 1920, height: 1080, gray, grayW: 9, grayH: 8 };
      await ctx.ingestFrame(f);
    }
  }
  stop(): void {}
}

describe("CaptureSession frame ingestion", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-capf-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes producer frames through the budget into Tier-0-searchable keyframes", async () => {
    let mono = 0;
    const clock = MonotonicClock.start(() => mono++, () => 1000);
    const session = new CaptureSession(store, {
      deviceClockSource: new FakeDeviceClockSource(0),
      clock,
      keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),
    });
    // All three are kept: near-duplicate rejection is ffmpeg's job now
    // (mpdecimate), and at minIntervalMs 0 the budget rejects nothing. What
    // this asserts is the ROUTE — producer -> CaptureSession -> FrameIngestor
    // -> a frame row that Tier-0 can find.
    session.addProducer(
      new SyntheticFrameProducer([gradient(false), gradient(false), gradient(true)]),
    );

    const sessionId = await session.start();
    await session.stop();

    expect(store.phashPrefilter(0n, 64)).toHaveLength(3);
    // The two gradient(false) frames hash identically; gradient(true) is 64
    // bits away, so a radius of 5 separates them.
    expect(store.phashPrefilter(0n, 5)).toHaveLength(2);
    expect(store.getSession(sessionId)!.endedAt).not.toBeNull();
  });

  it("records a keyframe walk with NO frame, because capture cannot know which", async () => {
    // The walk starts when a frame ARRIVES, which is a whole capture latency
    // after the pixels that frame shows (~2.2s measured on a real device). The
    // triggering frame is therefore the wrong one by construction, and
    // `associateFrameAx` assigns the right one at represent time. Writing the
    // trigger here is what fed region proposal a tree from one screen and a
    // picture from another.
    let mono = 0;
    const clock = MonotonicClock.start(() => mono++, () => 1000);
    const session = new CaptureSession(store, {
      deviceClockSource: new FakeDeviceClockSource(0),
      clock,
      keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),
      axSource: { query: async () => [{ role: "Button", label: "Send", x: 0, y: 0, w: 10, h: 10 }] },
    });
    session.addProducer(new SyntheticFrameProducer([gradient(false)]));

    const sessionId = await session.start();
    await session.stop();

    const walks = store.getAxSnapshotsBySession(sessionId).filter((s) => s.reason === "keyframe");
    expect(walks).toHaveLength(1);
    expect(walks[0]!.frameId).toBeNull();
  });
});
