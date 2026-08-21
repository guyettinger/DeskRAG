/**
 * ActiveWindowProducer — polls the focused window via active-win (an
 * optionalDependency) and emits `focus_change` whenever the app/window changes.
 * These are exactly the boundaries the Segmenter, the digest, and the trace IR
 * consume. Not imported by the package barrel (keeps the native module out of the
 * default graph).
 *
 * It also owns DISPLAY TOPOLOGY, because the re-query signal is "a focused window
 * whose bounds lie outside every known display" and this is the only producer
 * that sees window bounds. `CaptureContext` is emit-only — producers cannot
 * observe each other's events — so the check anywhere else would need a second
 * poller.
 */

import activeWindow from "active-win";
import type { CaptureContext, Producer } from "../types.js";
import { outsideKnownDisplays } from "../env/displays.js";
import type { DisplayInfo, DisplaySource } from "../env/types.js";

export interface WindowSnapshot {
  app: string;
  title: string;
  windowId: number;
  /** The focused application's process id, for the `recorder` comparison. */
  pid?: number;
  bundleId?: string;
  url?: string;
  bounds?: { x: number; y: number; w: number; h: number };
}

export interface ActiveWindowOptions {
  /** Poll interval in ms (default 500). */
  pollMs?: number;
  /** When set, the producer also tracks display topology. */
  displaySource?: DisplaySource;
  /**
   * The process id of whatever is DOING the recording, so a `focus_change` onto
   * it can say so. Defaults to this process, which is the answer whenever
   * capture runs inside the recorder's own application.
   *
   * A pid rather than a name because a name is a guess: the same build reports
   * `Electron` from a dev checkout and its product name from a signed bundle,
   * and a mismatch fails SILENTLY by excluding nothing. The frontmost window of
   * an Electron app belongs to its main process, which is this one.
   */
  selfPid?: number;
}

export class ActiveWindowProducer implements Producer {
  readonly id = "active-win";
  private timer: NodeJS.Timeout | undefined;
  private lastKey: string | undefined;
  private polling = false;
  private displays: DisplayInfo[] = [];
  private readonly pollMs: number;
  private readonly displaySource: DisplaySource | undefined;
  private readonly selfPid: number;

  constructor(opts: ActiveWindowOptions = {}) {
    this.pollMs = opts.pollMs ?? 500;
    this.displaySource = opts.displaySource;
    this.selfPid = opts.selfPid ?? process.pid;
  }

  /** The native query, isolated so tests can subclass and script it. */
  protected async queryWindow(): Promise<WindowSnapshot | undefined> {
    const win = await activeWindow();
    if (!win) return undefined;
    const owner = win.owner as
      | { name?: string; bundleId?: string; processId?: number }
      | undefined;
    const url = (win as { url?: unknown }).url;
    return {
      app: owner?.name ?? "unknown",
      title: win.title,
      windowId: win.id,
      ...(typeof owner?.processId === "number" ? { pid: owner.processId } : {}),
      ...(typeof owner?.bundleId === "string" ? { bundleId: owner.bundleId } : {}),
      ...(typeof url === "string" ? { url } : {}),
      ...(win.bounds !== undefined
        ? {
            bounds: { x: win.bounds.x, y: win.bounds.y, w: win.bounds.width, h: win.bounds.height },
          }
        : {}),
    };
  }

  /** One poll cycle. Exposed for tests; `start()` schedules it. */
  async pollOnce(ctx: CaptureContext): Promise<void> {
    if (this.polling) return; // don't overlap slow queries
    this.polling = true;
    try {
      // Topology first, so a display_change always precedes the focus_change
      // whose coordinates it explains.
      if (this.displaySource !== undefined && this.displays.length === 0) {
        await this.refreshDisplays(ctx);
      }

      const win = await this.queryWindow();
      if (win === undefined) return;

      if (
        this.displaySource !== undefined &&
        win.bounds !== undefined &&
        outsideKnownDisplays(this.displays, win.bounds)
      ) {
        await this.refreshDisplays(ctx);
      }

      const key = `${win.app} ${win.title}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      ctx.emitEvent({
        kind: "focus_change",
        data: {
          app: win.app,
          title: win.title,
          windowId: win.windowId,
          // Stamped at CAPTURE time, because only the capturing process knows
          // its own pid. Consumers that want to drop the recorder's own
          // stretches read this; recordings taken before it existed carry no
          // flag, which is why `excludedByName` also matches on name.
          ...(win.pid !== undefined ? { pid: win.pid } : {}),
          ...(win.pid === this.selfPid ? { recorder: true } : {}),
          ...(win.bundleId !== undefined ? { bundleId: win.bundleId } : {}),
          ...(win.url !== undefined ? { url: win.url } : {}),
          ...(win.bounds !== undefined ? { bounds: win.bounds } : {}),
        },
      });
    } catch {
      // permission denied / transient: skip this tick
    } finally {
      this.polling = false;
    }
  }

  /** Re-query topology; an empty result keeps what we knew. Stale beats empty. */
  private async refreshDisplays(ctx: CaptureContext): Promise<void> {
    const next = await this.displaySource!.query();
    if (next.length === 0) return;
    this.displays = next;
    ctx.emitEvent({ kind: "display_change", data: { displays: next } });
  }

  start(ctx: CaptureContext): void {
    void this.pollOnce(ctx);
    this.timer = setInterval(() => void this.pollOnce(ctx), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.displaySource?.close?.();
  }
}
