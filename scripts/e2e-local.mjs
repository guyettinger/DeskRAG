/**
 * End-to-end exercise of the fully-local pipeline, against REAL weights.
 *
 * Nothing here is faked: real ColModernVBERT patch embeddings, a real DualStore on
 * disk, a real LanceDB multivector table, a real MaxSim search, real highlight
 * boxes. This is the thing the unit tests cannot prove.
 *
 *   node scripts/e2e-local.mjs <modelsDir>
 *
 * Requires `npm run build` first (imports dist/).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";

import { DualStore } from "../dist/store/store.js";
import { BlobStore } from "../dist/store/blob-store.js";
import { FramePatchRepresenter } from "../dist/represent/frame-patch-representer.js";
import { Retriever } from "../dist/retrieve/assemble.js";
import { ColModernVBertMultiVector } from "../dist/embed/onnx/colmodernvbert.js";
import { OnnxTextEmbedding } from "../dist/embed/onnx/text.js";

const MODELS = process.argv[2];
if (!MODELS) {
  console.error("usage: node scripts/e2e-local.mjs <modelsDir>");
  process.exit(1);
}
const FIXTURES = new URL("../test/fixtures/", import.meta.url).pathname;
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const dir = mkdtempSync(join(tmpdir(), "deskrag-e2e-"));
step(`workspace ${dir}`);

const store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
const blobs = new BlobStore(join(dir, "blobs"));

const patchEmbedder = new ColModernVBertMultiVector({
  modelPath: join(MODELS, "colmodernvbert-250m", "model.onnx"),
  tokenizerPath: join(MODELS, "colmodernvbert-250m", "tokenizer.json"),
});
const textEmbedder = new OnnxTextEmbedding({
  modelPath: join(MODELS, "nomic-embed-text-v1.5", "model_int8.onnx"),
  tokenizerPath: join(MODELS, "nomic-embed-text-v1.5", "tokenizer.json"),
});
step("providers constructed");

// --- a session with two real screenshots -----------------------------------
const sessionId = ulid();
await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
await store.putSegments([
  { id: "seg-login", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
  { id: "seg-term", sessionId, granularity: "action", tMonoStart: 1000, tMonoEnd: 2000 },
]);

const frames = [
  { id: "f-login", file: "login.png", tMono: 500 },
  { id: "f-term", file: "terminal.png", tMono: 1500 },
];
for (const f of frames) {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, f.file)));
  const blob = await blobs.write(sessionId, "keyframe", bytes, {
    tMonoStart: f.tMono,
    tMonoEnd: f.tMono,
    codec: "png",
  });
  await store.putBlobs([blob]);
  await store.putFrames([
    {
      id: f.id,
      sessionId,
      tMono: f.tMono,
      width: 2560,
      height: 1600,
      phash: 0n,
      blobId: blob.id,
      frameOffset: 0,
      segmentIds: [],
    },
  ]);
}
step(`captured ${frames.length} frames`);

// --- index -----------------------------------------------------------------
const rep = new FramePatchRepresenter(store, {
  patchEmbedder,
  blobStore: blobs,
  onProgress: (done, total) => step(`  embedding frame ${done}/${total}`),
});
const res = await rep.represent(sessionId);
step(`indexed: ${JSON.stringify(res)}`);

const spaces = store.listVectorSpaces();
step(`vector spaces: ${spaces.map((s) => s.namespace).join(", ")}`);

// --- search ----------------------------------------------------------------
const retriever = new Retriever(store, { searchers: [], patchEmbedder }, { highlightTopN: 2 });

let failures = 0;
for (const [query, expected] of [
  ["a login form with a sign in button", "f-login"],
  ["a terminal showing a build error", "f-term"],
]) {
  const qStart = Date.now();
  const { frames: hits } = await retriever.retrieve({ text: query });
  const ms = Date.now() - qStart;
  const top = hits[0];
  const ok = top?.frameId === expected;
  if (!ok) failures++;
  step(
    `query ${JSON.stringify(query)} -> ${hits.map((h) => `${h.frameId}(${h.score.toFixed(3)})`).join(", ")}` +
      `  [${ms}ms] ${ok ? "OK" : `WRONG, expected ${expected}`}`,
  );
  if (top) {
    step(
      `  highlights: ${top.highlights.length}` +
        (top.highlights[0]
          ? ` first=${JSON.stringify({
              x: Math.round(top.highlights[0].bbox.x),
              y: Math.round(top.highlights[0].bbox.y),
              w: Math.round(top.highlights[0].bbox.w),
              h: Math.round(top.highlights[0].bbox.h),
            })}`
          : ""),
    );
  }
}

// --- scoped search (Tier-1 narrowing must still work) -----------------------
const scoped = await retriever.retrieve({ text: "a login form" });
step(`unscoped recall returned ${scoped.frames.length} frames`);

// --- text embedder on the same store ---------------------------------------
const [tv] = await textEmbedder.embed(["a login form"], { role: "query" });
step(`text embedder: ${tv.length}-dim vector`);

store.close();
rmSync(dir, { recursive: true, force: true });
step(failures === 0 ? "END-TO-END OK" : `END-TO-END FAILED (${failures} wrong top hits)`);
process.exit(failures === 0 ? 0 : 1);
