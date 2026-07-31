/**
 * The `ax-exec` client: process lifecycle plus the JSON line protocol.
 *
 * This is the ONLY module in `replay/` that spawns anything. Because it merely
 * spawns a binary rather than loading a native module, `replay/` stays
 * barrel-exportable — importing it loads nothing until it runs.
 *
 * The process is long-lived for the length of a replay so AX element references
 * stay warm between `locate` and the action that uses them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Actuator, AxDescriptor, AxObservation, Rect, UIElement, Vec2 } from "./types.js";

export interface SidecarOptions {
  /** Passed as `--plan`; the binary refuses to start without it. */
  planId: string;
  /** Defaults to `native/ax-exec`. */
  binaryPath?: string;
  /** Extra argv before `--plan`, so a test can stub the binary. */
  args?: string[];
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class AxExecSidecar implements Actuator {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private closed = false;

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.on("exit", (code) => this.failAll(new Error(`ax-exec exited with code ${code}`)));
    proc.on("error", (err) => this.failAll(err));
  }

  static spawn(opts: SidecarOptions): AxExecSidecar {
    const bin = opts.binaryPath ?? "native/ax-exec";
    const argv = [...(opts.args ?? []), "--plan", opts.planId];
    const proc = spawn(bin, argv, { stdio: ["pipe", "pipe", "pipe"] });
    return new AxExecSidecar(proc, opts.timeoutMs ?? 5000);
  }

  /**
   * A real AX dump exceeds 64KB, so stdout arrives in several chunks and a chunk
   * boundary lands mid-JSON. Buffer until a newline before parsing.
   */
  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // a stray non-JSON line is not worth killing a replay over
      }
      if (typeof msg.id !== "number") continue;
      const p = this.pending.get(msg.id);
      if (p === undefined) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === true) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "ax-exec reported failure"));
    }
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private send<T>(cmd: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ax-exec is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ax-exec timed out on ${cmd}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  }

  async dump(): Promise<AxObservation> {
    const r = await this.send<AxObservation | UIElement[] | null>("dump");
    // Tolerate the older bare-array shape so a stale binary degrades to
    // AX-only observation rather than throwing mid-plan.
    if (Array.isArray(r)) return { elements: r };
    return {
      elements: r?.elements ?? [],
      ...(r?.app !== undefined ? { app: r.app } : {}),
      ...(r?.windowTitle !== undefined ? { windowTitle: r.windowTitle } : {}),
    };
  }

  async locate(d: AxDescriptor): Promise<{ handle: number; bounds: Rect } | null> {
    const r = await this.send<{ handle: number; bounds: Rect } | null>("locate", { ...d });
    return r ?? null;
  }

  async moveTo(p: Vec2): Promise<void> {
    await this.send("move", { x: p.x, y: p.y });
  }

  async click(p: Vec2, button: number, count: number): Promise<void> {
    await this.send("click", { x: p.x, y: p.y, button, count });
  }

  async dragPath(samples: readonly { p: Vec2; atMs: number }[], button: number): Promise<void> {
    await this.send("drag", {
      button,
      samples: samples.map((s) => ({ x: s.p.x, y: s.p.y, atMs: s.atMs })),
    });
  }

  async scroll(p: Vec2, delta: Vec2, steps: number): Promise<void> {
    await this.send("scroll", { x: p.x, y: p.y, dx: delta.x, dy: delta.y, steps });
  }

  async key(keycode: number, modifiers: readonly string[], down: boolean): Promise<void> {
    await this.send("key", { keycode, modifiers: [...modifiers], down });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.write(`${JSON.stringify({ id: 0, cmd: "quit" })}\n`);
    } catch {
      // already gone
    }
    this.proc.kill();
    this.failAll(new Error("ax-exec closed"));
  }
}
