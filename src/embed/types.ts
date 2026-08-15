/**
 * Provider interfaces + the namespacing discipline.
 *
 * CRITICAL vector discipline: embeddings from different models are NOT
 * comparable. Every vector is namespaced by `view:provider:model:dimensions`.
 * Never mix vector spaces in one similarity search. The `namespaceFor` helper is
 * the single source of truth for that string; the store keys one physical Lance
 * table per namespace so two models physically cannot be compared.
 */

// Type-only, so it erases: `geometry.ts` is pure TS and loads nothing native,
// unlike the rest of `onnx/`.
import type { TileConfig } from "./onnx/geometry.js";

/**
 * The distinct embeddable "views" of a segment/frame/region. Each view lives in
 * its own namespace even for the same provider+model, because a caption embedding
 * and a raw-frame image embedding are not comparable.
 */
export type View =
  | "caption" // VLM visual-semantic summary text
  | "app_caption" // VLM summary of the focused app window only (crop of `caption`'s frame)
  | "digest" // templated structured-event text
  | "summary" // a COMPOSED level's text — what its children mean together
  | "transcript" // STT text (mic + desktop audio)
  | "behavior" // numeric input-dynamics feature vector
  | "frame_patches"; // multi-vector late-interaction frame patches

export const VIEWS: readonly View[] = [
  "caption",
  "app_caption",
  "digest",
  "summary",
  "transcript",
  "behavior",
  "frame_patches",
] as const;

/**
 * Views that were registered by an older build and are no longer embeddable.
 *
 * `frame_image` and `region_image` were the SINGLE-VECTOR image lane, removed
 * when the provider menu standardized on ColModernVBERT. They still appear in
 * `vector_space` on any store indexed before that.
 *
 * `parseNamespace` REJECTS them, and that is safe only because opening a store
 * does not parse: `DualStore` reads the `view` COLUMN, and the only caller of
 * `parseNamespace` is `ensureTable`, which runs on a namespace being registered.
 * A retired space is dropped on open before anything else walks the registry —
 * throwing on open is what took down a whole re-index once already.
 */
export const RETIRED_VIEWS: readonly string[] = ["frame_image", "region_image"] as const;

/**
 * Models whose adapter has been removed, so nothing can produce a comparable
 * vector for them again.
 *
 * Distinct from a view being retired, and BOTH checks are needed: ColSmol's view
 * is `frame_patches`, which is still live, so a view check alone leaves its
 * table on disk answering nothing. Distinct also from a model merely not being
 * CONFIGURED — that is a user choice whose vectors become comparable again the
 * moment it is selected, where these can never be.
 */
export const RETIRED_MODELS: readonly string[] = ["colsmol-256m"] as const;

/**
 * Views whose Lance table holds MANY vectors per row (late interaction), not one.
 * The store consults this instead of widening `parseNamespace`, which keeps its
 * four-part shape.
 */
export const MULTIVECTOR_VIEWS: ReadonlySet<View> = new Set<View>([
  "frame_patches",
]);

/**
 * Asymmetric embedding role. nomic-embed-text-v1.5 requires `search_document: ` on
 * stored text and `search_query: ` on queries; omitting them raises no error and
 * silently degrades retrieval. Providers that do not care ignore this.
 */
export interface EmbedOptions {
  role?: "document" | "query";
}

/**
 * Minimal shape needed to derive a namespace. Both {@link EmbeddingProvider} and
 * {@link MultiVectorProvider} satisfy this, as does the built-in behavioral
 * feature extractor (which is not a network provider but still owns a namespace).
 */
export interface NamespacedProvider {
  /** Provider id, e.g. "onnx", "ollama", "builtin". */
  readonly id: string;
  /** Model id, e.g. "nomic-embed-text-v1.5", "colSmol-256M-dynamic". */
  readonly model: string;
  /** Output dimensionality; part of the namespace (a truncated model differs). */
  readonly dimensions: number;
}

