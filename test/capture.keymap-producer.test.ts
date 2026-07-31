import { describe, expect, it } from "vitest";
import { KeymapProducer } from "../src/capture/producers/keymap-producer.js";
import { FakeKeymapSource } from "../src/capture/env/fake.js";
import type { Keymap } from "../src/capture/env/types.js";
import type { CaptureContext, EmittedEvent } from "../src/capture/types.js";
import { MonotonicClock } from "../src/timeline/clock.js";

const us: Keymap = { layoutId: "com.apple.keylayout.US", entries: { 0: ["a", "A", "å", "Å"] } };
const dvorak: Keymap = { layoutId: "com.apple.keylayout.Dvorak", entries: { 0: ["a", "A", "å", "Å"] } };

function harness(): { ctx: CaptureContext; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const ctx = {
    sessionId: "s1",
    clock: MonotonicClock.start(),
    emitEvent: (ev: EmittedEvent) => void events.push(ev),
    ingestFrame: async () => ({ kept: false }),
    ingestAudio: async () => {},
    reserveBlob: async () => null,
    commitBlob: async () => {},
  } as unknown as CaptureContext;
  return { ctx, events };
}

describe("KeymapProducer", () => {
  it("emits the layout once on the first poll", async () => {
    const { ctx, events } = harness();
    await new KeymapProducer(new FakeKeymapSource(us)).pollOnce(ctx);
    expect(events).toEqual([{ kind: "keymap_change", data: us }]);
  });

  it("does not re-emit while the layout is unchanged", async () => {
    const { ctx, events } = harness();
    const p = new KeymapProducer(new FakeKeymapSource(us));
    await p.pollOnce(ctx);
    await p.pollOnce(ctx);
    expect(events).toHaveLength(1);
  });

  it("emits again when the layout changes mid-session", async () => {
    const { ctx, events } = harness();
    const src = new FakeKeymapSource(us);
    const p = new KeymapProducer(src);
    await p.pollOnce(ctx);
    src.set(dvorak);
    await p.pollOnce(ctx);
    expect(events.map((e) => (e.data as Keymap).layoutId)).toEqual([
      "com.apple.keylayout.US",
      "com.apple.keylayout.Dvorak",
    ]);
  });

  it("emits nothing when the source yields nothing, and recovers later", async () => {
    const { ctx, events } = harness();
    const src = new FakeKeymapSource(undefined);
    const p = new KeymapProducer(src);
    await p.pollOnce(ctx);
    expect(events).toHaveLength(0);
    src.set(us);
    await p.pollOnce(ctx);
    expect(events).toHaveLength(1);
  });

  it("does not overlap slow queries", async () => {
    const { ctx } = harness();
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = {
      query: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return us;
      },
    };
    const p = new KeymapProducer(slow);
    await Promise.all([p.pollOnce(ctx), p.pollOnce(ctx), p.pollOnce(ctx)]);
    expect(maxInFlight).toBe(1);
  });
});
