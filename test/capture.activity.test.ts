/**
 * The live activity tee.
 *
 * `CaptureSession` is the only component that sees every producer, which is what
 * makes a per-signal readout possible without touching a single producer or
 * polling the store. These cases pin the four convergence points and — the part
 * that matters most — that an observer can NEVER take a recording down with it.
 * Capture is real-time and unrepeatable; a meter is decoration.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session.js";
import { FakeDeviceClockSource } from "../src/capture/env/fake.js";
import { SyntheticInputProducer } from "../src/capture/synthetic.js";
import { encodeWav } from "../src/capture/producers/wav.js";
import { DualStore } from "../src/store/store.js";
import type { AxSource } from "../src/capture/ax/types.js";
import type { CaptureActivity, CaptureContext, Producer } from "../src/capture/types.js";
import type { UIElement } from "../src/embed/types.js";

const button: UIElement = { role: "Button", label: "Send", x: 0, y: 0, w: 10, h: 10 };
const fakeAx = (els: UIElement[]): AxSource => ({ query: async () => els });

/** Hands the context back so a case can drive ingestFrame/ingestAudio directly. */
class HarnessProducer implements Producer {
  readonly id = "harness";
  private ctx: CaptureContext | undefined;
  constructor(private readonly run: (ctx: CaptureContext) => Promise<void>) {}
  async start(ctx: CaptureContext): Promise<void> {
    this.ctx = ctx;
    await this.run(ctx);
  }
  stop(): void {
    void this.ctx;
  }
}

