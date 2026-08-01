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
