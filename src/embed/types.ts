/**
 * Provider interfaces + the namespacing discipline.
 *
 * CRITICAL vector discipline: embeddings from different models are NOT
 * comparable. Every vector is namespaced by `view:provider:model:dimensions`.
 * Never mix vector spaces in one similarity search. The `namespaceFor` helper is
 * the single source of truth for that string; the store keys one physical Lance
 * table per namespace so two models physically cannot be compared.
 */

/**
 * The distinct embeddable "views" of a segment/frame/region. Each view lives in
 * its own namespace even for the same provider+model, because a caption embedding
 * and a raw-frame image embedding are not comparable.
 */
export type View =
  | "caption" // VLM visual-semantic summary text
  | "digest" // templated structured-event text
  | "transcript" // STT text (mic + desktop audio)
  | "behavior" // numeric input-dynamics feature vector
  | "frame_image" // whole-frame image embedding
  | "region_image" // region-crop image embedding (the PixelRAG part)
  | "frame_patches"; // multi-vector late-interaction frame patches

export const VIEWS: readonly View[] = [
  "caption",
  "digest",
  "transcript",
  "behavior",
  "frame_image",
  "region_image",
  "frame_patches",
] as const;

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
 * {@link ImageEmbeddingProvider} satisfy this, as does the built-in behavioral
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

export interface ImageEmbeddingProvider extends NamespacedProvider {
  /**
   * True when text and image land in ONE embedding space, so a text query could
   * hit image vectors directly — as with nomic-embed-vision-v1.5, whose tower
   * shares a space with nomic-embed-text-v1.5. Recorded as vector-space metadata
   * on the Lance table; Tier 2/3 themselves only ever call `embedImages`.
   */
  readonly sharedTextSpace: boolean;
  embedImages(images: Uint8Array[]): Promise<Float32Array[]>;
}

/**
 * Late-interaction provider: one model embeds both images and queries into the
 * same space, emitting MANY vectors each. `dimensions` is the PER-VECTOR width
 * (e.g. 128), not the total, so `namespaceFor` stays meaningful.
 */
export interface MultiVectorProvider extends NamespacedProvider {
  readonly multiVector: true;
  /** Per image: N vectors of `dimensions` each. */
  embedImages(images: Uint8Array[]): Promise<Float32Array[][]>;
  /** Per query: M vectors of `dimensions` each. */
  embedQueries(texts: string[]): Promise<Float32Array[][]>;
}

export interface CaptionProvider {
  caption(frames: Uint8Array[], context?: string): Promise<string>;
}

export interface TranscriptionResult {
  /** The recognized speech; empty string when there is no speech / on failure. */
  text: string;
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
