import { describe, expect, it } from "vitest";
import { coerceDisplays } from "../src/capture/env/parse.js";

describe("coerceDisplays", () => {
  it("accepts a well-formed payload", () => {
    expect(
      coerceDisplays([
        { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true },
        { id: "2", x: 2560, y: 100, w: 1920, h: 1080, scale: 1, primary: false },
      ]),
    ).toEqual([
      { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true },
      { id: "2", x: 2560, y: 100, w: 1920, h: 1080, scale: 1, primary: false },
    ]);
  });

  it("drops entries missing a field rather than trusting them", () => {
    expect(coerceDisplays([{ id: "1", x: 0, y: 0, w: 100 }])).toEqual([]);
    expect(coerceDisplays([{ x: 0, y: 0, w: 1, h: 1, scale: 1, primary: true }])).toEqual([]);
  });

  it("drops non-finite numbers", () => {
    expect(
      coerceDisplays([{ id: "1", x: 0, y: 0, w: Infinity, h: 1, scale: 1, primary: true }]),
    ).toEqual([]);
  });

  it("returns [] for non-arrays and junk", () => {
    for (const junk of [null, undefined, {}, "nope", 42]) {
      expect(coerceDisplays(junk)).toEqual([]);
    }
  });

  it("defaults primary to false when absent but keeps the entry", () => {
    expect(coerceDisplays([{ id: "1", x: 0, y: 0, w: 10, h: 10, scale: 1 }])).toEqual([
      { id: "1", x: 0, y: 0, w: 10, h: 10, scale: 1, primary: false },
    ]);
  });
});
