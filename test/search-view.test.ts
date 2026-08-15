/**
 * The Search screen's pure projections. Root-tested for the same reason
 * `graph-view.ts` and `track-view.ts` are: they decide what a result row CLAIMS,
 * and nothing else in the suite can see the renderer.
 */

import { describe, expect, it } from "vitest";
import { laneLabel, laneText, scoresAreTied } from "@shared/evidence";
import {
  evidenceBars,
  locatorTicks,
  rowText,
} from "../app/src/renderer/src/search-view.js";

const texts = (
  over: Partial<{
    segmentCaption: string | null;
    segmentDigest: string | null;
    segmentTranscript: string | null;
    taskSummary: string | null;
  }> = {},
) => ({
  segmentCaption: null,
  segmentDigest: null,
  segmentTranscript: null,
  taskSummary: null,
  ...over,
});

const hit = (
  over: Partial<{
    score: number;
    sessionId: string;
    offsetSec: number;
    sessionSpanSec: number;
  }> = {},
): { score: number; sessionId: string; offsetSec: number; sessionSpanSec: number } => ({
  score: 1,
  sessionId: "s1",
  offsetSec: 0,
  sessionSpanSec: 40,
  ...over,
});

describe("rowText", () => {
  /**
   * The defect this pass exists to fix: the card read `segmentDigest` directly
   * and printed "no digest" over frames the rest of the app was captioning.
   */
  it("prefers the caption, and then shows the digest as its own line", () => {
    const t = rowText(texts({ segmentCaption: "A pull request diff", segmentDigest: "Chrome. 1 click." }));
    expect(t.headline).toBe("A pull request diff");
    expect(t.digest).toBe("Chrome. 1 click.");
  });

  /** No caption: the digest IS the headline, so it must not also appear below. */
  it("never prints the digest twice", () => {
    const t = rowText(texts({ segmentDigest: "Chrome. 1 click." }));
    expect(t.headline).toBe("Chrome. 1 click.");
    expect(t.digest).toBeNull();
  });

  /**
   * `keyframeLabel` ends at the timecode, and a row already prints the timecode
   * in its header — falling through to it produced a headline restating the line
   * directly above it. The chain ends at the task here instead.
   */
  it("promotes the task rather than repeating the timecode, and then drops the task line", () => {
    const t = rowText(texts({ taskSummary: "Add numbers from 1 to 6" }));
    expect(t.headline).toBe("Add numbers from 1 to 6");
    expect(t.task).toBeNull();
  });

  it("keeps the task as context whenever something else took the headline", () => {
    const t = rowText(texts({ segmentDigest: "Chrome. 1 click.", taskSummary: "Review the PR" }));
    expect(t.headline).toBe("Chrome. 1 click.");
    expect(t.task).toBe("Review the PR");
  });

  it("has no headline at all when nothing describes the frame", () => {
    expect(rowText(texts()).headline).toBeNull();
  });

  /** An empty string is absence, and `??` alone would let it win. */
  it("treats blank and whitespace-only text as absent", () => {
    const t = rowText(texts({ segmentCaption: "   ", segmentDigest: "", taskSummary: "Review the PR" }));
    expect(t.headline).toBe("Review the PR");
    expect(rowText(texts({ segmentTranscript: "  " })).said).toBeNull();
  });

  it("carries speech through untouched", () => {
    expect(rowText(texts({ segmentTranscript: "(tense music)" })).said).toBe("(tense music)");
  });
});

describe("laneLabel", () => {
  it("names a lane for the reader, not for the index", () => {
    expect(laneLabel("digest")).toBe("what happened");
    expect(laneLabel("transcript")).toBe("what was said");
    expect(laneLabel("region_label")).toBe("on-screen label");
    expect(laneLabel("lexical")).toBe("exact words");
  });

  /**
   * A lane added later should look UNFINISHED here rather than be absorbed into
   * a plausible-sounding catch-all — "other" would hide the omission forever.
   */
  it("falls through to the raw key rather than to a catch-all", () => {
    expect(laneLabel("some_new_view")).toBe("some_new_view");
  });
});

