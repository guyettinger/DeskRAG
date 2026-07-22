import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { CaptureSession } from "../src/capture/session.js";
import { KeyframeGate } from "../src/capture/keyframe.js";
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

  it("routes producer frames through the gate into Tier-0-searchable keyframes", async () => {
    let mono = 0;
    const clock = MonotonicClock.start(() => mono++, () => 1000);
    const session = new CaptureSession(store, {
      clock,
      keyframeGate: new KeyframeGate({ hammingThreshold: 10 }),
    });
    // gradient, identical (dup, dropped), reversed (distinct) -> 2 keyframes.
    session.addProducer(
      new SyntheticFrameProducer([gradient(false), gradient(false), gradient(true)]),
    );

    const sessionId = await session.start();
    await session.stop();

    // Two keyframes kept; both findable by pHash, the near one distinct from far.
    const all = store.phashPrefilter(0n, 64);
    expect(all).toHaveLength(2);
    expect(store.phashPrefilter(0n, 5)).toHaveLength(1); // only the gradient(false) frame
    expect(store.getSession(sessionId)!.endedAt).not.toBeNull();
  });
});
