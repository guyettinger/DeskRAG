/**
 * Entry point for the ONNX utility process. Built as a SECOND main-process
 * entry (see electron.vite.config.ts) and forked by onnx-spawn.ts.
 *
 * This is the only place onnxruntime-node loads. It exists so that the 3-5GB a
 * single ColSmol frame needs is allocated in a process that can die, or be
 * killed, without taking the app with it.
 *
 * Deliberately thin — all the logic worth testing lives in onnx-worker-core.ts.
 */

import { OnnxRuntime } from "deskrag/embed/onnx/runtime";
import type { OnnxRequest } from "../shared/onnx-protocol.js";
import { handleRequest } from "./onnx-worker-core.js";

/**
 * Just the slice of Electron's ParentPort this uses. Declared locally rather
 * than pulled from electron's types: this file runs in a plain Node
 * environment, and the ambient augmentation of `process` is not visible here.
 */
interface ParentPortLike {
  on(event: "message", cb: (e: { data: OnnxRequest }) => void): void;
  postMessage(msg: unknown): void;
}

// utilityProcess gives the child a parentPort; without one we were started
// wrongly and should say so rather than sit silent.
const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!port) throw new Error("onnx-worker must be started via utilityProcess.fork");

port.on("message", (e) => {
  void handleRequest(e.data, (modelPath) => OnnxRuntime.session(modelPath)).then((res) => {
    port.postMessage(res);
  });
});
