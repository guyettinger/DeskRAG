/**
 * Building the image provider the app is CONFIGURED with.
 *
 * `highlight` and `patch-geometry` carried byte-identical copies of the model
 * directory resolution and the constructor call, and `reindex-image-lane` a
 * third variant. There is one image provider (`colmodernvbert`, or `none`), so
 * the only real decision here is where its weights are — and a probe that
 * guessed that would measure a model the app does not use.
 */

import { join } from "node:path";
import { ColModernVBertMultiVector } from "../../src/embed/onnx/colmodernvbert.js";
import { DATA_DIR, modelsDirFrom, readSettings, type ProbeSettings } from "./paths.js";

/** The one image model's directory name under `models/`. */
export const COLMODERNVBERT_DIR = "colmodernvbert-250m";

/**
 * The configured image embedder.
 *
 * Exits 1 when `imageProvider` is not `colmodernvbert`: a probe over patch
 * vectors run against an install with the image lane off would find no table
 * and report an empty measurement, which reads like a finding.
 */
export function colModernVBertFromSettings(
  dataDir: string = DATA_DIR,
  settings: ProbeSettings = readSettings(dataDir),
): ColModernVBertMultiVector {
  const which = settings.providers?.imageProvider;
  if (which !== "colmodernvbert") {
    console.error(`imageProvider is "${which}" — this probe needs the image provider set`);
    process.exit(1);
  }
  const modelDir = join(modelsDirFrom(settings, dataDir), COLMODERNVBERT_DIR);
  return new ColModernVBertMultiVector({
    modelPath: join(modelDir, "model.onnx"),
    tokenizerPath: join(modelDir, "tokenizer.json"),
  });
}

/**
 * The Lance table one provider's patch vectors live in.
 *
 * Namespaced `view:provider:model:dimensions` — see `src/embed/types.ts`. Built
 * from the provider itself rather than typed out, because a namespace that
 * disagrees with the provider by one character opens nothing and looks like an
 * unindexed library.
 */
export const patchTableName = (provider: ColModernVBertMultiVector): string =>
  `frame_patches__${provider.id}__${provider.model}__${provider.dimensions}`;
