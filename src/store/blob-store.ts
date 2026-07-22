/**
 * BlobStore — content storage for large media (keyframe images now; video/audio
 * later). Bytes live as files under a root dir (organized per session); the
 * relational `blob` row (path + byte range) is the index. Kept separate from the
 * dual-store seam because blobs are plain files, not vectors — the store just
 * records where they are.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import type { BlobInsert, BlobRow, Media } from "./types.js";

const EXT: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  webp: "webp",
  h264: "h264",
  aac: "aac",
  wav: "wav",
};

export interface BlobWriteMeta {
  tMonoStart: number;
  tMonoEnd: number;
  codec?: string;
}

export class BlobStore {
  constructor(private readonly root: string) {}

  /** Write bytes and return the BlobInsert to persist via store.putBlobs. */
  async write(
    sessionId: string,
    media: Media,
    bytes: Uint8Array,
    meta: BlobWriteMeta,
  ): Promise<BlobInsert> {
    const id = ulid();
    const ext = meta.codec ? (EXT[meta.codec] ?? "bin") : "bin";
    const dir = join(this.root, sessionId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.${ext}`);
    await writeFile(path, bytes);
    return {
      id,
      sessionId,
      media,
      path,
      byteOffset: 0,
      byteLength: bytes.length,
      tMonoStart: meta.tMonoStart,
      tMonoEnd: meta.tMonoEnd,
      ...(meta.codec !== undefined ? { codec: meta.codec } : {}),
    };
  }

  /** Read a blob's bytes (honouring byte_offset/byte_length for packed blobs). */
  async read(blob: Pick<BlobRow, "path" | "byteOffset" | "byteLength">): Promise<Uint8Array> {
    const buf = await readFile(blob.path);
    if (blob.byteOffset === 0 && blob.byteLength === buf.length) return buf;
    return buf.subarray(blob.byteOffset, blob.byteOffset + blob.byteLength);
  }
}
