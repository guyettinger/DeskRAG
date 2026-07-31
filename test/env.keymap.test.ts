import { describe, expect, it } from "vitest";
import { macKeycodeFor, resolveChar } from "../src/capture/env/keymap.js";
import type { Keymap } from "../src/capture/env/types.js";

/** vk -> [plain, shift, alt, altShift]. 0 = A, 1 = S, 49 = Space, 18 = "1". */
const us: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: {
    0: ["a", "A", "å", "Å"],
    1: ["s", "S", "ß", "Í"],
    18: ["1", "!", "¡", "⁄"],
    49: [" ", " ", " ", " "],
  },
};

/** Dvorak: the same physical keys, different characters. */
const dvorak: Keymap = {
  layoutId: "com.apple.keylayout.Dvorak",
  entries: { 0: ["a", "A", "å", "Å"], 1: ["o", "O", "ø", "Ø"] },
};

describe("macKeycodeFor", () => {
  it("maps the text-entry core from scancode to virtual keycode", () => {
    expect(macKeycodeFor(30)).toBe(0); // A
    expect(macKeycodeFor(31)).toBe(1); // S
    expect(macKeycodeFor(57)).toBe(49); // Space
    expect(macKeycodeFor(2)).toBe(18); // 1
  });

  it("returns undefined for keys outside the table", () => {
    expect(macKeycodeFor(99999)).toBeUndefined();
  });

  it("maps the WHOLE text-entry core correctly", () => {
    // Verified against a live `ax-dump --keymap` on a US layout: every one of
    // these resolved to the expected character. Frozen here so a typo in the
    // table is caught without needing swiftc or a particular keyboard — a wrong
    // entry silently produces wrong characters, which is the exact failure this
    // whole design exists to avoid.
    const expected: Record<number, number> = {
      30: 0, 48: 11, 46: 8, 32: 2, 18: 14, 33: 3, 34: 5, 35: 4, 23: 34, 36: 38,
      37: 40, 38: 37, 50: 46, 49: 45, 24: 31, 25: 35, 16: 12, 19: 15, 31: 1, 20: 17,
      22: 32, 47: 9, 17: 13, 45: 7, 21: 16, 44: 6,
      2: 18, 3: 19, 4: 20, 5: 21, 6: 23, 7: 22, 8: 26, 9: 28, 10: 25, 11: 29,
      12: 27, 13: 24, 26: 33, 27: 30, 43: 42, 39: 41, 40: 39, 41: 50, 51: 43,
      52: 47, 53: 44, 57: 49,
    };
    for (const [sc, vk] of Object.entries(expected)) {
      expect(macKeycodeFor(Number(sc)), `scancode ${sc}`).toBe(vk);
    }
    expect(Object.keys(expected)).toHaveLength(48);
  });

  it("is injective — two scancodes must never share a virtual keycode", () => {
    const seen = new Map<number, number>();
    for (let sc = 0; sc < 4096; sc++) {
      const vk = macKeycodeFor(sc);
      if (vk === undefined) continue;
      expect(seen.has(vk), `vk ${vk} claimed by ${seen.get(vk)} and ${sc}`).toBe(false);
      seen.set(vk, sc);
    }
  });
});

describe("resolveChar", () => {
  it("resolves an unmodified key", () => {
    expect(resolveChar(us, 30, [])).toEqual({ char: "a", modifiers: [] });
  });

  it("CONSUMES shift into the character — a capital is text, not a chord", () => {
    expect(resolveChar(us, 30, ["shift"])).toEqual({ char: "A", modifiers: [] });
    expect(resolveChar(us, 2, ["shift"])).toEqual({ char: "!", modifiers: [] });
  });

  it("consumes alt, and shift+alt together", () => {
    expect(resolveChar(us, 30, ["alt"])).toEqual({ char: "å", modifiers: [] });
    expect(resolveChar(us, 30, ["alt", "shift"])).toEqual({ char: "Å", modifiers: [] });
  });

  it("produces NO character and keeps every modifier when cmd is held", () => {
    expect(resolveChar(us, 31, ["cmd"])).toEqual({ modifiers: ["cmd"] });
    expect(resolveChar(us, 31, ["cmd", "shift"])).toEqual({ modifiers: ["cmd", "shift"] });
  });

  it("keeps alt alongside cmd — alt was never consumed", () => {
    expect(resolveChar(us, 31, ["alt", "cmd"])).toEqual({ modifiers: ["alt", "cmd"] });
  });

  it("treats ctrl like cmd", () => {
    expect(resolveChar(us, 30, ["ctrl"])).toEqual({ modifiers: ["ctrl"] });
  });

  it("returns modifiers sorted, so a chord keys identically however it arrived", () => {
    expect(resolveChar(us, 31, ["shift", "cmd"]).modifiers).toEqual(["cmd", "shift"]);
  });

  it("resolves the same physical key differently per layout", () => {
    expect(resolveChar(us, 31, []).char).toBe("s");
    expect(resolveChar(dvorak, 31, []).char).toBe("o");
  });

  it("yields no character for an unmapped scancode", () => {
    expect(resolveChar(us, 99999, [])).toEqual({ modifiers: [] });
  });

  it("yields no character when the layout has no entry for the key", () => {
    expect(resolveChar(dvorak, 57, [])).toEqual({ modifiers: [] });
  });

  it("yields no character when the column is empty (a non-text key)", () => {
    const km: Keymap = { layoutId: "x", entries: { 0: ["", "", "", ""] } };
    expect(resolveChar(km, 30, [])).toEqual({ modifiers: [] });
  });
});
