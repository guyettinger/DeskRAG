import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetsDir, renderLogo, renderMark } from "../scripts/brand/emit-static.js";
import { renderAnimatedSvg } from "../scripts/brand/emit-svg.js";
import { FPS, FRAMES, KEYFRAMES, palette } from "../scripts/brand/geometry.js";

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
    // Located by group name, not array position — paint order (see the
    // "paints the body last" test below) puts ghost-group at a specific
    // index for a reason unrelated to this assertion, and that index must
    // stay free to move without breaking vertex-count coverage here.
    const ghostGroup = ghost.shapes.find((g: { nm: string }) => g.nm === "ghost-group");
    const body = ghostGroup.it.find((x: { ty: string }) => x.ty === "sh");
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

  it("paints the opaque body group last so it doesn't cover the face", () => {
    // Empirically verified in lottie-web: unlike SVG, Lottie paints EARLIER
    // shape groups on top of later ones within a layer. The body
    // (ghost-group) is an opaque gradient fill — if it isn't last in
    // doc.layers[0].shapes, it paints over the eyes and mouth and the face
    // silently disappears (no console error, no invalid document). Do not
    // "fix" this ordering by matching the SVG twin's paint order.
    const doc = JSON.parse(renderLottie());
    const ghost = doc.layers[0];
    const names = ghost.shapes.map((g: { nm: string }) => g.nm);
    expect(names).toEqual(["mouth-group", "face-group", "ghost-group"]);

    // Belt-and-suspenders: identify the body group structurally too — the
    // one whose `it` array has both a path ("sh") and a gradient fill
    // ("gf") — and confirm it is the final (bottom-painted) group.
    const isBodyGroup = (g: { it: { ty: string }[] }): boolean =>
      g.it.some((x) => x.ty === "sh") && g.it.some((x) => x.ty === "gf");
    const bodyIndex = ghost.shapes.findIndex(isBodyGroup);
    expect(bodyIndex).toBe(ghost.shapes.length - 1);
  });
});

import { packIco, renderTrayMark } from "../scripts/brand/emit-icons.js";

describe("icon emitter", () => {
  it("packs an ICO with a correct header and directory", () => {
    const pngs = [
      { size: 16, data: Buffer.alloc(10, 1) },
      { size: 256, data: Buffer.alloc(20, 2) },
    ];
    const ico = packIco(pngs);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(2); // image count
    // 256 is encoded as 0 in the single width/height bytes.
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(6 + 16)).toBe(0);
    // First payload starts after the 6-byte header + two 16-byte entries.
    expect(ico.readUInt32LE(6 + 12)).toBe(38);
    expect(ico.readUInt32LE(6 + 16 + 12)).toBe(48);
    expect(ico.length).toBe(38 + 10 + 20);
  });

  it("preserves the payload bytes at the offsets it advertises", () => {
    const first = Buffer.alloc(10, 1);
    const ico = packIco([{ size: 16, data: first }]);
    const offset = ico.readUInt32LE(6 + 12);
    const len = ico.readUInt32LE(6 + 8);
    expect(ico.subarray(offset, offset + len)).toEqual(first);
  });

  it("renders the tray mark as a black+alpha template with no desk", () => {
    // macOS template images must be black + alpha only; any gradient or the
    // desk bar's grey would defeat the menu-bar inversion.
    const svg = renderTrayMark();
    expect(svg).toContain('fill="#000000"');
    expect(svg).not.toContain("url(#tray-body)");
    expect(svg).not.toContain("#8A93A3"); // desk bar dropped
    expect(svg).not.toContain("#A18AF5"); // no gradient violet
    expect(svg).toContain("#FFFFFF"); // face knocked out to white
    expect(svg).not.toContain(palette.face); // original face color replaced
  });
});
