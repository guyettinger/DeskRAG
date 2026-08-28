/**
 * An `Actuator` over a RECORDING instead of a live desktop.
 *
 * The decisive question about a habit is whether it transfers: does it still
 * resolve against a screen it was not built from? Answering that live means
 * arranging the other screen by hand, which is why it has never been answered
 * here. But every recording already contains a sequence of real AX trees, and
 * `buildPlan` needs only `observed: Predicate[]` and a `Locate` — no actuator at
 * all. So a recording can BE the other screen.
 *
 * ## Why this file is in `app/src/main/` and not in `src/replay/`
 *
 * `test/replay.barrel.test.ts` asserts that no file in `replay/` imports
 * `../store/`, and that guard is the whole safety story for the executor. A
 * stored actuator needs recorded data, so it lives outside that boundary. It
 * takes the observations already marshalled — it does not read the store itself
 * — which keeps it pure, root-testable with no database, and follows the
 * `graph-view.ts` precedent of injecting the thing that needs I/O.
 *
 * ## Every mutator THROWS, and that is not the safety story
 *
 * The read-only proxy in `scripts/probes/replay.ts` is, and callers should still
 * wrap this. Throwing here says something different and narrower: a recorded
 * world CANNOT be changed. Silently accepting a click and returning would let a
 * caller believe it had advanced a state it had not, and report a transfer that
 * never happened. Refusing is the only honest answer a past moment can give.
 *
 * ## The cursor is stepped by the harness, never by an action
 *
 * Live, the world advances because the executor posts something. Here nothing is
 * posted, so the world advances by moving to the next recorded moment — the
 * recording is a replay of itself. That makes the measurement "could each
 * segment be planned against the state that actually followed", which is what
 * transfer means, rather than "did our clicks work" — which a recording cannot
 * answer for a plan it did not come from.
 */

import { axPathOf, surfaceOriginOf, type UIElement } from "deskrag";
import type {
  ActivateOutcome,
  Actuator,
  AxDescriptor,
  AxObservation,
  LocateHit,
  Vec2,
} from "deskrag";

/** Thrown by every mutator. Named so a caller can tell it from a real failure. */
export class StoredWorldError extends Error {
  constructor(method: string) {
    super(
      `StoredActuator cannot ${method}(): a recorded world cannot be changed. ` +
        `Advance the cursor to the next recorded moment instead.`,
    );
    this.name = "StoredWorldError";
  }
}

export class StoredActuator implements Actuator {
  /** Which recorded moment is "now". Stepped by `seek`/`advance`, never by an action. */
  private cursor = 0;

  constructor(private readonly moments: readonly AxObservation[]) {}

  get length(): number {
    return this.moments.length;
  }

  get at(): number {
    return this.cursor;
  }

  /** Clamped rather than throwing: running past the end is an ordinary outcome. */
  seek(index: number): void {
    this.cursor = Math.max(0, Math.min(index, this.moments.length - 1));
  }

  /** False when there is no later moment — the recording ended. */
  advance(): boolean {
    if (this.cursor >= this.moments.length - 1) return false;
    this.cursor += 1;
    return true;
  }

  async dump(): Promise<AxObservation> {
    return this.moments[this.cursor] ?? { elements: [] };
  }

  /**
   * Every application the RECORDING saw, not every application on the machine.
   *
   * Planning uses this to choose between a repair step and a blocker. Answering
   * from the live desktop would let a plan resolve against an app that happened
   * to be open here and was never in the recording, which is the one thing a
   * transfer test must not do.
   */
  async runningApps(): Promise<string[]> {
    const out: string[] = [];
    for (const m of this.moments) {
      if (m.app !== undefined && m.app.length > 0 && !out.includes(m.app)) out.push(m.app);
    }
    return out;
  }

  /**
   * The same ladder `ax-exec` uses, in the same order: identifier, then path,
   * then label+role — and each rung is exclusive, so a descriptor carrying an
   * identifier that misses does NOT fall through to its label. Two resolvers
   * disagreeing about one tree is the `ax-dump`/`ax-exec` drift hazard, and the
   * ordering is the part of it that would fail quietly.
   */
  async locate(d: AxDescriptor): Promise<LocateHit | null> {
    const els = this.moments[this.cursor]?.elements ?? [];
    const index = locateIn(els, d);
    if (index === undefined) return null;
    const e = els[index]!;
    // The surface it actually sits in — a menu item's MENU, not the app window
    // it happens to hang under. A recorded anchor is window-relative to what the
    // OS called a window, and while a menu is open that is the menu.
    const surfaceOrigin = surfaceOriginOf(els, index);
    return {
      handle: index,
      bounds: { x: e.x, y: e.y, w: e.w, h: e.h },
      ...(surfaceOrigin !== undefined ? { surfaceOrigin } : {}),
    };
  }

  async activate(_app: string, _launch: boolean): Promise<ActivateOutcome> {
    throw new StoredWorldError("activate");
  }
  async moveTo(_p: Vec2): Promise<void> {
    throw new StoredWorldError("moveTo");
  }
  async click(_p: Vec2, _button: number, _count: number): Promise<void> {
    throw new StoredWorldError("click");
  }
  async dragPath(): Promise<void> {
    throw new StoredWorldError("dragPath");
  }
  async scroll(): Promise<void> {
    throw new StoredWorldError("scroll");
  }
  async key(): Promise<void> {
    throw new StoredWorldError("key");
  }
}

/** `ax-exec`'s `locate` case, in TypeScript, over a stored tree. */
export function locateIn(
  elements: readonly UIElement[],
  d: AxDescriptor,
): number | undefined {
  if (d.identifier !== undefined && d.identifier.length > 0) {
    const i = elements.findIndex((e) => e.identifier === d.identifier);
    return i >= 0 ? i : undefined;
  }
  if (d.path !== undefined && d.path.length > 0) {
    // `axPathOf` is the SAME rule `ax-exec`'s Swift `pathOf` implements — its
    // own comment says so — so a path recorded by one resolves under the other.
    for (let i = 0; i < elements.length; i += 1) {
      if (axPathOf(elements, i) === d.path) return i;
    }
    return undefined;
  }
  if (d.label !== undefined && d.label.length > 0) {
    const i = elements.findIndex(
      (e) => e.label === d.label && (d.role === undefined || e.role === d.role),
    );
    return i >= 0 ? i : undefined;
  }
  return undefined;
}
