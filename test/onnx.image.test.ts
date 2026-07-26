import { describe, expect, it } from "vitest";
import { OnnxImageEmbedding } from "../src/embed/onnx/image.js";
import {
  CLIP_PREPROCESS,
  toNormalizedChw,
  type VisionPreprocessConfig,
} from "../src/embed/onnx/vision-preprocess.js";
import { namespaceFor } from "../src/embed/types.js";
import type { OnnxSession, OnnxTensor } from "../src/embed/onnx/runtime.js";

/**
 * Emits `[batch, tokens, dims]` where token 0 (CLS) is distinguishable from the
 * patch tokens. Mean-pooling instead of taking CLS would therefore produce a
 * DIFFERENT vector — which is what makes the pooling assertions below load
 * bearing rather than decorative.
 */
const TOKENS = 197; // 1 CLS + 14x14 patches, as the real graph emits
const DIMS = 4;

function stubSession(seen: Record<string, OnnxTensor>[]): OnnxSession {
  return {
    async run(feeds) {
      if (!feeds.pixel_values) throw new Error("input 'pixel_values' is missing in 'feeds'.");
      seen.push(feeds);
      const [batch] = feeds.pixel_values.dims as [number];
      const data = new Float32Array(batch * TOKENS * DIMS);
      for (let b = 0; b < batch; b++) {
        for (let t = 0; t < TOKENS; t++) {
          for (let d = 0; d < DIMS; d++) {
            // CLS carries the batch index; every patch token is a decoy.
            data[b * TOKENS * DIMS + t * DIMS + d] = t === 0 ? b + 1 : -99;
          }
        }
      }
      return { last_hidden_state: { data, dims: [batch, TOKENS, DIMS] } };
    },
  };
}

const tinyCfg: VisionPreprocessConfig = {
  width: 2,
  height: 2,
  mean: [0, 0, 0],
  std: [1, 1, 1],
  rescale: 1,
};

const make = (session: OnnxSession, over: Record<string, unknown> = {}) =>
  new OnnxImageEmbedding({
    modelPath: "/unused",
    dimensions: DIMS,
    preprocessConfig: tinyCfg,
    // deterministic stand-in for the sharp-backed preprocessor
    preprocess: async (image, cfg) =>
      new Float32Array(3 * cfg.height * cfg.width).fill(image[0] ?? 0),
    session,
    ...over,
  });

describe("OnnxImageEmbedding", () => {
  it("namespaces as a local provider, at its real defaults", () => {
    const p = new OnnxImageEmbedding({ modelPath: "/unused" });
    expect(namespaceFor("frame_image", p)).toBe(
      "frame_image:onnx:nomic-embed-vision-v1.5:768",
    );
    // region_image is a distinct space even for the same model
    expect(namespaceFor("region_image", p)).not.toBe(namespaceFor("frame_image", p));
  });

  it("declares sharedTextSpace false — our text path omits the layer_norm the alignment needs", () => {
    expect(make(stubSession([])).sharedTextSpace).toBe(false);
  });

  it("feeds pixel_values as [batch, 3, h, w]", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    // Explicit batchSize: the default is 1 (see the batch-invariance test), and
    // this is asserting the tensor LAYOUT, which needs a batch > 1 to be real.
    await make(stubSession(seen), { batchSize: 2 }).embedImages([
      Uint8Array.from([1]),
      Uint8Array.from([2]),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pixel_values!.dims).toEqual([2, 3, 2, 2]);
  });

  it("pools the CLS token, not the mean over patches", async () => {
    // CLS is +b, every patch token is -99. A mean would come out negative.
    const [a, b] = await make(stubSession([])).embedImages([
      Uint8Array.from([1]),
      Uint8Array.from([2]),
    ]);
    expect(a!.every((x) => x > 0)).toBe(true);
    expect(b!.every((x) => x > 0)).toBe(true);
  });

  it("L2-normalizes each vector", async () => {
    const [v] = await make(stubSession([])).embedImages([Uint8Array.from([1])]);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(v!.length).toBe(DIMS);
  });

  it("returns one vector per image, in order, across batch boundaries", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const images = [1, 2, 3, 4, 5].map((n) => Uint8Array.from([n]));
    const out = await make(stubSession(seen), { batchSize: 2 }).embedImages(images);
    expect(out).toHaveLength(5);
    // 5 images at batchSize 2 -> three forward passes of 2, 2, 1
    expect(seen.map((f) => f.pixel_values!.dims[0])).toEqual([2, 2, 1]);
  });

  it("defaults to batchSize 1, so a vector never depends on its batch", async () => {
    // Measured on the real int8 weights: the SAME image embedded at batch 1 vs
    // batch 2 comes back at cosine 0.992, not 1.0 — onnxruntime selects a
    // different kernel per batch dimension and int8 rounds differently. fp32 is
    // bit-exact, so this is quantization, not a bug here.
    //
    // It matters because the two sides are asymmetric by construction:
    // FrameRepresenter/RegionRepresenter embed every pending image in ONE call,
    // while Tier2/Tier3 always embed a query as [image]. Batching would put
    // stored and query vectors on different kernel paths permanently — and leave
    // each session's last partial batch inconsistent with its full ones.
    //
    // One image per pass costs ~16% throughput (72ms vs 60ms per image) and buys
    // exact comparability. Raise it only if you have re-measured that drift.
    const seen: Record<string, OnnxTensor>[] = [];
    const images = [1, 2, 3].map((n) => Uint8Array.from([n]));
    await make(stubSession(seen), { batchSize: undefined }).embedImages(images);
    expect(seen.map((f) => f.pixel_values!.dims[0])).toEqual([1, 1, 1]);
  });

  it("returns [] for no images without touching the session", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    expect(await make(stubSession(seen)).embedImages([])).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("toNormalizedChw", () => {
  it("lays pixels out channel-planar, not interleaved", () => {
    // 2x1 image: pixel0 = (10,20,30), pixel1 = (40,50,60)
    const rgb = Uint8Array.from([10, 20, 30, 40, 50, 60]);
    const cfg: VisionPreprocessConfig = {
      width: 2,
      height: 1,
      mean: [0, 0, 0],
      std: [1, 1, 1],
      rescale: 1,
    };
    expect(Array.from(toNormalizedChw(rgb, 2, 1, cfg))).toEqual([
      10, 40, // R plane
      20, 50, // G plane
      30, 60, // B plane
    ]);
  });

  it("normalizes per channel, not with one shared constant", () => {
    const rgb = Uint8Array.from([255, 255, 255]);
    const out = toNormalizedChw(rgb, 1, 1, CLIP_PREPROCESS);
    // (1 - mean[c]) / std[c] — three different values, since CLIP's constants
    // are asymmetric across channels (unlike ColSmol's 0.5/0.5).
    expect(out[0]).toBeCloseTo((1 - 0.48145466) / 0.26862954, 5);
    expect(out[1]).toBeCloseTo((1 - 0.4578275) / 0.26130258, 5);
    expect(out[2]).toBeCloseTo((1 - 0.40821073) / 0.27577711, 5);
    expect(new Set(Array.from(out)).size).toBe(3);
  });

  it("maps the black/white range onto the model's expected scale", () => {
    const black = toNormalizedChw(Uint8Array.from([0, 0, 0]), 1, 1, CLIP_PREPROCESS);
    const white = toNormalizedChw(Uint8Array.from([255, 255, 255]), 1, 1, CLIP_PREPROCESS);
    for (let c = 0; c < 3; c++) {
      expect(black[c]!).toBeLessThan(0);
      expect(white[c]!).toBeGreaterThan(0);
    }
  });
});
