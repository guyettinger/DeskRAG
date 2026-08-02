import { describe, expect, it } from "vitest";
import { urlPrefix } from "../src/trace/url.js";

/**
 * Every URL here except the synthetic depth/id cases was READ FROM A LIVE
 * BROWSER via `ax-dump` (2026-08-01), not invented — the truncation constants
 * are derived from these rather than the reverse.
 */
describe("urlPrefix — measured URLs", () => {
  it("keeps a repo root whole", () => {
    expect(urlPrefix("https://github.com/guyettinger/DeskRAG")).toBe("github.com/guyettinger/DeskRAG");
  });

  it("drops a pull request number, keeping the kind of page", () => {
    expect(urlPrefix("https://github.com/guyettinger/DeskRAG/pull/27")).toBe(
      "github.com/guyettinger/DeskRAG/pull",
    );
  });

  it("separates issues from pulls — they are different states", () => {
    expect(urlPrefix("https://github.com/guyettinger/DeskRAG/issues")).not.toBe(
      urlPrefix("https://github.com/guyettinger/DeskRAG/pull/27"),
    );
  });

  it("caps a deep documentation path", () => {
    expect(
      urlPrefix("https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch"),
    ).toBe("developer.mozilla.org/en-US/docs/Web");
  });

  it("reduces a bare origin to its host", () => {
    expect(urlPrefix("https://example.com/")).toBe("example.com");
  });
});

describe("urlPrefix — the merge/separate contract", () => {
  it("merges two pull requests in one repo", () => {
    expect(urlPrefix("https://github.com/guyettinger/DeskRAG/pull/27")).toBe(
      urlPrefix("https://github.com/guyettinger/DeskRAG/pull/29"),
    );
  });

  it("separates two repos", () => {
    expect(urlPrefix("https://github.com/guyettinger/DeskRAG/pull/27")).not.toBe(
      urlPrefix("https://github.com/guyettinger/Other/pull/1"),
    );
  });

  it("separates two sites", () => {
    expect(urlPrefix("https://github.com/search")).not.toBe(urlPrefix("https://amazon.com/search"));
  });
});

describe("urlPrefix — identifier segments", () => {
  /**
   * An id is removed from the MIDDLE and later segments shift forward into the
   * cap, rather than truncation stopping at the first id. Whether a trailing
   * view survives is therefore a consequence of the cap, not a guarantee —
   * `/document/d/edit` fits in three and keeps `edit`, while
   * `/o/r/pull/27/files` does not and merges with `/o/r/pull`.
   *
   * That merge is accepted deliberately. The cap is the brake on
   * over-specificity, which is the disease being treated; losing the difference
   * between two tabs of one pull request costs far less than a node that can
   * only ever be re-entered on one exact page.
   */
  it("drops an opaque document key, and the view shifts into the cap", () => {
    expect(urlPrefix("https://docs.google.com/document/d/1A2b3C4d5E6f7G8h9I0j/edit")).toBe(
      "docs.google.com/document/d/edit",
    );
  });

  it("still separates a pull request page from the repository root", () => {
    // The failure this whole design exists to fix: a node recorded on a PR page
    // must not be re-entered on the repo home just because a button is on both.
    expect(urlPrefix("https://github.com/guyettinger/DeskRAG/pull/27")).not.toBe(
      urlPrefix("https://github.com/guyettinger/DeskRAG"),
    );
  });

  it("drops a commit sha", () => {
    expect(urlPrefix("https://github.com/o/r/commit/9f2c1ab7d4e5f60182934abcdef01234")).toBe(
      "github.com/o/r/commit",
    );
  });

  /**
   * The measurement caught this: a long repo NAME is not an opaque id, and the
   * first pattern written for this file — /^[A-Za-z0-9_-]{16,}$/ — would have
   * eaten it, silently merging two unrelated repositories. Real opaque keys
   * carry digits; hyphenated words do not.
   */
  it("keeps a long hyphenated name, which is a word and not a key", () => {
    expect(urlPrefix("https://github.com/acme/my-very-long-repo-name")).toBe(
      "github.com/acme/my-very-long-repo-name",
    );
  });
});

describe("urlPrefix — non-states", () => {
  it("ignores query and fragment, which carry session state", () => {
    expect(urlPrefix("https://github.com/o/r?tab=readme#install")).toBe("github.com/o/r");
  });

  it("strips a leading www so one site is one identity", () => {
    expect(urlPrefix("https://www.example.com/a")).toBe("example.com/a");
  });

  it("returns undefined for a scheme that names no site", () => {
    expect(urlPrefix("about:blank")).toBeUndefined();
    expect(urlPrefix("chrome://settings")).toBeUndefined();
    expect(urlPrefix("file:///Users/x/notes.txt")).toBeUndefined();
  });

  it("returns undefined for anything unparseable", () => {
    expect(urlPrefix("not a url")).toBeUndefined();
    expect(urlPrefix("")).toBeUndefined();
  });
});
