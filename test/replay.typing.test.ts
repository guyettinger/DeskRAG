import { describe, expect, it } from "vitest";
import { reverseKeymap, strokesFor } from "../src/replay/typing.js";
import type { Keymap } from "../src/capture/env/types.js";

// The same shape `trace.lift.test.ts` uses for keycode -> char, read backwards.
const us: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: {
    0: ["a", "A", "å", "Å"],
    1: ["s", "S", "ß", "Í"],
    36: ["\r", "\r", "\r", "\r"],
    49: [" ", " ", " ", " "],
  },
};

describe("reverseKeymap", () => {
  it("maps the plain column with no modifiers", () => {
    expect(reverseKeymap(us).get("a")).toEqual({ keycode: 0, modifiers: [] });
  });

  it("maps the shift column with a shift modifier", () => {
    expect(reverseKeymap(us).get("A")).toEqual({ keycode: 0, modifiers: ["shift"] });
  });

  it("maps the alt and alt-shift columns", () => {
    const rev = reverseKeymap(us);
    expect(rev.get("å")).toEqual({ keycode: 0, modifiers: ["alt"] });
    expect(rev.get("Å")).toEqual({ keycode: 0, modifiers: ["alt", "shift"] });
  });

  it("prefers the cheapest modifier combination when a char repeats", () => {
    // Return appears in all four columns; plain must win.
    expect(reverseKeymap(us).get("\r")).toEqual({ keycode: 36, modifiers: [] });
  });
});

describe("strokesFor", () => {
  it("round-trips text through the layout", () => {
    expect(strokesFor("aA s", us)).toEqual([
      { keycode: 0, modifiers: [] },
      { keycode: 0, modifiers: ["shift"] },
      { keycode: 49, modifiers: [] },
      { keycode: 1, modifiers: [] },
    ]);
  });

  it("returns null when any character is unmappable, rather than dropping it", () => {
    // Silently skipping a char would type the wrong string, which is worse than
    // refusing: the caller turns null into a blocker.
    expect(strokesFor("a€b", us)).toBeNull();
  });

  it("returns an empty stroke list for empty text", () => {
    expect(strokesFor("", us)).toEqual([]);
  });
});
