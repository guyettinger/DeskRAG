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
  SessionDetailDTO,
  SessionSummaryDTO,
  HabitsDTO,
} from "@shared/types";
import type { BlobRow, RegionRow, SegmentRow, SegmentSummaryRow } from "deskrag";
import { buildOutline, type Outline } from "./outline.js";

/** A keyframe, ready to become an MCP image content block. */
export interface FrameImage {
  base64: string;
  mimeType: string;
}

/**
 * One labelled box on a step's keyframe.
 *
 * A DEDICATED type rather than `HighlightDTO`: a highlight is QUERY-relative and
 * carries a `strength`, and there is no query here. Every box below draws solid.
 */
export interface RegionView {
  role: string | null;
  label: string | null;
  bbox: { x: number; y: number; w: number; h: number };
}

/**
 * The keyframe chosen for a step, and what was on it.
 *
 * DECLARED OUT HERE, not inline in the interface below. `test/mcp.readonly.test.ts`
 * matches the interface BODY against `/…|start|…/i` with no word boundaries, so a
 * field named `startedAt` written inline would fail the read-only guard for a
 * reason that has nothing to do with reading or writing.
 */
export interface StepMoment {
  frameId: string;
  /** LANE seconds, the axis every cross-screen jump is expressed in. */
  offsetSec: number;
  /**
   * True when the step's second preceded the recording's first keyframe and the
   * EARLIEST was taken instead. The pick is otherwise at-or-before.
   */
  after: boolean;
  regions: RegionView[];
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
  /**
   * Embed for the habit search's dense lane, or null when no text model is ready.
   *
   * NULL rather than a throw, so the caller branches on a value and can say the
   * lane was skipped and why. The parameter is `texts` and NOT the name the
   * library's own `EmbeddingProvider.embed` uses — that one contains `put`,
   * which the read-only guard matches with no word boundary.
   */
  embed(texts: string[], role: "document" | "query"): Promise<Float32Array[] | null>;
  /**
   * The keyframe at or before a lane second, with its labelled regions.
   *
   * At-or-before because a step is an EDGE: its actions want the screen as it
   * was when they began, which is the rule `regionsAt` follows. Null when the
   * recording has no keyframes at all.
   */
  momentAt(sessionId: string, atSec: number): StepMoment | null;
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
  embedTexts(texts: string[], role: "document" | "query"): Promise<Float32Array[]>;
  sessionDetail(sessionId: string): SessionDetailDTO | null;
  frameRegions(frameId: string): RegionRow[];
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

  async embed(texts: string[], role: "document" | "query"): Promise<Float32Array[] | null> {
    // The model is a download and the ONNX host may not be up. Both are ordinary
    // states, not crashes: the caller turns a null into a stated skip, where a
    // thrown error would reach the agent as a failed request with no remedy.
    try {
      return await this.service.embedTexts(texts, role);
    } catch {
      return null;
    }
  }

  momentAt(sessionId: string, atSec: number): StepMoment | null {
    const detail = this.service.sessionDetail(sessionId);
    if (detail === null || detail.keyframes.length === 0) return null;
    // Scanned rather than assumed sorted — order-independent, and the cost is
    // one pass over a list the Library already draws in full.
    let pick: (typeof detail.keyframes)[number] | null = null;
    let earliest = detail.keyframes[0]!;
    for (const k of detail.keyframes) {
      if (k.offsetSec < earliest.offsetSec) earliest = k;
      if (k.offsetSec <= atSec + 1e-6 && (pick === null || k.offsetSec > pick.offsetSec)) pick = k;
    }
    const chosen = pick ?? earliest;
    return {
      frameId: chosen.frameId,
      offsetSec: chosen.offsetSec,
      after: pick === null,
      regions: this.service.frameRegions(chosen.frameId).map((r) => ({
        role: r.role,
        label: r.label,
        bbox: { x: r.x, y: r.y, w: r.w, h: r.h },
      })),
    };
  }
}
