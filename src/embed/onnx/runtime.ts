/**
 * Lazy onnxruntime-node loader + InferenceSession cache.
 *
 * NOT exported from the package barrel: this loads a native module, so importing
 * "deskrag" must never reach it. Import from this path directly.
 *
 * Sessions are cached by absolute weights path for the process lifetime because
 * DeskRagService rebuilds providers on every index() and every search(), and an
 * InferenceSession costs hundreds of ms to construct and holds the weights
 * resident. Rebuilding one per search would be badly wrong.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface OnnxTensor {
  data: Float32Array | BigInt64Array;
  dims: number[];
}

/** The slice of an InferenceSession the adapters use. Injectable for tests. */
export interface OnnxSession {
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
}

interface OrtTensorCtor {
  new (type: string, data: unknown, dims: number[]): unknown;
}

interface OrtModule {
  Tensor: OrtTensorCtor;
  InferenceSession: {
    create(
      path: string,
      opts?: Record<string, unknown>,
    ): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensor>>;
    }>;
  };
}

let ortPromise: Promise<OrtModule> | undefined;

async function ort(): Promise<OrtModule> {
  ortPromise ??= import(/* @vite-ignore */ "onnxruntime-node") as unknown as Promise<OrtModule>;
  return ortPromise;
}

/**
 * Build a tensor descriptor without the caller importing onnxruntime-node.
 * The concrete ORT Tensor is constructed inside {@link OnnxRuntime.session}'s
 * `run`, so adapters stay free of the native import.
 */
export function makeTensor(
  _kind: "float32" | "int64",
  data: Float32Array | BigInt64Array,
  dims: number[],
): OnnxTensor {
  return { data, dims };
}

/**
 * Session options, exported so they can be asserted on — see
 * test/onnx.runtime.test.ts.
 *
 * BOTH memory flags are load-bearing, not tuning. Each disables a DIFFERENT
 * single huge allocation, and each one alone still crashes the app:
 *
 *   enableCpuMemArena  ORT's BFCArena grows by requesting one huge block
 *                      (observed: 2GiB for ColSmol at 13 tiles). Crashes in
 *                      `BFCArena::Extend`, on the FIRST run.
 *   enableMemPattern   ORT's pattern planner records the activation layout on
 *                      the first run and from the SECOND run onward
 *                      pre-allocates one fused block for the whole graph in
 *                      `ExecutionFrame`'s constructor. Crashes there, and only
 *                      ever on run #2 — which is why single-image checks pass.
 *
 * Chromium's allocator — which the Electron binary uses for `operator new`, in
 * the main process AND in a utilityProcess — refuses an allocation that size
 * and turns the failure into a deliberate crash (EXC_BREAKPOINT/SIGTRAP,
 * surfaced by utilityProcess as `exit code=5`). Plain Node's malloc allows it,
 * so `npm test` and any bare-node script pass either way; only the app dies.
 *
 * Measured under the Electron binary, real ColSmol weights, a real 2560x1440
 * keyframe (13 tiles), three consecutive runs: 16.3/16.3/16.5s, RSS flat at
 * 1.30GB. Disabling the pattern planner costs no measurable throughput; the
 * arena costs some, and is still the right trade for not crashing.
 */
export const SESSION_OPTIONS = {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
  enableCpuMemArena: false,
  enableMemPattern: false,
} as const;

const cache = new Map<string, Promise<OnnxSession>>();

export const OnnxRuntime = {
  /** Cached session for `weightsPath`. Throws a clear error if the file is absent. */
  session(weightsPath: string): Promise<OnnxSession> {
    const key = resolve(weightsPath);
    const hit = cache.get(key);
    if (hit) return hit;

    const created = (async (): Promise<OnnxSession> => {
      if (!existsSync(key)) {
        throw new Error(`ONNX weights not found at ${key}`);
      }
      const { InferenceSession, Tensor } = await ort();
      const sess = await InferenceSession.create(key, { ...SESSION_OPTIONS });
      return {
        async run(feeds: Record<string, OnnxTensor>) {
          const wrapped: Record<string, unknown> = {};
          for (const [name, t] of Object.entries(feeds)) {
            const type = t.data instanceof BigInt64Array ? "int64" : "float32";
            wrapped[name] = new Tensor(type, t.data, t.dims);
          }
          return sess.run(wrapped);
        },
      };
    })();

    cache.set(key, created);
    // A failed load must not poison the cache: a later attempt (after the file
    // is downloaded) should retry rather than replay the rejection forever.
    created.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
    return created;
  },

  /** Drop all cached sessions. Test hook; not used in production. */
  reset(): void {
    cache.clear();
  },
};
