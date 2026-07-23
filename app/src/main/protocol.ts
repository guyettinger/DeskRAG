/**
 * The `deskrag://` protocol serves keyframe/blob bytes to the renderer by id, so
 * large image buffers stream from disk instead of being marshalled over IPC.
 *   deskrag://frame/<blobId>  -> the blob's bytes with a codec-derived MIME type.
 */

import { protocol } from "electron";
import type { DeskRagService } from "./deskrag-service.js";

export const DESKRAG_SCHEME = "deskrag";

const MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  wav: "audio/wav",
  aac: "audio/aac",
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
      if (url.host !== "frame") return new Response("not found", { status: 404 });
      const blobId = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const blob = service.getBlobRow(blobId);
      if (!blob) return new Response("not found", { status: 404 });
      const bytes = await service.readBlob(blob);
      const mime = MIME[blob.codec ?? ""] ?? "application/octet-stream";
      return new Response(
        bytes as unknown as ConstructorParameters<typeof Response>[0],
        { headers: { "content-type": mime, "cache-control": "no-cache" } },
      );
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  });
}
