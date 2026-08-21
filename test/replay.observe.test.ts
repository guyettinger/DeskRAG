/**
 * Observing the live state as a predicate set.
 *
 * `extractPredicates` sources `app` and `window` from its context, which at lift
 * time is filled from `focus_change` events. At replay there is no event stream,
 * so without the actuator reporting them a live tree yields ONLY `ax_exists` —
 * and since verification requires every expected predicate to hold, no node
 * carrying an `app` predicate could ever verify. Measured on a real desktop: 16
 * observed predicates, none of them `app` or `window`.
 *
 * The app name and the tree come back from ONE call on purpose. Sourcing two
 * halves of a single fact separately is exactly what made boundary snapshots
 * describe the previous application.
 */

import { describe, expect, it } from "vitest";
import { observe } from "../src/replay/observe.js";
import type { ActivateOutcome, Actuator, AxObservation, Rect, Vec2 } from "../src/replay/types.js";
import { predicateKey } from "../src/trace/predicates.js";

class StubActuator implements Actuator {
  constructor(private readonly observation: AxObservation) {}
  async dump(): Promise<AxObservation> {
    return this.observation;
  }
  async runningApps(): Promise<string[]> {
    return [];
  }
  async activate(_app: string, _launch: boolean): Promise<ActivateOutcome> {
    return "not-running";
  }
  async locate(): Promise<{ handle: number; bounds: Rect } | null> {
    return null;
  }
  async moveTo(_p: Vec2): Promise<void> {}
  async click(_p: Vec2, _b: number, _c: number): Promise<void> {}
  async dragPath(): Promise<void> {}
  async scroll(): Promise<void> {}
  async key(): Promise<void> {}
}

const tree = [{ role: "Button", label: "Send", x: 0, y: 0, w: 10, h: 10 }];

describe("surfaceOriginOf", () => {
  /**
   * A MENU IS A WINDOW TO THE OS AND A CHILD TO ACCESSIBILITY, and the geometry
   * check has to use the one the anchor was recorded against. Frames below are
   * from a real recording: Calculator's window, its context menu, and "Copy".
   */
  const window_ = { role: "Window", label: "Calculator", x: 133, y: 242, w: 230, h: 408 };
  const menu = { role: "Menu", x: 336, y: 335, w: 86, h: 58, parent: 0 };
  const item = { role: "MenuItem", label: "Copy", x: 336, y: 340, w: 86, h: 24, parent: 1 };
  const tree = [window_, menu, item];

  it("returns the MENU for an item inside it, not the window it hangs under", async () => {
    const { surfaceOriginOf } = await import("../src/replay/observe.js");
    expect(surfaceOriginOf(tree, 2)).toEqual({ x: 336, y: 335 });
  });

  it("returns the window for an element that is not in a menu", async () => {
    const { surfaceOriginOf } = await import("../src/replay/observe.js");
    const button = { role: "Button", label: "7", x: 150, y: 300, w: 48, h: 48, parent: 0 };
    expect(surfaceOriginOf([window_, button], 1)).toEqual({ x: 133, y: 242 });
  });

  it("returns a surface element's OWN origin when asked about itself", async () => {
    const { surfaceOriginOf } = await import("../src/replay/observe.js");
    expect(surfaceOriginOf(tree, 1)).toEqual({ x: 336, y: 335 });
  });

  it("is undefined when nothing in the chain is a surface", async () => {
    // Absent rather than invented: the caller's own `windowOrigin` then stands,
    // which is exactly the behaviour that preceded this.
    const { surfaceOriginOf } = await import("../src/replay/observe.js");
    const orphan = { role: "Button", label: "Send", x: 0, y: 0, w: 10, h: 10 };
    expect(surfaceOriginOf([orphan], 0)).toBeUndefined();
  });

  it("terminates on a malformed parent cycle rather than hanging a replay", async () => {
    const { surfaceOriginOf } = await import("../src/replay/observe.js");
    const a = { role: "Group", x: 0, y: 0, w: 10, h: 10, parent: 1 };
    const b = { role: "Group", x: 0, y: 0, w: 10, h: 10, parent: 0 };
    expect(surfaceOriginOf([a, b], 0)).toBeUndefined();
  });
});

