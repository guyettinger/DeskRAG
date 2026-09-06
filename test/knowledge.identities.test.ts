import { describe, expect, it } from "vitest";
import { foldByIdentity, type Observation } from "../src/knowledge/identity.js";
import {
  DISPLAY_TOPOLOGY,
  FOCUSED_APP,
  FOCUSED_WINDOW,
  KEYBOARD_LAYOUT,
  VISITED_PAGE,
  type DisplayTopologyPayload,
  type FocusPayload,
  type WindowPayload,
} from "../src/knowledge/identities.js";

const obs = <R>(value: R, sessionId: string): Observation<R> => ({
  value,
  source: { sessionId, tMono: 0 },
});

/** The 1920x1080@2 primary, under the `id` macOS re-minted that session. */
const solo = (id: string): DisplayTopologyPayload => ({
  displays: [{ id, x: 0, y: 0, w: 1920, h: 1080, scale: 2, primary: true }],
});

/** The one genuine second configuration: docked laptop plus a 4K external. */
const docked: DisplayTopologyPayload = {
  displays: [
    { id: "1", x: 0, y: 0, w: 1728, h: 1117, scale: 2, primary: true },
    { id: "5", x: -3840, y: -797, w: 3840, h: 2160, scale: 1, primary: false },
  ],
};

describe("DISPLAY_TOPOLOGY", () => {
  it("folds the library's seven re-minted ids into one configuration", () => {
    const ids = ["180", "185", "206", "206", "206", "206", "219", "247", "247", "296", "297"];
    const f = foldByIdentity(
      "display_change",
      ids.map((id, i) => obs(solo(id), `s${i}`)),
      DISPLAY_TOPOLOGY.identity,
    );
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.sources).toHaveLength(11);
    expect(f.values[0]!.variants).toHaveLength(7);
  });

  it("keeps the docked configuration apart, because geometry discriminates", () => {
    const f = foldByIdentity(
      "display_change",
      [obs(solo("180"), "s1"), obs(docked, "s2")],
      DISPLAY_TOPOLOGY.identity,
    );
    expect(f.values).toHaveLength(2);
  });

  it("is insensitive to the order the OS reports displays in", () => {
    const reversed: DisplayTopologyPayload = {
      displays: [...(docked.displays as unknown[])].reverse(),
    };
    const f = foldByIdentity(
      "display_change",
      [obs(docked, "s1"), obs(reversed, "s2")],
      DISPLAY_TOPOLOGY.identity,
    );
    expect(f.values).toHaveLength(1);
  });

  it("discriminates on scale, which is geometry and not a decoy", () => {
    const half: DisplayTopologyPayload = {
      displays: [{ id: "180", x: 0, y: 0, w: 1920, h: 1080, scale: 1, primary: true }],
    };
    const f = foldByIdentity(
      "display_change",
      [obs(solo("180"), "s1"), obs(half, "s2")],
      DISPLAY_TOPOLOGY.identity,
    );
    expect(f.values).toHaveLength(2);
  });

  it("refuses an empty topology, which is a failed display source and not a configuration", () => {
    expect(DISPLAY_TOPOLOGY.identity({ displays: [] })).toBeNull();
  });

  it("coerces with the function that wrote the row, so a malformed panel cannot fold", () => {
    // `compareGeometry` subtracts: one missing field makes the comparator return
    // NaN and the sorted canonical form implementation-defined, which is a
    // NON-DETERMINISTIC identity — the one failure this module exists to prevent.
    // `coerceDisplays` is the writer's own check, run again on the way back in.
    const malformed: DisplayTopologyPayload = {
      displays: [
        { id: "1", x: 0, y: 0, w: 1920, h: 1080, scale: 2, primary: true },
        { id: "2", x: 0, w: 2560, h: 1440, scale: 1 },
      ],
    };
    expect(DISPLAY_TOPOLOGY.identity(malformed)).toEqual([[0, 0, 1920, 1080, 2, true]]);
  });

  it("refuses a payload that is not a display list at all, rather than reading zero screens", () => {
    expect(DISPLAY_TOPOLOGY.identity({ displays: undefined })).toBeNull();
    expect(DISPLAY_TOPOLOGY.identity({ displays: "left" })).toBeNull();
    expect(DISPLAY_TOPOLOGY.identity({ displays: [{ id: "1" }] })).toBeNull();
  });

  it("is coexisting: a laptop is docked some days and not others", () => {
    expect(DISPLAY_TOPOLOGY.exclusivity).toBe("coexisting");
  });
});

describe("FOCUSED_APP", () => {
  it("folds every window of one app, whatever windowId, pid and bounds say", () => {
    /** The real payload, decoys included — `FocusPayload` names only what is read. */
    interface RealFocus extends FocusPayload {
      windowId: number;
      bounds: { x: number };
    }
    const calc = (windowId: number, x: number): RealFocus => ({
      app: "Calculator",
      bundleId: "com.apple.calculator",
      windowId,
      bounds: { x },
    });
    const f = foldByIdentity(
      "focus_change",
      [obs(calc(398911, 150), "s1"), obs(calc(385609, 133), "s2"), obs(calc(379910, 118), "s3")],
      FOCUSED_APP.identity,
    );
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.value).toBe("com.apple.calculator");
    expect(f.values[0]!.variants).toHaveLength(3);
  });

  it("keeps two apps apart", () => {
    const f = foldByIdentity(
      "focus_change",
      [
        obs({ app: "Calculator", bundleId: "com.apple.calculator" }, "s1"),
        obs({ app: "TextEdit", bundleId: "com.apple.TextEdit" }, "s2"),
      ],
      FOCUSED_APP.identity,
    );
    expect(f.values).toHaveLength(2);
  });

  it("falls back to the app name when bundleId is absent", () => {
    expect(FOCUSED_APP.identity({ app: "Calculator" })).toBe("Calculator");
  });

  it("treats an EMPTY bundleId as absent, the way both AX sidecars do", () => {
    expect(FOCUSED_APP.identity({ app: "Calculator", bundleId: "" })).toBe("Calculator");
  });

  it("refuses a payload that names no application at all", () => {
    expect(FOCUSED_APP.identity({})).toBeNull();
    expect(FOCUSED_APP.identity({ app: "", bundleId: "" })).toBeNull();
  });
});

