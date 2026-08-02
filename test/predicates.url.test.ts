import { describe, expect, it } from "vitest";
import { extractPredicates } from "../src/trace/predicates.js";
import { REACH_BY_KIND } from "../src/trace/types.js";

describe("url predicate", () => {
  it("is ACHIEVABLE — an edge in the graph navigates", () => {
    // Reach asks whether some edge ESTABLISHES the predicate, not whether the
    // executor has a synthesized repair for it. Written `assertable` at first,
    // which made every browser node a permanently unreachable goal: buildPlan
    // turns an unmet assertable predicate on any remainder node into an
    // unoverridable blocker, and a real plan toward a GitHub page was blocked
    // with nothing to override.
    //
    // No protection is lost — wrong-page replay is prevented by verification
    // and locating, which both still gate on this predicate.
    expect(REACH_BY_KIND.url).toBe("achievable");
  });

  it("is emitted as the reduced prefix, not the raw URL", () => {
    const preds = extractPredicates([], {
      app: "Google Chrome",
      url: "https://github.com/guyettinger/DeskRAG/pull/27",
    });
    const url = preds.find((p) => p.kind === "url");
    expect(url?.args["prefix"]).toBe("github.com/guyettinger/DeskRAG/pull");
    expect(url?.reach).toBe("achievable");
  });

  it("emits nothing for a scheme that names no site", () => {
    const preds = extractPredicates([], { app: "Google Chrome", url: "about:blank" });
    expect(preds.some((p) => p.kind === "url")).toBe(false);
  });

  it("emits nothing when there is no URL at all", () => {
    const preds = extractPredicates([], { app: "TextEdit" });
    expect(preds.some((p) => p.kind === "url")).toBe(false);
  });

  it("emits exactly one url predicate", () => {
    const preds = extractPredicates([], {
      app: "Google Chrome",
      url: "https://example.com/a/b",
    });
    expect(preds.filter((p) => p.kind === "url")).toHaveLength(1);
  });
});