describe("observe", () => {
  it("emits an app predicate when the actuator reports the frontmost app", async () => {
    const p = await observe(new StubActuator({ elements: tree, app: "TextEdit" }));
    expect(p.map(predicateKey)).toContain('app(app="TextEdit")');
  });

  /**
   * The title still travels with the observation — it is one of the two facts
   * that are not in the tree, and `AxObservation` bundles it deliberately — but
   * it is no longer part of node identity. A title is which document or page you
   * have open, not which state you are in, and as a predicate it stopped any
   * node from being located outside the exact file it was recorded against.
   */
  it("does NOT turn the reported window title into a predicate", async () => {
    const p = await observe(
      new StubActuator({ elements: tree, app: "TextEdit", windowTitle: "Untitled" }),
    );
    expect(p.map(predicateKey)).not.toContain('window(title="Untitled")');
    expect(p.map(predicateKey)).toContain('app(app="TextEdit")');
  });

  it("still yields the AX predicates alongside them", async () => {
    const p = await observe(new StubActuator({ elements: tree, app: "TextEdit" }));
    expect(p.map(predicateKey)).toContain('ax_exists(label="Send",role="Button")');
  });

  it("degrades to AX predicates alone when the actuator reports neither", async () => {
    const p = await observe(new StubActuator({ elements: tree }));
    expect(p.some((x) => x.kind === "app")).toBe(false);
    expect(p.some((x) => x.kind === "window")).toBe(false);
    expect(p.some((x) => x.kind === "ax_exists")).toBe(true);
  });

  it("emits a url predicate when the actuator reports the page URL", async () => {
    const p = await observe(
      new StubActuator({ elements: tree, app: "Google Chrome", url: "https://github.com/a/b" }),
    );
    // `urlPrefix` keeps path segments — the scope is the SITE plus what of the
    // path is not id-like, not the bare host.
    expect(p.map(predicateKey)).toContain('url(prefix="github.com/a/b")');
  });

  it("emits no url predicate for a page that names no site", async () => {
    // `urlPrefix` returns undefined rather than a junk identity, and that
    // decision stays in `extractPredicates` — `observe` passes the raw string.
    const p = await observe(
      new StubActuator({ elements: tree, app: "Google Chrome", url: "about:blank" }),
    );
    expect(p.some((x) => x.kind === "url")).toBe(false);
  });

  /**
   * The measured defect this field exists to fix.
   *
   * `lift` emits a `url` predicate for every browser node, `verifyNode` requires
   * expected ⊆ observed, and nothing on the replay side could ever produce one:
   * `ax-dump` read `AXURL` and emitted it, the sidecar dropped it, and
   * `AxObservation` had no field to carry it. Every browser node therefore
   * failed verification, and since `locateNode` requires a satisfied verify,
   * none was ever a locate candidate either — live or stored, with nothing
   * failing anywhere to say so.
   */
  it("makes a node carrying a url predicate verifiable, and unverifiable without it", async () => {
    const { verifyNode } = await import("../src/replay/verify.js");
    const expected = [
      { kind: "app" as const, args: { app: "Google Chrome" }, reach: "achievable" as const },
      { kind: "url" as const, args: { prefix: "github.com/a/b" }, reach: "achievable" as const },
    ];
    const withUrl = await observe(
      new StubActuator({ elements: tree, app: "Google Chrome", url: "https://github.com/a/b" }),
    );
    expect(verifyNode(expected, withUrl).satisfied).toBe(true);

    const without = await observe(new StubActuator({ elements: tree, app: "Google Chrome" }));
    expect(verifyNode(expected, without).satisfied).toBe(false);
  });

  // A node carrying an app predicate was previously unverifiable in every state,
  // because nothing on the replay side could produce that predicate at all.
  it("makes a node carrying an app predicate verifiable", async () => {
    const { verifyNode } = await import("../src/replay/verify.js");
    const expected = [
      { kind: "app" as const, args: { app: "TextEdit" }, reach: "achievable" as const },
      {
        kind: "ax_exists" as const,
        args: { role: "Button", label: "Send" },
        reach: "achievable" as const,
      },
    ];
    const observed = await observe(new StubActuator({ elements: tree, app: "TextEdit" }));
    expect(verifyNode(expected, observed).satisfied).toBe(true);
  });
});
