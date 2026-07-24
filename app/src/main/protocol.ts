/**
 * The `deskrag://` protocol serves keyframe/blob bytes to the renderer by id, so
 * large image buffers stream from disk instead of being marshalled over IPC.
 *   deskrag://frame/<blobId>  -> the blob's bytes with a codec-derived MIME type.
 *   deskrag://media/<blobId>  -> the same, but streamed with Range support.
 * The split matters: Chromium will not let a <video> seek unless the server
 * answers a Range request with 206 + content-range, and a session video is far
 * too large to buffer whole the way a keyframe JPEG is.
 */

import { protocol } from "electron";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { DeskRagService } from "./deskrag-service.js";

export const DESKRAG_SCHEME = "deskrag";

const MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  wav: "audio/wav",
  aac: "audio/aac",
  mp4: "video/mp4",
  h264: "video/mp4",
};

/** Must run before app is ready. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKRAG_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Must run after app is ready. */
export function registerProtocol(service: DeskRagService): void {
  protocol.handle(DESKRAG_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const blobId = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const blob = service.getBlobRow(blobId);
      if (!blob) return new Response("not found", { status: 404 });
      const mime = MIME[blob.codec ?? ""] ?? "application/octet-stream";

      if (url.host === "frame") {
        const bytes = await service.readBlob(blob);
        return new Response(
          bytes as unknown as ConstructorParameters<typeof Response>[0],
          { headers: { "content-type": mime, "cache-control": "no-cache" } },
        );
      }
      if (url.host !== "media") return new Response("not found", { status: 404 });

      // Video: stream from disk honouring Range, so <video> can seek. The
      // byteOffset/byteLength window keeps packed blobs correct.
      const total = blob.byteLength;
      const range = request.headers.get("range");
      const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

      if (!match) {
        return new Response(
          Readable.toWeb(
            createReadStream(blob.path, {
              start: blob.byteOffset,
              end: blob.byteOffset + total - 1,
            }),
          ) as ReadableStream<Uint8Array>,
          {
            status: 200,
            headers: {
              "content-type": mime,
              "content-length": String(total),
              "accept-ranges": "bytes",
            },
          },
        );
      }

      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (start >= total || start > end) {
        return new Response("range not satisfiable", {
          status: 416,
          headers: { "content-range": `bytes */${total}` },
        });
      }
      return new Response(
        Readable.toWeb(
          createReadStream(blob.path, {
            start: blob.byteOffset + start,
            end: blob.byteOffset + end,
          }),
        ) as ReadableStream<Uint8Array>,
        {
          status: 206,
          headers: {
            "content-type": mime,
            "content-length": String(end - start + 1),
            "content-range": `bytes ${start}-${end}/${total}`,
            "accept-ranges": "bytes",
          },
        },
      );
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  });
}
