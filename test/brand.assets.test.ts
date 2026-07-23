import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetsDir, renderLogo, renderMark } from "../scripts/brand/emit-static.js";

const read = (name: string): string => readFileSync(join(assetsDir, name), "utf8");

describe("static brand assets", () => {
  it("committed mark matches freshly rendered output", () => {
    // The drift guard. Hand-editing a generated asset fails here, which is what
    // keeps geometry.ts the single source of truth rather than merely the first.
    expect(read("deskrag-mark.svg")).toBe(renderMark());
  });

  it("committed logo matches freshly rendered output", () => {
    expect(read("deskrag-logo.svg")).toBe(renderLogo());
  });

  it("uses no SVG filters — sharp/librsvg renders them inconsistently", () => {
    expect(renderMark()).not.toMatch(/<filter|feGaussianBlur/);
    expect(renderLogo()).not.toMatch(/<filter|feGaussianBlur/);
  });

  it("is a square 256 viewBox with the desk and the ghost present", () => {
    const svg = renderMark();
    expect(svg).toContain('viewBox="0 0 256 256"');
    expect(svg).toContain("#A18AF5"); // ghost gradient foot
    expect(svg).toContain("#8A93A3"); // desk bar
  });
});
