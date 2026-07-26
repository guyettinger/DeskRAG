/**
 * Message contract between the main process and the ONNX utility process.
 *
 * Imports nothing from Node, Electron, or `deskrag` — both sides depend on it,
 * the same rule `shared/types.ts` follows for the renderer boundary. Changing a
 * message shape means changing it here first.
 *
 * Tensors cross as Float32Array / BigInt64Array, which structured clone
 * preserves exactly, so no manual (de)serialization is needed.
 */

/**
 * Structurally identical to the library's `OnnxTensor`. Kept separate so
 * `shared/` stays free of library imports; the shapes must match for a remote
 * session to inject into an adapter.
 */
export interface OnnxTensorDTO {
  data: Float32Array | BigInt64Array;
  dims: number[];
}

/** Structurally identical to the library's `OnnxSession`. */
export interface OnnxSessionLike {
  run(feeds: Record<string, OnnxTensorDTO>): Promise<Record<string, OnnxTensorDTO>>;
}

export interface OnnxRunRequest {
  kind: "run";
  id: number;
  /** Absolute weights path; the worker caches one session per path. */
  modelPath: string;
  feeds: Record<string, OnnxTensorDTO>;
}

export type OnnxRequest = OnnxRunRequest;

export type OnnxResponse =
  | { kind: "ok"; id: number; outputs: Record<string, OnnxTensorDTO> }
  | { kind: "err"; id: number; message: string };