export interface EmbeddingProvider extends NamespacedProvider {
  embed(inputs: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
}

/**
 * One embedded query: every vector, plus which of them came from the user's
 * own words.
 *
 * SCORING uses `vectors` whole — the buffer/padding slots are the learned
 * expansion slots late interaction relies on, and dropping them would change
 * retrieval. HIGHLIGHTING uses only `contentIndices`, because a padding or
 * wrapper vector's best-matching patch answers nothing the user asked.
 *
 * INDICES rather than a count or a range: content is not a prefix for every
 * prompt (ColModernVBERT puts [CLS] first), and contiguity is true of both
 * adapters today without being a property to depend on.
 */
export interface QueryEmbedding {
  vectors: Float32Array[];
  contentIndices: number[];
}

/**
 * The ONLY image provider shape. One late-interaction model embeds both images
 * and queries into the same space, emitting MANY vectors each; `dimensions` is
 * the PER-VECTOR width (e.g. 128), not the total, so `namespaceFor` stays
 * meaningful.
 */
export interface MultiVectorProvider extends NamespacedProvider {
  readonly multiVector: true;
  /**
   * The tile geometry this provider actually preprocessed with.
   *
   * REQUIRED, and for the same reason `contentIndices` is: the provider is the
   * only thing that knows its own layout, so it is the only thing that should
   * state it. The highlighter used `DEFAULT_TILE_CONFIG` instead, which for
   * ColModernVBERT is numerically identical — i.e. it was right BY LUCK, the
   * exact failure `readTileConfig` exists to avoid, and it would have stopped
   * being right the moment an export changed its geometry, silently, with every
   * box on the wrong part of the frame and every score still plausible.
   */
  readonly tileConfig: TileConfig;
  /** Per image: N vectors of `dimensions` each. */
  embedImages(images: Uint8Array[]): Promise<Float32Array[][]>;
  /** Per query: M vectors of `dimensions` each, with the content ones named. */
  embedQueries(texts: string[]): Promise<QueryEmbedding[]>;
}

export interface CaptionProvider {
  caption(frames: Uint8Array[], context?: string): Promise<string>;
}

export interface TranscriptionResult {
  /** The recognized speech; empty string when there is no speech / on failure. */
  text: string;
  /**
   * Sub-clip timing, when the provider can give it (whisper.cpp's -oj JSON
   * output; startMs/endMs are relative to the clip passed to transcribe()).
   * Absent means the caller must treat `text` as one opaque span — the
   * fallback TranscriptRepresenter.represent() uses for whole-blob attribution.
   */
  segments?: { text: string; startMs: number; endMs: number }[];
}

/**
 * Speech-to-text over a single self-contained audio clip (e.g. a WAV chunk).
 * Adapters must be best-effort: resolve to `{ text: "" }` rather than throw when
 * the engine/model is unavailable, so a missing STT dependency degrades to "no
 * transcript" instead of failing the represent pass.
 */
export interface TranscriptionProvider {
  transcribe(audio: Uint8Array, opts?: { language?: string }): Promise<TranscriptionResult>;
}

// --- represent/ concerns, typedefs only for now (built in a later pass) --------

export interface Frame {
  id: string;
  width: number;
  height: number;
  /** Raw pixels for the sampled frame (encoded image bytes). */
  bytes: Uint8Array;
}

export interface Point {
  x: number;
  y: number;
}

export interface UIElement {
  role: string;
  label?: string;
  /**
   * App-assigned stable id (AXIdentifier). Where present, a far better anchor
   * than a positional path, which shifts whenever the UI gains or loses a
   * sibling. Absent for the many apps that never set one.
   */
  identifier?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The currently-focused element — always preserved through region budgeting. */
  focused?: boolean;
  /**
   * Index of this element's parent in the same array; absent means root. The AX
   * walk is a tree but the wire format is flat (see native/ax-dump.swift), so
   * hierarchy travels as back-references — a parent always precedes its children.
   */
  parent?: number;
  /** Depth among *emitted* elements. Derived from `parent`; absent means 0. */
  depth?: number;
}

export type RegionSource = "ax" | "hotspot" | "grid";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  source: RegionSource;
  role?: string;
  label?: string;
  priority: number;
}

export interface RegionProposer {
  propose(
    frame: Frame,
    signals: { axTree?: UIElement[]; hotspots?: Point[] },
  ): Promise<Region[]>;
}

/**
 * The single source of truth for namespace strings.
 *
 *   namespaceFor("digest", onnxTextProvider) === "digest:onnx:nomic-embed-text-v1.5:768"
 *
 * Colons are the separator, so provider ids / models must not contain them. We
 * validate that here rather than silently producing a corrupt namespace.
 */
export function namespaceFor(view: View, provider: NamespacedProvider): string {
  for (const [field, value] of [
    ["provider id", provider.id],
    ["provider model", provider.model],
  ] as const) {
    if (value.length === 0 || value.includes(":")) {
      throw new Error(
        `Invalid ${field} ${JSON.stringify(value)}: must be non-empty and contain no ':'`,
      );
    }
  }
  if (!Number.isInteger(provider.dimensions) || provider.dimensions <= 0) {
    throw new Error(
      `Invalid dimensions ${provider.dimensions}: must be a positive integer`,
    );
  }
  return `${view}:${provider.id}:${provider.model}:${provider.dimensions}`;
}

/** Inverse of {@link namespaceFor}, for reconciliation / registry introspection. */
export interface ParsedNamespace {
  view: View;
  providerId: string;
  model: string;
  dimensions: number;
}

export function parseNamespace(namespace: string): ParsedNamespace {
  const parts = namespace.split(":");
  if (parts.length !== 4) {
    throw new Error(`Malformed namespace ${JSON.stringify(namespace)}`);
  }
  const [view, providerId, model, dims] = parts as [string, string, string, string];
  if (!VIEWS.includes(view as View)) {
    throw new Error(`Unknown view ${JSON.stringify(view)} in namespace`);
  }
  const dimensions = Number(dims);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Bad dimensions in namespace ${JSON.stringify(namespace)}`);
  }
  return { view: view as View, providerId, model, dimensions };
}
