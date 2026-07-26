/**
 * Main-process half of the out-of-process ONNX runtime.
 *
 * WHY THIS EXISTS: embedding one frame with ColSmol peaks at 3-5GB RSS
 * (measured: 13 tiles = 5.08GB, 5 tiles = 3.10GB). Run in the Electron main
 * process, alongside Chromium, LanceDB, libvips and better-sqlite3, that
 * allocation fails and V8's fatal-OOM handler aborts the whole app. A separate
 * OS process gets its own address space, and killing it is what actually
 * returns the memory.
 *
 * `worker_threads` would NOT do: threads share the process address space, so
 * the allocation still counts against main. It has to be a real process.
 *
 * `spawn` is injected so the protocol is testable without Electron.
 */

import type { OnnxResponse, OnnxSessionLike, OnnxTensorDTO } from "../shared/onnx-protocol.js";

/** The slice of Electron's UtilityProcess this needs. */
export interface OnnxTransport {
  postMessage(msg: unknown): void;
  kill(): void;
}

export interface SpawnHandlers {
  onMessage: (msg: unknown) => void;
  /** `detail` carries the exit code/signal — the difference between a clean
   *  stop and an OOM kill, and the first thing any investigation needs. */
  onExit: (detail?: string) => void;
}

export type SpawnFn = (handlers: SpawnHandlers) => OnnxTransport;

export interface OnnxHostOptions {
  spawn: SpawnFn;
  /**
   * Kill the worker this long after the last run settles. Without it the
   * weights stay resident for the life of the app, which defeats the point.
   * Omit to keep the worker alive until an explicit shutdown.
   */
  idleMs?: number;
}

interface Pending {
  resolve: (outputs: Record<string, OnnxTensorDTO>) => void;
  reject: (err: Error) => void;
}

export class OnnxHost {
  private readonly spawnFn: SpawnFn;
  private readonly idleMs: number | undefined;
  private child: OnnxTransport | undefined;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;

  constructor(opts: OnnxHostOptions) {
    this.spawnFn = opts.spawn;
    this.idleMs = opts.idleMs;
  }

  /**
   * A session for `modelPath`. Cheap and lazy: no child is spawned until
   * something actually runs, so building providers costs nothing.
   */
  session(modelPath: string): OnnxSessionLike {
    return { run: (feeds) => this.run(modelPath, feeds) };
  }

  /** Kill the worker. This is what reclaims the 3-5GB. */
  shutdown(): void {
    this.rejectAll(new Error("ONNX worker shut down before returning a result"));
    this.kill();
  }

  private run(
    modelPath: string,
    feeds: Record<string, OnnxTensorDTO>,
  ): Promise<Record<string, OnnxTensorDTO>> {
    const child = this.ensureChild();
    this.clearIdle(); // busy again
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ kind: "run", id, modelPath, feeds });
    });
  }

  private clearIdle(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Start the idle clock, but only once nothing is outstanding. */
  private armIdle(): void {
    if (this.idleMs === undefined || this.pending.size > 0 || !this.child) return;
    this.clearIdle();
    const t = setTimeout(() => {
      this.idleTimer = undefined;
      this.kill();
    }, this.idleMs);
    // Never hold the process open just to expire a cache.
    (t as unknown as { unref?: () => void }).unref?.();
    this.idleTimer = t;
  }

  private kill(): void {
    this.clearIdle();
    this.child?.kill();
    this.child = undefined;
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private ensureChild(): OnnxTransport {
    if (this.child) return this.child;
    this.child = this.spawnFn({
      onMessage: (msg) => this.onMessage(msg as OnnxResponse),
      onExit: (detail) => this.onExit(detail),
    });
    return this.child;
  }

  private onMessage(msg: OnnxResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return; // late reply for something already settled
    this.pending.delete(msg.id);
    if (msg.kind === "ok") p.resolve(msg.outputs);
    else p.reject(new Error(msg.message));
    this.armIdle();
  }

  /**
   * The worker died — very likely the OOM this design contains. Fail every
   * request in flight so callers see an error instead of hanging, and drop the
   * handle so the next call spawns a fresh one.
   */
  private onExit(detail?: string): void {
    this.child = undefined;
    this.clearIdle();
    this.rejectAll(
      new Error(
        `ONNX worker exited before returning a result${detail ? ` (${detail})` : ""}`,
      ),
    );
  }
}