describe("laneText", () => {
  it("appends a count only when there is more than one", () => {
    expect(laneText({ key: "region_label", count: 7 })).toBe("on-screen label ×7");
    expect(laneText({ key: "region_label", count: 1 })).toBe("on-screen label");
    expect(laneText({ key: "digest" })).toBe("what happened");
  });
});

describe("evidenceBars", () => {
  it("fills relative to the best hit in the list", () => {
    const { fill, tied } = evidenceBars([hit({ score: 1 }), hit({ score: 0.5 }), hit({ score: 0 })]);
    expect(fill).toEqual([1, 0.5, 0]);
    expect(tied).toBe(false);
  });

  /**
   * A Tier-4 rerank REORDERS without recomputing scores, so the list can be
   * non-monotonic and index 0 is not necessarily the maximum. Dividing by
   * `hits[0].score` would then push later bars past full.
   */
  it("takes the maximum from the whole list, not from index 0", () => {
    const { fill } = evidenceBars([hit({ score: 0.5 }), hit({ score: 1 })]);
    expect(fill).toEqual([0.5, 1]);
    expect(Math.max(...fill)).toBeLessThanOrEqual(1);
  });

  /**
   * Eleven frames tying to six decimals is documented behaviour when nothing but
   * shared segment membership separates them. Full bars everywhere would assert
   * unanimous agreement, which is the opposite of what a tie means.
   */
  it("reports a tie instead of drawing every bar full", () => {
    const { fill, tied } = evidenceBars([hit({ score: 0.5 }), hit({ score: 0.5 }), hit({ score: 0.5 })]);
    expect(tied).toBe(true);
    expect(new Set(fill).size).toBe(1);
    expect(fill[0]).toBeLessThan(1);
  });

  it("a single hit is not a tie — there is nothing for it to tie with", () => {
    const { fill, tied } = evidenceBars([hit({ score: 0.42 })]);
    expect(tied).toBe(false);
    expect(fill).toEqual([1]);
  });

  it("survives an empty list and an all-zero list", () => {
    expect(evidenceBars([])).toEqual({ fill: [], tied: false });
    const zero = evidenceBars([hit({ score: 0 }), hit({ score: 0 })]);
    expect(zero.tied).toBe(true);
    expect(zero.fill.every((f) => Number.isFinite(f))).toBe(true);
  });
});

describe("locatorTicks", () => {
  it("places a hit on its recording's axis", () => {
    const hits = [hit({ offsetSec: 10, sessionSpanSec: 40 })];
    expect(locatorTicks(hits, 0)).toEqual({ self: 0.25, others: [] });
  });

  /**
   * The other ticks are the whole reason the strip is worth 3px: several results
   * from one recording read as a cluster rather than as unrelated rows.
   */
  it("marks the other hits from the SAME recording, and no others", () => {
    const hits = [
      hit({ sessionId: "a", offsetSec: 10, sessionSpanSec: 40 }),
      hit({ sessionId: "a", offsetSec: 30, sessionSpanSec: 40 }),
      hit({ sessionId: "b", offsetSec: 20, sessionSpanSec: 40 }),
    ];
    expect(locatorTicks(hits, 0)).toEqual({ self: 0.25, others: [0.75] });
    expect(locatorTicks(hits, 2)).toEqual({ self: 0.5, others: [] });
  });

  /**
   * No axis means nothing can be placed on it. An invented span would put every
   * tick somewhere meaningless — the rail's rule for a lane with no coverage.
   */
  it("withholds the strip when the recording has no span", () => {
    expect(locatorTicks([hit({ sessionSpanSec: 0 })], 0)).toBeNull();
    expect(locatorTicks([hit({ sessionSpanSec: -1 })], 0)).toBeNull();
  });

  /** A hit whose frame row has gone names no recording, so it locates nowhere. */
  it("withholds the strip for a hit with no session", () => {
    expect(locatorTicks([hit({ sessionId: "" })], 0)).toBeNull();
  });

  it("clamps a moment past the end of its own axis rather than overflowing", () => {
    const hits = [hit({ offsetSec: 99, sessionSpanSec: 40 })];
    expect(locatorTicks(hits, 0)!.self).toBe(1);
  });

  it("is null for an index that is not in the list", () => {
    expect(locatorTicks([], 0)).toBeNull();
  });
});
