/**
 * `captionExclusionFor` — which segments the captioner does not spend a call on.
 *
 * Reachable from the ROOT suite because `caption-exclusion.ts` imports no
 * electron and no native subpath, the same condition `index-plan.ts`,
 * `graph-view.ts` and `session-tracks.ts` meet.
 *
 * The two rules under test are the ones `excludeFocusedApps` already paid for,
 * and both fail SILENTLY when they are wrong: a session with no `focus_change`
 * that excluded everything would caption nothing at all and look like a broken
 * captioner, and a preamble attributed to nothing would caption the recorder's
 * opening stretch on every recording ever taken.
 */

import { describe, expect, it } from "vitest";
import { captionExclusionFor } from "../app/src/main/caption-exclusion.js";
import { excludedByName } from "../src/trace/exclude.js";
import type { TraceEvent } from "../src/trace/types.js";

const ev = (tMono: number, kind: string, data?: unknown): TraceEvent =>
  ({ id: `e${tMono}`, sessionId: "s", tMono, kind, x: null, y: null, data: data ?? null }) as TraceEvent;

const focus = (tMono: number, app: string): TraceEvent => ev(tMono, "focus_change", { app });

const isRecorder = excludedByName(["DeskRAG"]);

describe("captionExclusionFor", () => {
  it("excludes a segment whose focus at-or-before names an excluded app", () => {
    const p = captionExclusionFor([focus(0, "DeskRAG"), focus(5000, "Slack")], isRecorder)!;
    expect(p(0)).toBe(true);
    expect(p(4999)).toBe(true);
    expect(p(5000)).toBe(false);
    expect(p(9000)).toBe(false);
  });

  it("attributes the PREAMBLE to the first focus_change", () => {
    // Segmentation pins the first boundary at t_mono 0, before any focus event
    // exists. Under a strict at-or-before rule that segment resolves to nothing
    // and gets captioned — which is precisely the recorder's opening stretch.
    const p = captionExclusionFor([focus(3000, "DeskRAG"), focus(8000, "Chrome")], isRecorder)!;
    expect(p(0)).toBe(true);
    expect(p(2999)).toBe(true);
    expect(p(8000)).toBe(false);
  });

  it("returns undefined when the session carries no focus_change at all", () => {
    // With `active-win` off nothing is attributable, and a predicate that
    // answered "excluded" here would caption nothing in the whole recording.
    expect(captionExclusionFor([ev(0, "mouse_move"), ev(1, "key_down")], isRecorder)).toBeUndefined();
    expect(captionExclusionFor([], isRecorder)).toBeUndefined();
  });

  it("excludes nothing when the excluded list is empty", () => {
    const p = captionExclusionFor([focus(0, "DeskRAG")], excludedByName([]))!;
    expect(p(0)).toBe(false);
  });

  it("matches the capture-time recorder flag and a bundle id, not only a name", () => {
    const byFlag = captionExclusionFor(
      [ev(0, "focus_change", { app: "Something Else", recorder: true })],
      excludedByName([]),
    )!;
    expect(byFlag(0)).toBe(true);

    const byBundle = captionExclusionFor(
      [ev(0, "focus_change", { bundleId: "com.deskrag.app" })],
      excludedByName(["com.deskrag.app"]),
    )!;
    expect(byBundle(0)).toBe(true);
  });

  it("resolves against an out-of-order stream rather than whatever came last", () => {
    const p = captionExclusionFor([focus(5000, "Slack"), focus(0, "DeskRAG")], isRecorder)!;
    expect(p(1000)).toBe(true);
    expect(p(5000)).toBe(false);
  });
});
