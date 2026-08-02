import { describe, expect, it } from "vitest";
import { extractPredicates } from "../src/trace/predicates.js";
import type { UIElement } from "../src/embed/types.js";

// Roles WITHOUT the "AX" prefix — the shape ax-dump actually emits
// (`rawRole.dropFirst(2)`). Matching the prefixed spelling has already shipped
// once and produced zero predicates from every real recording.
const el = (over: Partial<UIElement>): UIElement => ({
  role: "Button",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  ...over,
});

describe("identifier-keyed ax_exists", () => {
  it("emits an identifier-keyed predicate for a labelless element", () => {
    // Measured: the target of the failing live run is `TextArea #First Text
    // View` — an identifier and no label — and it contributed nothing.
    const preds = extractPredicates([el({ role: "TextArea", identifier: "First Text View" })]);
    expect(preds).toEqual([
      {
        kind: "ax_exists",
        args: { role: "TextArea", identifier: "First Text View" },
        reach: "achievable",
      },
    ]);
  });

  it("prefers the identifier when an element has both, emitting ONE predicate", () => {
    // Two predicates from one element would shift every count and silently move
    // the truncation cap.
    const preds = extractPredicates([el({ label: "Save", identifier: "save-btn" })]);
    expect(preds).toHaveLength(1);
    expect(preds[0]?.args).toEqual({ role: "Button", identifier: "save-btn" });
  });

  it("still emits a label-keyed predicate when there is no identifier", () => {
    const preds = extractPredicates([el({ label: "Save" })]);
    expect(preds[0]?.args).toEqual({ role: "Button", label: "Save" });
  });

  it("emits nothing for an element with neither", () => {
    expect(extractPredicates([el({})])).toEqual([]);
  });

  it("keeps an identifier even when the label is volatile", () => {
    // "Inbox (14)" is a badge count; the identifier behind it is not, so the
    // element survives instead of being dropped whole.
    const preds = extractPredicates([el({ label: "Inbox (14)", identifier: "inbox" })]);
    expect(preds[0]?.args).toEqual({ role: "Button", identifier: "inbox" });
  });

  it("normalizes a prefixed role in the args, not just in the match", () => {
    const preds = extractPredicates([el({ role: "AXButton", identifier: "x" })]);
    expect(preds[0]?.args["role"]).toBe("Button");
  });

  it("de-duplicates by the descriptor actually used", () => {
    const preds = extractPredicates([
      el({ identifier: "dup" }),
      el({ identifier: "dup" }),
      el({ label: "dup" }),
    ]);
    // Two distinct predicates: one identifier-keyed, one label-keyed.
    expect(preds).toHaveLength(2);
  });
});
