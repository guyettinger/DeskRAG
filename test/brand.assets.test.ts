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

import { renderLottie } from "../scripts/brand/emit-lottie.js";
import { ghostBodyBezier } from "../scripts/brand/geometry.js";

interface LottieShapeKeyframe {
  t: number;
  s: [{ v: number[][]; i: number[][]; o: number[][]; c: boolean }];
}

describe("ghost Lottie", () => {
  it("committed Lottie matches freshly rendered output", () => {
    expect(read("deskrag-ghost.lottie.json")).toBe(renderLottie());
  });

  it("is a valid bodymovin document over the shared 3s / 60fps loop", () => {
    const doc = JSON.parse(renderLottie());
    expect(doc.v).toMatch(/^5\./);
    expect(doc.fr).toBe(60);
    expect(doc.ip).toBe(0);
    expect(doc.op).toBe(180);
    expect(doc.w).toBe(256);
    expect(doc.h).toBe(256);
  });

  it("stacks ghost over shadow over desk", () => {
    const doc = JSON.parse(renderLottie());
    // Lottie renders earlier layers on top.
    expect(doc.layers.map((l: { nm: string }) => l.nm)).toEqual([
      "ghost",
      "shadow",
      "desk",
    ]);
  });

  it("morphs the hem with a constant vertex count across keyframes", () => {
    // Mismatched vertex counts make Lottie tween into garbage. This is the
    // single most likely way a hand-rolled Lottie breaks.
    const doc = JSON.parse(renderLottie());
    const ghost = doc.layers[0];
    const body = ghost.shapes[0].it.find((x: { ty: string }) => x.ty === "sh");
    const keys = body.ks.k as LottieShapeKeyframe[];
    expect(keys.length).toBeGreaterThan(1);
    const expected = ghostBodyBezier(0).v.length;
    for (const k of keys) {
      expect(k.s[0].v).toHaveLength(expected);
      expect(k.s[0].i).toHaveLength(expected);
      expect(k.s[0].o).toHaveLength(expected);
      expect(k.s[0].c).toBe(true);
    }
  });

  it("terminates every shape group with a ty:'tr' transform", () => {
    // Group transforms carry ty:"tr"; layer transforms must not. Confusing the
    // two makes lottie-web render an empty canvas with no console error.
    const doc = JSON.parse(renderLottie());
    for (const l of doc.layers as { ks: { ty?: string }; shapes: { it: { ty: string }[] }[] }[]) {
      expect(l.ks.ty).toBeUndefined();
      for (const group of l.shapes) {
        expect(group.it[group.it.length - 1]!.ty).toBe("tr");
      }
    }
  });

  it("bobs the ghost layer's position", () => {
    const doc = JSON.parse(renderLottie());
    expect(doc.layers[0].ks.p.a).toBe(1);
    expect(doc.layers[0].ks.p.k.length).toBeGreaterThan(1);
  });

  it("contains no NaN — JSON.stringify turns those into null and lottie hangs", () => {
    expect(renderLottie()).not.toMatch(/null/);
  });
});
