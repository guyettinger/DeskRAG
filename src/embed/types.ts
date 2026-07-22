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
  | "region_image"; // region-crop image embedding (the PixelRAG part)

export const VIEWS: readonly View[] = [
  "caption",
  "digest",
  "transcript",
  "behavior",
  "frame_image",
  "region_image",
] as const;

/**
 * Minimal shape needed to derive a namespace. Both {@link EmbeddingProvider} and
 * {@link ImageEmbeddingProvider} satisfy this, as does the built-in behavioral
 * feature extractor (which is not a network provider but still owns a namespace).
 */
export interface NamespacedProvider {
  /** Provider id, e.g. "gemini", "voyage", "ollama", "builtin". */
  readonly id: string;
  /** Model id, e.g. "gemini-embedding-2", "voyage-3", "nomic-embed-text". */
  readonly model: string;
  /** Output dimensionality; part of the namespace (a truncated model differs). */
  readonly dimensions: number;
}

export interface EmbeddingProvider extends NamespacedProvider {
  embed(inputs: string[]): Promise<Float32Array[]>;
}

export interface ImageEmbeddingProvider extends NamespacedProvider {
  /**
   * True for nomic-vision / voyage-multimodal / jina / gemini-embedding-2: text
   * queries can hit image vectors directly because text and image share one
   * embedding space.
   */
  readonly sharedTextSpace: boolean;
  embedImages(images: Uint8Array[]): Promise<Float32Array[]>;
}

export interface CaptionProvider {
  caption(frames: Uint8Array[], context?: string): Promise<string>;
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
 *   namespaceFor("caption", geminiProvider) === "caption:gemini:gemini-embedding-2:3072"
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
