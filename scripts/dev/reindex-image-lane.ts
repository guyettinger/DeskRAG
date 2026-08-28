/**
 * Re-run the image lane over an ALREADY RECORDED session.
 *
 WRITES TO THE REAL STORE. QUIT DESKRAGAPP FIRST: a second process opening the same DualStore/LanceDB
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
 *   npm run dev:reindex-image-lane -- --session <id> [--models <dir>]
 *   npm run dev:reindex-image-lane -- --list
 *
 * Runs under tsx against `src/`.
 */

import { join } from "node:path";
import { DualStore } from "../../src/store/store.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { FramePatchRepresenter } from "../../src/represent/frame-patch-representer.js";
import { arg, flag } from "../lib/args.js";
import { DATA_DIR as DEFAULT_DATA_DIR, readSettings } from "../lib/paths.js";

const DATA_DIR = process.env.DESKRAG_DATA_DIR ?? DEFAULT_DATA_DIR;
// `arg` takes the flag name WITHOUT dashes — this file used to pass "--models",
// which its own local copy of `arg` expected and the shared one does not.
const MODELS_DIR = arg("models", process.env.DESKRAG_MODELS_DIR ?? join(DATA_DIR, "models"));

/**
 * Build the embedder the SETTINGS name, so this cannot silently index with a
 * different model from the one the app will search with — the namespace is
 * derived from the provider, so a mismatch reads as "indexed nothing".
 */
async function embedderFor(provider: string | undefined) {
  if (provider !== "colmodernvbert") {
    throw new Error(`imageProvider is "${provider}" — nothing to index`);
  }
  const m = await import("../../src/embed/onnx/colmodernvbert.js");
  const dir = join(MODELS_DIR, "colmodernvbert-250m");
  return new m.ColModernVBertMultiVector({
    modelPath: join(dir, "model.onnx"),
    tokenizerPath: join(dir, "tokenizer.json"),
    // Its own reader: this config puts pixel_shuffle_factor at the top level,
    // and the value also travels to the highlighter as `provider.tileConfig`.
    tileConfig: await m.readTileConfig(
      join(dir, "preprocessor_config.json"),
      join(dir, "config.json"),
    ),
  });
}

const store = await DualStore.open(join(DATA_DIR, "app.db"), join(DATA_DIR, "lance"));

if (flag("list")) {
  for (const s of store.listSessions()) {
    console.log(`${s.id}  frames=${s.frameCount ?? "?"}  segments=${s.segmentCount ?? "?"}`);
  }
  store.close();
  process.exit(0);
}

const sessionId = arg("session");
if (sessionId === undefined) {
  console.error("usage: npm run dev:reindex-image-lane -- --session <id> | --list");
  process.exit(1);
}

const settings = readSettings(DATA_DIR);
const provider = settings.providers?.imageProvider;
const embedder = await embedderFor(provider);

const frames = store.getFramesBySession(sessionId);
if (frames.length === 0) {
  console.error(`session ${sessionId} has no frames`);
  process.exit(1);
}
console.log(`provider : ${provider} (${embedder.model})`);
console.log(`session  : ${sessionId}, ${frames.length} frames`);

const blobs = new BlobStore(join(DATA_DIR, "blobs"));
const t0 = Date.now();
const rep = new FramePatchRepresenter(store, {
  patchEmbedder: embedder,
  blobStore: blobs,
  onProgress: (done, total) => {
    const el = (Date.now() - t0) / 1000;
    const eta = done > 0 ? (el / done) * (total - done) : 0;
    process.stdout.write(
      `\r  ${done}/${total} frames · ${el.toFixed(0)}s elapsed · ~${eta.toFixed(0)}s left   `,
    );
  },
});

const res = await rep.represent(sessionId);
process.stdout.write("\n");
const secs = (Date.now() - t0) / 1000;
console.log(`namespace: ${res.namespace}`);
console.log(
  `embedded : ${res.embeddedCount}/${res.frameCount} frames in ${secs.toFixed(0)}s ` +
    `(${(secs / Math.max(1, res.frameCount)).toFixed(1)}s/frame)`,
);
store.close();
