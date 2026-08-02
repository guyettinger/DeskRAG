import { describe, expect, it } from "vitest";
import { locateNode } from "../src/replay/locate.js";
import { verifyNode } from "../src/replay/verify.js";
import type { Predicate } from "../src/replay/types.js";
import type { TraceNode } from "../src/trace/types.js";

const app = (name: string): Predicate => ({
  kind: "app",
  args: { app: name },
  reach: "achievable",
});
const exists = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "Button", label },
  reach: "achievable",
});
const node = (id: string, predicates: Predicate[]): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

describe("weak nodes", () => {
  const weak = node("n3", [app("Google Chrome")]);

  it("verifies — 'did I reach Chrome?' is a real question with a real answer", () => {
    expect(verifyNode(weak.predicates, [app("Google Chrome"), exists("anything")]).satisfied).toBe(
      true,
    );
  });

  it("is never a locate candidate, however well it matches", () => {
    // `app` is shared by every node in an application, so it cannot answer
    // "which of these states am I in?" — the question locating asks.
    const located = locateNode([app("Google Chrome"), exists("anything")], [weak]);
    expect(located.nodeId).toBeUndefined();
    expect(located.candidates).toBe(0);
  });

  it("does not block a locatable node in the same app", () => {
    const strong = node("n4", [app("Google Chrome"), exists("Files changed")]);
    const located = locateNode([app("Google Chrome"), exists("Files changed")], [weak, strong]);
    expect(located.nodeId).toBe("n4");
  });

  it("still excludes a zero-predicate node, which is vacuously satisfied", () => {
    const empty = node("n0", []);
    expect(locateNode([app("Google Chrome")], [empty]).nodeId).toBeUndefined();
  });

  it("a url alone is enough to locate — it is not the app predicate", () => {
    const scoped = node("n5", [
      app("Google Chrome"),
      { kind: "url", args: { prefix: "github.com/o/r" }, reach: "assertable" },
    ]);
    const located = locateNode(
      [app("Google Chrome"), { kind: "url", args: { prefix: "github.com/o/r" }, reach: "assertable" }],
      [scoped],
    );
    expect(located.nodeId).toBe("n5");
  });
});
