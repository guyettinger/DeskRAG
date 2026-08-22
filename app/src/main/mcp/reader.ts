/**
 * `ExperienceReader` — everything the MCP tools are allowed to know about
 * DeskRAG, and the one implementation that does the I/O.
 *
 * The interface is the seam that keeps `tools.ts` pure and testable without
 * Electron, a store or a model — the same injection pattern `trace/` uses for
 * `LiftInput.axAt` and `VisualMatcher`. It is also where the read-only promise
 * is expressed as a TYPE: there is no method here that records, deletes,
 * reindexes or acts, so a tool cannot call one.
 */

import type {
  FlowsDTO,
  HighlightDTO,
  ResultDetailDTO,
  SearchResultDTO,
  SessionSummaryDTO,
  HabitsDTO,
} from "@shared/types";
import type { BlobRow, SegmentRow, SegmentSummaryRow } from "deskrag";
import { buildOutline, type Outline } from "./outline.js";

/** A keyframe, ready to become an MCP image content block. */
export interface FrameImage {
  base64: string;
  mimeType: string;
}

export interface ExperienceReader {
  /** Ranked moments for a text query. Carries the index diagnostics with it. */
  search(query: string): Promise<SearchResultDTO>;
  /**
   * One frame in full. Highlights are empty by construction: they are
   * QUERY-relative, and this call carries no query.
   */
  moment(frameId: string): ResultDetailDTO | null;
  /** The keyframe's JPEG bytes, or null when the frame has no blob. */
  frameImage(frameId: string): Promise<FrameImage | null>;
  recordings(): SessionSummaryDTO[];
  /** Null when there is no such recording — distinct from one with no hierarchy. */
  outline(sessionId: string): Outline | null;
  /** Null when no trace graph has been built at all. */
  flows(): FlowsDTO | null;
  /**
   * The HABIT.md files the user chose to keep, plus what could be proposed.
   *
   * READ ONLY, like everything else here. Keeping, editing and forgetting a
   * habit all go through `DeskRagService` and IPC, and deliberately appear on
   * neither this interface nor `ServiceReads` — so a tool cannot author one even
   * though the app can.
   */
  habits(): HabitsDTO;
}

/**
 * The slice of `DeskRagService` this reader is allowed to see.
 *
 * A structural port rather than the class itself, for two reasons. It is the
 * read-only contract stated one level lower — the service owns recording and
 * deletion too, and naming only the read half means the reader could not call
 * `stopRecording` even if a tool asked it to. And it keeps the ROOT test suite
 * from having to typecheck `deskrag-service.ts`, which imports native ONNX
 * subpaths that only resolve inside the app's own build.
 *
 * `DeskRagService` satisfies this structurally; nothing declares that it does.
 */
export interface ServiceReads {
  searchDetached(input: { text: string }): Promise<{
    result: SearchResultDTO;
    highlights: Map<string, HighlightDTO[]>;
  }>;
  detailWith(frameId: string, highlights: HighlightDTO[]): ResultDetailDTO | null;
  frameBlobId(frameId: string): string | undefined;
  getBlobRow(blobId: string): BlobRow | undefined;
  readBlob(blob: BlobRow): Promise<Uint8Array>;
  listSessions(): SessionSummaryDTO[];
  sessionComposition(sessionId: string): {
    segments: SegmentRow[];
    summaries: SegmentSummaryRow[];
    children: [string, string[]][];
    laneOrigin: number;
  } | null;
  flows(): FlowsDTO | null;
  habits(): HabitsDTO;
}

/**
 * The reader backed by the live app.
 *
 * It goes through the service rather than the store: the service is the single
 * owner of the library, and going around it would mean a second construction of
 * the providers — the exact duplication that ruled out a standalone server.
 */
export class ServiceExperienceReader implements ExperienceReader {
  constructor(private readonly service: ServiceReads) {}

  async search(query: string): Promise<SearchResultDTO> {
    // DETACHED: a background query from an agent must not clear the highlights
    // the user's own open result is drawn from.
    const { result } = await this.service.searchDetached({ text: query });
    return result;
  }

  moment(frameId: string): ResultDetailDTO | null {
    return this.service.detailWith(frameId, []);
  }

  async frameImage(frameId: string): Promise<FrameImage | null> {
    const blobId = this.service.frameBlobId(frameId);
    if (blobId === undefined) return null;
    const blob = this.service.getBlobRow(blobId);
    if (!blob) return null;
    const bytes = await this.service.readBlob(blob);
    return {
      base64: Buffer.from(bytes).toString("base64"),
      // Keyframes are written as MJPEG frames; the codec column is the source of
      // truth, as it is for the `deskrag://` protocol.
      mimeType: blob.codec === "png" ? "image/png" : "image/jpeg",
    };
  }

  recordings(): SessionSummaryDTO[] {
    return this.service.listSessions();
  }

  outline(sessionId: string): Outline | null {
    const data = this.service.sessionComposition(sessionId);
    if (data === null) return null;
    return buildOutline({
      segments: data.segments,
      summaries: new Map(data.summaries.map((s) => [s.segmentId, s])),
      children: new Map(data.children),
      laneOrigin: data.laneOrigin,
    });
  }

  flows(): FlowsDTO | null {
    return this.service.flows();
  }

  habits(): HabitsDTO {
    return this.service.habits();
  }
}
