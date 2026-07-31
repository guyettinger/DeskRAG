/**
 * A boundary AX snapshot is written AFTER the boundary it describes —
 * `BoundaryAxTrigger` waits out a settle delay (250ms) and the walk itself is
 * budgeted at 800ms. So "latest at-or-before the boundary" can never find it,
 * and instead returns the snapshot from the PREVIOUS state.
 *
 * Measured on a real recording: a node at the focus_change boundary to WebStorm
 * carried `app(app="WebStorm")` from the focus event but TextEdit's entire AX
 * tree, because the WebStorm snapshot landed 251ms later. Every focus_change
 * boundary node paired the new app's name with the old app's UI.
 *
 * The fix stamps the boundary's own `t_mono` onto the snapshot, so lift matches
 * exactly instead of inferring from timing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { makeStore, type TestCtx } from "./helpers.js";
import type { UIElement } from "../src/embed/types.js";

const els = (label: string): UIElement[] => [
  { role: "Window", label, x: 0, y: 0, w: 100, h: 100 },
];

describe("boundary-stamped AX snapshots", () => {
  let ctx: TestCtx;
  let sessionId: string;

  beforeEach(async () => {
    ctx = await makeStore([]);
    sessionId = ulid();
    await ctx.store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  });
  afterEach(() => ctx.cleanup());

  it("retrieves the snapshot captured FOR a boundary, not the one preceding it", async () => {
    const { store } = ctx;
    // The previous state's snapshot, captured before the boundary.
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 4463, frameId: null,
      reason: "focus_change", walkMs: 5, elements: els("TextEdit"),
    });
    // The boundary fires at 6692; its snapshot lands 251ms later.
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 6943, frameId: null,
      reason: "focus_change", walkMs: 5, elements: els("WebStorm"),
      boundaryTMono: 6692,
    });

    // The timing-based lookup still finds the stale one — that is the bug.
    expect(store.getAxAt(sessionId, 6692)?.elements[0]!.label).toBe("TextEdit");

    // The boundary-keyed lookup finds the snapshot actually taken for it.
    expect(store.getAxForBoundary(sessionId, 6692)?.elements[0]!.label).toBe("WebStorm");
  });

  it("returns undefined for a boundary that never had a snapshot stamped", async () => {
    const { store } = ctx;
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 100, frameId: null,
      reason: "keyframe", walkMs: 1, elements: els("A"),
    });
    expect(store.getAxForBoundary(sessionId, 100)).toBeUndefined();
  });

  it("does not stamp keyframe snapshots, which are keyed by frame", async () => {
    const { store } = ctx;
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 200, frameId: null,
      reason: "keyframe", walkMs: 1, elements: els("A"),
    });
    // No boundary was involved, so nothing is retrievable by boundary.
    expect(store.getAxForBoundary(sessionId, 200)).toBeUndefined();
    expect(store.getAxAt(sessionId, 200)).toBeDefined();
  });
});