/** A 16-bit mono WAV of `frames` samples, every one at `amplitude` (-1..1). */
function wavOf(frames: number, amplitude: number): Uint8Array {
  const pcm = new Uint8Array(frames * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < frames; i++) dv.setInt16(i * 2, Math.round(amplitude * 32767), true);
  return encodeWav(pcm, { sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
}

async function withSession(
  build: (session: CaptureSession) => void,
  opts: { onActivity?: (a: CaptureActivity) => void; axSource?: AxSource } = {},
): Promise<{ sessionId: string; store: DualStore; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "erag-activity-"));
  const store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  const session = new CaptureSession(store, {
    deviceClockSource: new FakeDeviceClockSource(0),
    // Long settle so only stop()'s flush fires the boundary walk — no race.
    axSettleMs: 10_000,
    ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
    ...(opts.axSource ? { axSource: opts.axSource } : {}),
  });
  build(session);
  const sessionId = await session.start();
  await session.stop();
  return {
    sessionId,
    store,
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("CaptureSession activity tee", () => {
  it("reports every event a producer emits, with its kind and stamp", async () => {
    const seen: CaptureActivity[] = [];
    const { dispose } = await withSession(
      (s) =>
        s.addProducer(
          new SyntheticInputProducer("script", [
            { kind: "key_down", data: { keycode: 30 } },
            { kind: "mouse_down" },
            { kind: "scroll" },
          ]),
        ),
      { onActivity: (a) => void seen.push(a) },
    );
    try {
      const events = seen.filter((a) => a.kind === "event");
      expect(events.map((a) => (a as { eventKind: string }).eventKind)).toEqual([
        "key_down",
        "mouse_down",
        "scroll",
      ]);
      expect(events.every((a) => typeof (a as { tMono: number }).tMono === "number")).toBe(true);
      // The payload rides along: the Active window readout names the app from it.
      expect((events[0] as { data?: unknown }).data).toEqual({ keycode: 30 });
    } finally {
      dispose();
    }
  });

  it("reports DROPPED frames as well as kept ones", async () => {
    // A count of kept frames alone cannot distinguish "the screen was still"
    // from "nothing is arriving", which is the failure a live meter exists for.
    const seen: CaptureActivity[] = [];
    const gray = new Uint8Array(81).fill(7);
    const { dispose } = await withSession(
      (s) =>
        s.addProducer(
          new HarnessProducer(async (ctx) => {
            await ctx.ingestFrame({ tMono: 0, width: 100, height: 50, gray, grayW: 9, grayH: 9 });
            // Inside the keyframe budget's 500ms floor, so this one is dropped.
            await ctx.ingestFrame({ tMono: 10, width: 100, height: 50, gray, grayW: 9, grayH: 9 });
          }),
        ),
      { onActivity: (a) => void seen.push(a) },
    );
    try {
      const frames = seen.filter((a) => a.kind === "frame") as { kept: boolean }[];
      expect(frames.map((f) => f.kept)).toEqual([true, false]);
    } finally {
      dispose();
    }
  });

  it("reports an audio chunk's PEAK ENVELOPE, and 0 for digital silence", async () => {
    // The silent-microphone default recorded −91 dB for a whole session and every
    // row about it looked healthy: byte counts exact, spans contiguous, no error
    // anywhere. Only the samples said otherwise, so the samples are what the tee
    // reports.
    const seen: CaptureActivity[] = [];
    const { dispose } = await withSession(
      (s) =>
        s.addProducer(
          new HarnessProducer(async (ctx) => {
            await ctx.ingestAudio({
              bytes: wavOf(1600, 0.5),
              tMonoStart: 0,
              tMonoEnd: 100,
              media: "mic",
              codec: "wav",
            });
            await ctx.ingestAudio({
              bytes: wavOf(1600, 0),
              tMonoStart: 100,
              tMonoEnd: 200,
              media: "mic",
              codec: "wav",
            });
          }),
        ),
      { onActivity: (a) => void seen.push(a) },
    );
    try {
      const audio = seen.filter((a) => a.kind === "audio") as {
        peaks: number[] | null;
        byteLength: number;
        media: string;
      }[];
      expect(audio).toHaveLength(2);
      expect(audio[0]!.media).toBe("mic");
      expect(audio[0]!.byteLength).toBe(44 + 3200);
      expect(Math.max(...audio[0]!.peaks!)).toBeCloseTo(0.5, 2);
      // Silence is a real reading of real bytes — not null, which means
      // "these bytes are not readable PCM" and is a different claim.
      expect(Math.max(...audio[1]!.peaks!)).toBe(0);
    } finally {
      dispose();
    }
  });

  it("reports null peaks for bytes that are not readable PCM", async () => {
    const seen: CaptureActivity[] = [];
    const { dispose } = await withSession(
      (s) =>
        s.addProducer(
          new HarnessProducer(async (ctx) => {
            await ctx.ingestAudio({
              bytes: new Uint8Array([1, 2, 3, 4]),
              tMonoStart: 0,
              tMonoEnd: 10,
              media: "mic",
              codec: "aac",
            });
          }),
        ),
      { onActivity: (a) => void seen.push(a) },
    );
    try {
      const audio = seen.find((a) => a.kind === "audio") as { peaks: number[] | null };
      expect(audio.peaks).toBeNull();
    } finally {
      dispose();
    }
  });

  it("reports an AX walk's ELEMENT COUNT, which both call sites used to discard", async () => {
    const seen: CaptureActivity[] = [];
    const { dispose } = await withSession(
      (s) => s.addProducer(new SyntheticInputProducer("script", [{ kind: "focus_change" }])),
      { onActivity: (a) => void seen.push(a), axSource: fakeAx([button, button]) },
    );
    try {
      const ax = seen.filter((a) => a.kind === "ax") as { reason: string; elements: number }[];
      expect(ax).toHaveLength(1);
      expect(ax[0]).toEqual({ kind: "ax", reason: "focus_change", elements: 2 });
    } finally {
      dispose();
    }
  });

  it("A THROWING OBSERVER CANNOT SINK THE RECORDING", async () => {
    // The whole reason the tee is allowed on the capture path. A recording cannot
    // be taken again; a readout can be wrong for a second.
    const gray = new Uint8Array(81).fill(3);
    const { sessionId, store, dispose } = await withSession(
      (s) => {
        s.addProducer(new SyntheticInputProducer("script", [{ kind: "focus_change" }]));
        s.addProducer(
          new HarnessProducer(async (ctx) => {
            await ctx.ingestFrame({ tMono: 0, width: 100, height: 50, gray, grayW: 9, grayH: 9 });
          }),
        );
      },
      {
        onActivity: () => {
          throw new Error("observer exploded");
        },
        axSource: fakeAx([button]),
      },
    );
    try {
      expect(store.getEventsBySession(sessionId).map((e) => e.kind)).toContain("focus_change");
      expect(store.getFramesBySession(sessionId)).toHaveLength(1);
      expect(store.getAxAt(sessionId, 1e9)?.elements).toEqual([button]);
    } finally {
      dispose();
    }
  });

  it("runs with no observer at all", async () => {
    const { sessionId, store, dispose } = await withSession((s) =>
      s.addProducer(new SyntheticInputProducer("script", [{ kind: "mouse_down" }])),
    );
    try {
      expect(store.getEventsBySession(sessionId)).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
