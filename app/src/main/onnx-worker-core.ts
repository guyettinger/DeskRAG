/**
 * The worker's request handling, separated from its Electron entry point so it
 * can be tested in-process.
 *
 * Every failure becomes an `err` RESPONSE, never a thrown exception. An
 * unhandled rejection in the worker would kill it, and the host would then fail
 * every request in flight — turning one bad frame into a dead runtime.
 */

import type {
  OnnxRequest,
  OnnxResponse,
  OnnxSessionLike,
  OnnxTensorDTO,
} from "../shared/onnx-protocol.js";

export type SessionFor = (modelPath: string) => Promise<OnnxSessionLike>;

export async function handleRequest(req: OnnxRequest, sessionFor: SessionFor): Promise<OnnxResponse> {
  try {
    const session = await sessionFor(req.modelPath);
    const raw = await session.run(req.feeds);
    return { kind: "ok", id: req.id, outputs: toPlainTensors(raw) };
  } catch (err) {
    return { kind: "err", id: req.id, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Copy ORT tensors into plain objects before they cross the process boundary.
 *
 * onnxruntime's Tensor keeps its buffer in an own `cpuData` field and exposes
 * `data` as a PROTOTYPE GETTER. structuredClone — which is what postMessage
 * does — copies own enumerable properties and drops the prototype, so an ORT
 * tensor arrives with `data === undefined` while still looking well-formed.
 * Reading `.data` here materializes the buffer as an own property.
 */
function toPlainTensors(raw: Record<string, OnnxTensorDTO>): Record<string, OnnxTensorDTO> {
  const out: Record<string, OnnxTensorDTO> = {};
  for (const [name, t] of Object.entries(raw)) {
    out[name] = { data: t.data, dims: Array.from(t.dims) };
  }
  return out;
}
