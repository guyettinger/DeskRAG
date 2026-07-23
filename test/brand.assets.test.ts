import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetsDir, renderLogo, renderMark } from "../scripts/brand/emit-static.js";
import { renderAnimatedSvg } from "../scripts/brand/emit-svg.js";
import { FPS, FRAMES, KEYFRAMES } from "../scripts/brand/geometry.js";

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

describe("animated ghost SVG", () => {
  it("committed animated SVG matches freshly rendered output", () => {
    expect(read("deskrag-ghost.svg")).toBe(renderAnimatedSvg());
  });

  it("animates the hem with SMIL, one value per keyframe", () => {
    const svg = renderAnimatedSvg();
    expect(svg).toContain('attributeName="d"');
    expect(svg).toContain('repeatCount="indefinite"');
    const values = /values="([^"]+)"/.exec(svg);
    expect(values).not.toBeNull();
    expect(values![1]!.split(";")).toHaveLength(KEYFRAMES.length);
  });

  it("loops over the same duration as the Lottie", () => {
    expect(renderAnimatedSvg()).toContain(`dur="${FRAMES / FPS}s"`);
  });

  it("bobs the ghost with CSS rather than a transform attribute clash", () => {
    // A CSS transform would override a transform attribute on the same element,
    // so the bob wrapper must be a separate group from the GHOST_FIT group.
    const svg = renderAnimatedSvg();
    expect(svg).toContain("@keyframes dr-bob");
    expect(svg).toContain('class="dr-bob"');
  });

  it("uses no SVG filters", () => {
    expect(renderAnimatedSvg()).not.toMatch(/<filter|feGaussianBlur/);
  });
});
