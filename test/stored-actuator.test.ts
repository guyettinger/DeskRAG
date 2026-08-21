import { describe, expect, it } from "vitest";
import { StoredActuator, StoredWorldError, locateIn } from "../app/src/main/stored-actuator.js";
import { axPathOf } from "../src/trace/anchors.js";
import type { AxObservation } from "../src/replay/types.js";
import type { UIElement } from "../src/trace/types.js";

const el = (over: Partial<UIElement> & { role: string }): UIElement => ({
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  ...over,
});

const tree: UIElement[] = [
  el({ role: "Window", label: "Untitled" }),
  el({ role: "Button", label: "Send", identifier: "send-btn", parent: 0, x: 5, y: 6, w: 20, h: 8 }),
  el({ role: "Button", label: "Cancel", parent: 0, x: 30, y: 6 }),
];

const moments: AxObservation[] = [
  { elements: tree, app: "TextEdit" },
  { elements: [el({ role: "Window", label: "Second" })], app: "Finder" },
];

describe("StoredActuator — reading a recorded world", () => {
  it("dumps the moment at the cursor", async () => {
    const a = new StoredActuator(moments);
    expect((await a.dump()).app).toBe("TextEdit");
    expect(a.advance()).toBe(true);
    expect((await a.dump()).app).toBe("Finder");
  });

  it("advance() reports the end of the recording rather than throwing", async () => {
    const a = new StoredActuator(moments);
    a.advance();
    expect(a.advance()).toBe(false);
    expect(a.at).toBe(1);
  });

  it("seek clamps — running past the end is an ordinary outcome", () => {
    const a = new StoredActuator(moments);
    a.seek(99);
    expect(a.at).toBe(1);
    a.seek(-4);
    expect(a.at).toBe(0);
  });

  it("dumps an empty tree rather than throwing when there are no moments", async () => {
    expect((await new StoredActuator([]).dump()).elements).toEqual([]);
  });

  it("reports only the apps the RECORDING saw", async () => {
    // Never the live desktop: a plan that resolved against an app which happens
    // to be open here, and was never recorded, is not a transfer.
    expect(await new StoredActuator(moments).runningApps()).toEqual(["TextEdit", "Finder"]);
  });
});

describe("StoredActuator — every mutator refuses", () => {
  // Not the safety story (the read-only proxy is); this says something narrower
  // and more useful — a past moment cannot be changed, so silently accepting a
  // click would let a caller believe it advanced a state it did not.
  const a = new StoredActuator(moments);

  it.each([
    ["activate", () => a.activate("TextEdit", false)],
    ["moveTo", () => a.moveTo({ x: 0, y: 0 })],
    ["click", () => a.click({ x: 0, y: 0 }, 0, 1)],
    ["dragPath", () => a.dragPath()],
    ["scroll", () => a.scroll()],
    ["key", () => a.key()],
  ])("%s throws StoredWorldError", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(StoredWorldError);
  });

  it("names the method it refused, so it reads as a refusal not a fault", async () => {
    await expect(a.click({ x: 0, y: 0 }, 0, 1)).rejects.toThrow(/cannot click\(\)/);
  });
});

describe("locateIn — ax-exec's ladder over a stored tree", () => {
  it("resolves by identifier first", () => {
    expect(locateIn(tree, { role: "Button", identifier: "send-btn" })).toBe(1);
  });

  it("does NOT fall through when an identifier misses", () => {
    // Each rung is exclusive in `ax-exec`, and a fallthrough here would resolve
    // descriptors the live executor would refuse — a transfer test reporting a
    // success the real thing could not reproduce.
    expect(locateIn(tree, { role: "Button", identifier: "gone", label: "Send" })).toBeUndefined();
  });

  it("resolves by path, using the same rule that recorded it", () => {
    const path = axPathOf(tree, 2);
    expect(locateIn(tree, { role: "Button", path })).toBe(2);
  });

  it("does not fall through when a path misses", () => {
    expect(
      locateIn(tree, { role: "Button", path: "Window[0]>Button[9]", label: "Send" }),
    ).toBeUndefined();
  });

  it("resolves by label and role together", () => {
    expect(locateIn(tree, { role: "Button", label: "Cancel" })).toBe(2);
    expect(locateIn(tree, { role: "TextField", label: "Cancel" })).toBeUndefined();
  });

  it("returns undefined for a descriptor carrying nothing to match on", () => {
    expect(locateIn(tree, { role: "Button" })).toBeUndefined();
  });

  it("locate() returns the element's real bounds", async () => {
    const hit = await new StoredActuator(moments).locate({
      role: "Button",
      identifier: "send-btn",
    });
    // The surface comes along: this button's parent IS the Window, so the two
    // origins agree and geometry is judged in window space.
    expect(hit).toEqual({
      handle: 1,
      bounds: { x: 5, y: 6, w: 20, h: 8 },
      surfaceOrigin: { x: 0, y: 0 },
    });
  });

  it("locate() reports the SURFACE the element sits in", async () => {
    // A menu item's menu, not the app window it hangs under. Without this the
    // recorded window-relative box and the live one are measured from two
    // different origins, agreement collapses to zero, and every rung is vetoed
    // having FOUND the element — measured at 17/19 anchors, 18/19 with it.
    const win = { role: "Window", label: "Calculator", x: 133, y: 242, w: 230, h: 408 };
    const menu = { role: "Menu", x: 336, y: 335, w: 86, h: 58, parent: 0 };
    const copy = {
      role: "MenuItem",
      label: "Copy",
      identifier: "_NS:23",
      x: 336,
      y: 340,
      w: 86,
      h: 24,
      parent: 1,
    };
    const a = new StoredActuator([{ elements: [win, menu, copy], app: "Calculator" }]);
    expect(await a.locate({ role: "MenuItem", identifier: "_NS:23" })).toEqual({
      handle: 2,
      bounds: { x: 336, y: 340, w: 86, h: 24 },
      surfaceOrigin: { x: 336, y: 335 },
    });
  });

  it("omits surfaceOrigin when the tree has no surface at all", async () => {
    const a = new StoredActuator([{ elements: [el({ role: "Button", label: "Send" })] }]);
    const hit = await a.locate({ role: "Button", label: "Send" });
    expect(hit).not.toBeNull();
    expect(hit).not.toHaveProperty("surfaceOrigin");
  });

  it("locate() resolves against the CURRENT moment only", async () => {
    const a = new StoredActuator(moments);
    a.advance();
    expect(await a.locate({ role: "Button", identifier: "send-btn" })).toBeNull();
  });
});
