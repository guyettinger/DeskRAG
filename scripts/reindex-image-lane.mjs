/**
 * Re-run the image lane over an ALREADY RECORDED session.
 *
 * WRITES TO THE REAL STORE — unlike scripts/imagelane-probe.mjs, which copies it.
 * QUIT DESKRAGAPP FIRST: a second process opening the same DualStore/LanceDB
 * does not share it.
 *
 * This exists because the app has no path to it. `DeskRagService.index()` is
 * private and runs exactly once, when a recording stops, so switching the image
 * model in Settings changes nothing about recordings already on disk — their
 * vectors stay in the OLD model's namespace and the new one's table stays empty.
 * `namespaceFor` keys one physical table per model, so re-running here ADDS a
 * space rather than replacing one: the old vectors are left intact and still
 * searchable if you switch back.
 *
 * Safe to re-run: putFramePatches deletes by frame id before adding, so a second
 * pass replaces rather than duplicates.
 *
 *   node scripts/reindex-image-lane.mjs --session <id> [--models <dir>]
 *   node scripts/reindex-image-lane.mjs --list
 *
 * Requires `npm run build` first (imports dist/).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DualStore } from "../dist/store/store.js";
import { BlobStore } from "../dist/store/blob-store.js";
import { FramePatchRepresenter } from "../dist/represent/frame-patch-representer.js";
import { FrameRepresenter } from "../dist/represent/frame-representer.js";

const DATA_DIR =
  process.env.DESKRAG_DATA_DIR ??
  join(homedir(), "Library", "Application Support", "deskrag-app", "DeskRAG");

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const MODELS_DIR = arg("--models", process.env.DESKRAG_MODELS_DIR ?? join(DATA_DIR, "models"));

/**
 * Build the embedder the SETTINGS name, so this cannot silently index with a
 * different model from the one the app will search with — the namespace is
 * derived from the provider, so a mismatch reads as "indexed nothing".
 */
async function embedderFor(provider) {
  if (provider === "colmodernvbert") {
    const m = await import("../dist/embed/onnx/colmodernvbert.js");
    const dir = join(MODELS_DIR, "colmodernvbert-250m");
    return {
      kind: "multi",
      embedder: new m.ColModernVBertMultiVector({
        modelPath: join(dir, "model.onnx"),
        tokenizerPath: join(dir, "tokenizer.json"),
        tileConfig: await m.readTileConfig(
          join(dir, "preprocessor_config.json"),
          join(dir, "config.json"),
        ),
      }),
    };
  }
  if (provider === "colsmol") {
    const m = await import("../dist/embed/onnx/colsmol.js");
    const dir = join(MODELS_DIR, "colSmol-256M-dynamic");
    return {
      kind: "multi",
      embedder: new m.ColSmolMultiVector({
        modelPath: join(dir, "model.onnx"),
        tokenizerPath: join(dir, "tokenizer.json"),
        tileConfig: await m.readTileConfig(
          join(dir, "preprocessor_config.json"),
          join(dir, "config.json"),
        ),
      }),
    };
  }
  if (provider === "nomic") {
    const m = await import("../dist/embed/onnx/image.js");
    const dir = join(MODELS_DIR, "nomic-embed-vision-v1.5");
    return {
      kind: "single",
      embedder: new m.OnnxImageEmbedding({
        modelPath: join(dir, "model_int8.onnx"),
        preprocessorPath: join(dir, "preprocessor_config.json"),
      }),
    };
  }
  throw new Error(`imageProvider is "${provider}" — nothing to index`);
}

const store = await DualStore.open(join(DATA_DIR, "app.db"), join(DATA_DIR, "lance"));

if (process.argv.includes("--list")) {
  for (const s of store.listSessions()) {
    console.log(`${s.id}  frames=${s.frameCount ?? "?"}  segments=${s.segmentCount ?? "?"}`);
  }
  store.close();
  process.exit(0);
}

const sessionId = arg("--session", null);
if (!sessionId) {
  console.error("usage: node scripts/reindex-image-lane.mjs --session <id> | --list");
  process.exit(1);
}

const settings = JSON.parse(readFileSync(join(DATA_DIR, "settings.json"), "utf8"));
const provider = settings.providers.imageProvider;
const { kind, embedder } = await embedderFor(provider);

const frames = store.getFramesBySession(sessionId);
if (frames.length === 0) {
  console.error(`session ${sessionId} has no frames`);
  process.exit(1);
}
console.log(`provider : ${provider} (${embedder.model}, ${kind})`);
console.log(`session  : ${sessionId}, ${frames.length} frames`);

const blobs = new BlobStore(join(DATA_DIR, "blobs"));
const t0 = Date.now();
const rep =
  kind === "multi"
    ? new FramePatchRepresenter(store, {
        patchEmbedder: embedder,
        blobStore: blobs,
        onProgress: (done, total) => {
          const el = (Date.now() - t0) / 1000;
          const eta = done > 0 ? (el / done) * (total - done) : 0;
          process.stdout.write(
            `\r  ${done}/${total} frames · ${el.toFixed(0)}s elapsed · ~${eta.toFixed(0)}s left   `,
          );
        },
      })
    : new FrameRepresenter(store, { imageEmbedder: embedder, blobStore: blobs });

const res = await rep.represent(sessionId);
process.stdout.write("\n");
const secs = (Date.now() - t0) / 1000;
console.log(`namespace: ${res.namespace}`);
console.log(
  `embedded : ${res.embeddedCount}/${res.frameCount} frames in ${secs.toFixed(0)}s ` +
    `(${(secs / Math.max(1, res.frameCount)).toFixed(1)}s/frame)`,
);
store.close();
