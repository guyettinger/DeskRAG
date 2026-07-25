/**
 * Downloads and verifies model weights into <userData>/DeskRAG/models/<id>/.
 *
 * Streams to <file>.partial, verifies SHA-256, then renames atomically — a
 * partial file never looks complete, so an interrupted download cannot poison a
 * namespace. Same discipline as reserveBlob/commitBlob in the library.
 *
 * On checksum mismatch it DELETES and THROWS. There is no fallback to an
 * unverified file: wrong weights produce vectors that are silently wrong while
 * sitting in a table claiming otherwise.
 *
 * Locally-produced models (ColSmol) are not downloaded at all — see models.ts.
 * They are checked for presence and, when absent, reported with the exact setup
 * command rather than a bare ENOENT.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ModelSpec } from "./models.js";

export interface ModelDownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
}

export interface ModelStoreOptions {
  /** Air-gapped escape hatch: read from here, skip download AND verification. */
  overrideDir?: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  onProgress?: (p: ModelDownloadProgress) => void;
}

/** Thrown when a locally-produced model has not been built yet. */
export class ModelNotBuiltError extends Error {
  constructor(
    readonly modelId: string,
    readonly missing: string[],
    hint: string,
    dir: string,
  ) {
    super(
      `Model "${modelId}" is not built. Missing in ${dir}: ${missing.join(", ")}\n\n${hint}`,
    );
    this.name = "ModelNotBuiltError";
  }
}

export class ModelStore {
  private readonly overrideDir: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onProgress: ((p: ModelDownloadProgress) => void) | undefined;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly dir: string,
    opts: ModelStoreOptions = {},
  ) {
    this.overrideDir =
      opts.overrideDir && opts.overrideDir.length > 0 ? opts.overrideDir : undefined;
    this.baseUrl = opts.baseUrl ?? "https://huggingface.co";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.onProgress = opts.onProgress;
  }

  /** Directory that will hold a spec's files, download or not. */
  dirFor(spec: ModelSpec): string {
    return join(this.overrideDir ?? this.dir, spec.id);
  }

  /** Absolute path to one of a spec's files, by basename. */
  fileFor(spec: ModelSpec, name: string): string {
    return join(this.dirFor(spec), name);
  }

  /**
   * Local directory holding the spec's files, downloading them if needed.
   * Concurrent calls for the same model share one promise — two downloads of the
   * same weights would race on the same `.partial`.
   */
  ensure(spec: ModelSpec): Promise<string> {
    const existing = this.inflight.get(spec.id);
    if (existing) return existing;
    const p = this.ensureOnce(spec).finally(() => this.inflight.delete(spec.id));
    this.inflight.set(spec.id, p);
    return p;
  }

  private async ensureOnce(spec: ModelSpec): Promise<string> {
    const target = this.dirFor(spec);

    if (spec.source === "local") {
      const missing = spec.files
        .map((f) => basename(f.path))
        .filter((name) => !existsSync(join(target, name)));
      if (missing.length > 0) {
        throw new ModelNotBuiltError(
          spec.id,
          missing,
          spec.setupHint ?? "See scripts/ for the build step.",
          target,
        );
      }
      return target;
    }

    if (this.overrideDir) return target; // curated by hand; trust it

    mkdirSync(target, { recursive: true });
    const total = spec.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
    let received = 0;

    for (const file of spec.files) {
      const name = basename(file.path);
      const dest = join(target, name);
      if (existsSync(dest)) {
        received += file.bytes ?? 0;
        this.onProgress?.({
          modelId: spec.id,
          receivedBytes: received,
          totalBytes: total,
          done: false,
        });
        continue;
      }

      const partial = `${dest}.partial`;
      const url = `${this.baseUrl}/${spec.repo}/resolve/${spec.revision}/${file.path}`;
      try {
        const res = await this.fetchImpl(url);
        if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        writeFileSync(partial, bytes);

        if (file.sha256) {
          const actual = createHash("sha256").update(bytes).digest("hex");
          if (actual !== file.sha256) {
            rmSync(partial, { force: true });
            throw new Error(
              `checksum mismatch for ${spec.id}/${file.path}: expected ${file.sha256}, got ${actual}`,
            );
          }
        }
        renameSync(partial, dest); // atomic: only now does it look complete
        received += bytes.length;
        this.onProgress?.({
          modelId: spec.id,
          receivedBytes: received,
          totalBytes: total,
          done: false,
        });
      } catch (err) {
        rmSync(partial, { force: true });
        throw err;
      }
    }

    this.onProgress?.({
      modelId: spec.id,
      receivedBytes: total,
      totalBytes: total,
      done: true,
    });
    return target;
  }
}