describe("FOCUSED_WINDOW", () => {
  const win = (over: Partial<WindowPayload>): WindowPayload => ({
    app: "TextEdit",
    bundleId: "com.apple.TextEdit",
    title: "Untitled — Edited",
    ...over,
  });

  it("separates two windows of one application, which FOCUSED_APP folds together", () => {
    // THE MEASUREMENT THIS DECLARATION EXISTS FOR: 63 distinct payloads fold to
    // 7 by bundle id and 28 by (bundleId, title). Two answers to two questions.
    const observations = [
      obs(win({ title: "report.md — Edited" }), "s1"),
      obs(win({ title: "notes.md" }), "s2"),
    ];
    expect(
      foldByIdentity("focus_change", observations, FOCUSED_APP.identity).values,
    ).toHaveLength(1);
    expect(
      foldByIdentity("focus_change", observations, FOCUSED_WINDOW.identity).values,
    ).toHaveLength(2);
  });

  it("still drops windowId, pid and the bounds that DRIFT", () => {
    // The Calculator's main window was observed at (150,231), (133,242) and
    // (118,253) across three recordings of the same work.
    const a = { ...win({}), windowId: 41, pid: 900, bounds: { x: 150, y: 231 } };
    const b = { ...win({}), windowId: 77, pid: 901, bounds: { x: 118, y: 253 } };
    const f = foldByIdentity("focus_change", [obs(a, "s1"), obs(b, "s2")], FOCUSED_WINDOW.identity);
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.variants).toHaveLength(2);
  });

  it("refuses a window with no title, rather than folding it onto a titled one", () => {
    expect(FOCUSED_WINDOW.identity({ app: "TextEdit", bundleId: "com.apple.TextEdit" })).toBeNull();
    expect(FOCUSED_WINDOW.identity(win({ title: "" }))).toBeNull();
    // BOTH or nothing: a title under no application names nothing either.
    expect(FOCUSED_WINDOW.identity({ title: "Untitled" })).toBeNull();
  });

  it("falls back to the app name when bundleId is absent, as FOCUSED_APP does", () => {
    expect(FOCUSED_WINDOW.identity({ app: "TextEdit", title: "Untitled — Edited" })).toEqual([
      "TextEdit",
      "Untitled — Edited",
    ]);
  });

  it("is a SECOND fact over one event kind, which is what `id` is for", () => {
    expect(FOCUSED_WINDOW.kind).toBe(FOCUSED_APP.kind);
    expect(FOCUSED_WINDOW.id).not.toBe(FOCUSED_APP.id);
  });

  it("is coexisting and focused-app, on FOCUSED_APP's reasoning exactly", () => {
    expect(FOCUSED_WINDOW.exclusivity).toBe("coexisting");
    expect(FOCUSED_WINDOW.attribution).toBe("focused-app");
  });
});

/**
 * The two axes are not independent on the declarations that exist, and the file
 * header says so rather than leaving it to be rediscovered.
 */
describe("environment or activity", () => {
  const ALL = [DISPLAY_TOPOLOGY, FOCUSED_APP, FOCUSED_WINDOW, VISITED_PAGE, KEYBOARD_LAYOUT];

  it("gives every declaration a distinct id", () => {
    expect(new Set(ALL.map((d) => d.id)).size).toBe(ALL.length);
  });

  it("makes no focused-app fact exclusive — an activity fact cannot supersede", () => {
    // Using Calculator today does not stop TextEdit having been used. The
    // consequence is that only an AMBIENT fact can ever return a current value.
    for (const d of ALL) {
      if (d.attribution === "focused-app") expect(d.exclusivity, d.id).toBe("coexisting");
    }
    expect(ALL.filter((d) => d.exclusivity === "exclusive").map((d) => d.id)).toEqual([
      "keyboard_layout",
    ]);
  });
});

describe("VISITED_PAGE", () => {
  it("merges the one pair the real library merges", () => {
    const f = foldByIdentity(
      "url_change",
      [
        obs("https://www.linkedin.com/notifications/", "s1"),
        obs(
          "https://www.linkedin.com/notifications/?skipRedirect=true&lipi=urn%3Ali%3Apage%3Ad_flagship3_feed%3BRBVWEc2ZR4eqJ1zJdf3Glw%3D%3D",
          "s2",
        ),
      ],
      VISITED_PAGE.identity,
    );
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.value).toBe("linkedin.com/notifications");
    expect(f.values[0]!.variants).toHaveLength(2);
  });

  it("keeps two pages of one site apart, because the grain is the site path", () => {
    const f = foldByIdentity(
      "url_change",
      [
        obs("https://inman-perk-coffee.vercel.app/menu", "s1"),
        obs("https://inman-perk-coffee.vercel.app/about", "s2"),
      ],
      VISITED_PAGE.identity,
    );
    expect(f.values).toHaveLength(2);
  });

  it("refuses a URL that names no site, rather than inventing a value for it", () => {
    expect(VISITED_PAGE.identity("chrome://new-tab-page/")).toBeNull();
  });
});
