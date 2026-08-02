import { describe, expect, it } from "vitest";
import { extractPredicates } from "../src/trace/predicates.js";
import { REACH_BY_KIND } from "../src/trace/types.js";

describe("url predicate", () => {
  it("is assertable — there is no navigation repair", () => {
    // `app` is achievable because activation repairs it. Nothing in the
    // executor navigates, so a url can only gate — and being on the wrong site
    // should be exactly an unoverridable blocker.
    expect(REACH_BY_KIND.url).toBe("assertable");
  });

  it("is emitted as the reduced prefix, not the raw URL", () => {
    const preds = extractPredicates([], {
      app: "Google Chrome",
      url: "https://github.com/guyettinger/DeskRAG/pull/27",
    });
    const url = preds.find((p) => p.kind === "url");
    expect(url?.args["prefix"]).toBe("github.com/guyettinger/DeskRAG/pull");
    expect(url?.reach).toBe("assertable");
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
