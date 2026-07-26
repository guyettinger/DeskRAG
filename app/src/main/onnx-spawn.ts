/**
 * Electron adapter for OnnxHost's injected `spawn`.
 *
 * Kept apart from onnx-host.ts so the host — where the protocol logic lives —
 * has no Electron import and stays unit-testable.
 */

import { utilityProcess } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OnnxTransport, SpawnFn } from "./onnx-host.js";

// The worker is a second named entry in electron.vite.config.ts, so it lands
// beside this bundle with a stable name. ESM output is fine — verified that
// utilityProcess.fork loads an ESM worker on Electron 43. (electron-vite's
// `?modulePath` would also work, but vitest cannot resolve that query, which
// breaks every app test that reaches this module.)
const here = dirname(fileURLToPath(import.meta.url));

export const spawnOnnxWorker: SpawnFn = (handlers) => {
  const child = utilityProcess.fork(join(here, "onnx-worker.js"), [], {
    serviceName: "deskrag-onnx",
    // Surface the worker's stdout/stderr in the app's terminal; an ORT failure
    // is otherwise invisible.
    stdio: "inherit",
  });

  child.on("message", (msg: unknown) => handlers.onMessage(msg));
  child.on("exit", (code: number) => {
    // Log as well as propagate: the rejection may be swallowed by a caller,
    // but a worker death is always worth seeing.
    console.error(`[deskrag] onnx worker exited code=${code}`);
    handlers.onExit(`exit code=${code}`);
  });
  child.on("spawn", () => console.log("[deskrag] onnx worker spawned"));

  return {
    postMessage: (msg) => child.postMessage(msg),
    kill: () => {
      child.kill();
    },
  } satisfies OnnxTransport;
};
