/**
 * Where DeskRAGApp keeps its library, and what it was configured with.
 *
 * This was written out eight times across the probes in three different
 * spellings — `join(homedir(), "Library/Application Support/deskrag-app/DeskRAG")`
 * and the five-argument `join(...)` form and a `--data` flag with its own
 * default. They agreed, which is luck: one of them is what a probe measures
 * AGAINST, so a probe pointed at the wrong directory reports an empty library
 * rather than an error.
 *
 * Read-only helpers only. Nothing here opens a store — see the note on
 * `openReadOnly` for why every probe that reads the real library must open
 * SQLite `readonly`.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `<userData>/DeskRAG` — the app's data directory. */
export const DATA_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "deskrag-app",
  "DeskRAG",
);

/** The relational source of truth. */
export const DB_PATH = join(DATA_DIR, "app.db");

/** Where the ONNX weights live, unless settings move them. */
export const MODELS_DIR = join(DATA_DIR, "models");

/** The app's settings file. */
export const SETTINGS_PATH = join(DATA_DIR, "settings.json");

/**
 * A settings.json, shaped only where the probes actually read it.
 *
 * Deliberately partial and deliberately not imported from the app: this is a
 * file on disk written by whatever version last ran, so every field a probe
 * touches is optional and every read has to cope with its absence.
 */
export interface ProbeSettings {
  providers?: {
    imageProvider?: string;
    captionProvider?: string;
    summaryProvider?: string;
    textModel?: string;
    ollamaHost?: string;
    ollamaCaptionModel?: string;
    ollamaSummaryModel?: string;
    localModels?: { dir?: string };
  };
}

/** The settings the app is configured with, or `{}` when there are none. */
export function readSettings(dataDir: string = DATA_DIR): ProbeSettings {
  const path = join(dataDir, "settings.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as ProbeSettings;
}

/** Where the ONNX weights are, honouring `localModels.dir`. */
export function modelsDirFrom(settings: ProbeSettings, dataDir: string = DATA_DIR): string {
  const dir = settings.providers?.localModels?.dir;
  return dir !== undefined && dir !== "" ? dir : join(dataDir, "models");
}

/**
 * Open the real library WITHOUT becoming a second owner of it.
 *
 * `readonly` is not politeness. DeskRAGApp takes no single-instance lock, and
 * `DualStore` DROPS retired vector spaces on open — a probe that opened the
 * store properly would change the thing it is measuring, while the app may be
 * running against the same files. Every read-only probe goes through here.
 *
 * Exits 1 with the path when there is no store, which is the difference between
 * "you have not recorded anything" and a probe that silently measures nothing.
 */
export function openReadOnly(dbPath: string = DB_PATH): Database.Database {
  if (!existsSync(dbPath)) {
    console.error(`No store at ${dbPath}`);
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}
