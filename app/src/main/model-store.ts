/**
 * Downloads and verifies model weights into <userData>/DeskRAG/models/<id>/.
 *
 * Streams to <file>.partial while hashing incrementally, verifies SHA-256, then
 * renames atomically — a partial file never looks complete, so an interrupted
 * download cannot poison a namespace. Nothing is buffered whole: the largest
 * model is ~950MB and this runs in the Electron main process.
 *
 * On checksum mismatch it DELETES and THROWS. There is no fallback to an
 * unverified file: wrong weights produce vectors that are silently wrong while
 * sitting in a table claiming otherwise.
 *
 * Every model is downloaded. The `overrideDir` escape hatch reads from a
 * hand-curated directory instead, verifying only that the files are present.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
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
  /**
   * Emit a progress event at most this often, in bytes downloaded. A 954MB
   * model at chunk granularity would be ~15k IPC messages; tests set 1.
   */
  progressIntervalBytes?: number;
}

/**
 * Thrown when `overrideDir` points at a directory missing files. That path
 * skips downloading and verification by design, so this is the only chance to
 * report the gap before onnxruntime fails on a nonexistent path.
 */
export class ModelFilesMissingError extends Error {
  constructor(
    readonly modelId: string,
    readonly missing: string[],
    dir: string,
  ) {
    super(
      `Model "${modelId}" is incomplete in ${dir} — missing: ${missing.join(", ")}. ` +
        `This directory comes from the "Model directory" setting, which disables ` +
        `managed downloads. Add the missing files or clear that setting.`,
    );
    this.name = "ModelFilesMissingError";
  }
}

export class ModelStore {
  private readonly overrideDir: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onProgress: ((p: ModelDownloadProgress) => void) | undefined;
  private readonly progressIntervalBytes: number;
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
    this.progressIntervalBytes = opts.progressIntervalBytes ?? 4 * 1024 * 1024;
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

    if (this.overrideDir) {
      // Hand-curated: trusted, so no download and no checksum. But an
      // incomplete directory must fail here, with names.
      const missing = spec.files
        .map((f) => basename(f.path))
        .filter((name) => !existsSync(join(target, name)));
      if (missing.length > 0) throw new ModelFilesMissingError(spec.id, missing, target);
      return target;
    }

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
        if (!res.body) throw new Error(`download failed: empty body ${url}`);

        // Stream rather than buffer: model.onnx is ~950MB and arrayBuffer()
        // would hold all of it in the main process at once. The hash is
        // updated as bytes pass, so verification costs no second read.
        const hash = createHash("sha256");
        const out = createWriteStream(partial);
        // createWriteStream opens the fd asynchronously, so an open failure
        // can arrive long after the read loop has already thrown — and
        // destroy() attaches no listener of its own. An unhandled 'error'
        // event would take the whole Electron main process down, so hold one
        // listener for the stream's entire life and consume it below.
        let streamErr: Error | undefined;
        out.on("error", (e: Error) => (streamErr ??= e));
        let fileBytes = 0;
        let emitted = 0;
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            if (streamErr) throw streamErr; // don't pour a GB into a dead stream
            const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            hash.update(buf);
            fileBytes += buf.length;
            if (!out.write(buf)) await once(out, "drain"); // backpressure
            if (fileBytes - emitted >= this.progressIntervalBytes) {
              emitted = fileBytes;
              this.onProgress?.({
                modelId: spec.id,
                receivedBytes: received + fileBytes,
                totalBytes: total,
                done: false,
              });
            }
          }
          await new Promise<void>((resolve, reject) => {
            if (streamErr) {
              reject(streamErr);
              return;
            }
            out.once("error", reject);
            out.end(resolve);
          });
        } catch (err) {
          out.destroy();
          throw err;
        }

        if (file.sha256) {
          const actual = hash.digest("hex");
          if (actual !== file.sha256) {
            rmSync(partial, { force: true });
            throw new Error(
              `checksum mismatch for ${spec.id}/${file.path}: expected ${file.sha256}, got ${actual}`,
            );
          }
        }
        renameSync(partial, dest); // atomic: only now does it look complete
        received += fileBytes;
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
