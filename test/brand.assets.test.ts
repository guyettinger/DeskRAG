import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { assetsDir, renderLogo, renderMark } from "../scripts/gen/brand/emit-static.js";
import { renderAnimatedSvg } from "../scripts/gen/brand/emit-svg.js";
import {
  aperture,
  CANVAS,
  eyes,
  FPS,
  FRAMES,
  GHOST_FIT,
  KEYFRAMES,
  palette,
  workDots,
} from "../scripts/gen/brand/geometry.js";
import { TRAY_FACES } from "../scripts/gen/brand/emit-icons.js";
import { trayFaceAsset } from "../app/src/main/tray-face.js";

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

import { renderLottie } from "../scripts/gen/brand/emit-lottie.js";
import { ghostBodyBezier } from "../scripts/gen/brand/geometry.js";

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

import { packIco, renderTrayMark } from "../scripts/gen/brand/emit-icons.js";

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

  it("renders the tray mark as a black+alpha template with no desk", async () => {
    // macOS template images use only the alpha channel — colour is discarded,
    // so a "white" face would be just as opaque as the black body and
    // wouldn't read as knocked out. The face must be genuinely transparent
    // (alpha 0), which this rasterises and checks for directly.
    const svg = renderTrayMark();
    expect(svg).not.toContain("url(#tray-body)");
    expect(svg).not.toContain("#8A93A3"); // desk bar dropped
    expect(svg).not.toContain("#A18AF5"); // no gradient violet
    expect(svg).not.toContain(palette.face); // original face color not restated

    const size = 256;
    const { data, info } = await sharp(Buffer.from(svg))
      .resize(size, size)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number): number => {
      const px = Math.round(x);
      const py = Math.round(y);
      const idx = (py * info.width + px) * info.channels + 3;
      return data[idx]!;
    };
    const canvasScale = size / CANVAS;

    // An eye centre, mapped from ghost-local space through GHOST_FIT into
    // canvas space, then scaled to the rasterised size: must be fully
    // transparent — the face is cut out of the silhouette.
    const eye = eyes[0]!;
    const eyeX = (eye.cx * GHOST_FIT.scale + GHOST_FIT.tx) * canvasScale;
    const eyeY = (eye.cy * GHOST_FIT.scale + GHOST_FIT.ty) * canvasScale;
    expect(alphaAt(eyeX, eyeY)).toBe(0);

    // A point in the ghost's upper dome: clearly inside the body, outside the
    // face — must be solidly opaque.
    const domeX = (120 * GHOST_FIT.scale + GHOST_FIT.tx) * canvasScale;
    const domeY = (60 * GHOST_FIT.scale + GHOST_FIT.ty) * canvasScale;
    expect(alphaAt(domeX, domeY)).toBeGreaterThan(200);
  });

  it("committed tray PNG is not stale (transparent eye, opaque body)", async () => {
    // The freshly-rendered checks above never touch the COMMITTED icon —
    // if `npm run gen:brand` ever dies partway (it throws on non-macOS
    // before writing icons, after the SVG/Lottie were already rewritten),
    // the committed PNG would go stale with an otherwise-green suite. This
    // loads the committed file itself and checks alpha at geometry-derived
    // points, scaled to the PNG's actual dimensions rather than a hardcoded
    // coordinate. Deliberately weaker than a byte-compare: rasterisation
    // output varies across libvips/librsvg versions (see emit-icons.ts).
    const trayPath = join(assetsDir, "..", "app/build/tray/trayTemplate@2x.png");
    const { data, info } = await sharp(trayPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Pixel (x, y) covers the continuous region [x, x+1) x [y, y+1), so the
    // containing pixel for a fractional coordinate is floor, not round — at
    // this PNG's native 32x32 resolution the eye is only ~3px wide, so
    // rounding to the nearer pixel can land just outside the cutout.
    const alphaAt = (x: number, y: number): number => {
      const px = Math.floor(x);
      const py = Math.floor(y);
      const idx = (py * info.width + px) * info.channels + 3;
      return data[idx]!;
    };
    const canvasScale = info.width / CANVAS;

    const eye = eyes[0]!;
    const eyeX = (eye.cx * GHOST_FIT.scale + GHOST_FIT.tx) * canvasScale;
    const eyeY = (eye.cy * GHOST_FIT.scale + GHOST_FIT.ty) * canvasScale;
    expect(alphaAt(eyeX, eyeY)).toBe(0);

    const domeX = (120 * GHOST_FIT.scale + GHOST_FIT.tx) * canvasScale;
    const domeY = (60 * GHOST_FIT.scale + GHOST_FIT.ty) * canvasScale;
    expect(alphaAt(domeX, domeY)).toBeGreaterThan(200);
  });
});

/**
 * THE STATE FACES. Nothing here enumerated the tray outputs before there were
 * four of them — a new variant could have been unwritten, unprobed and
 * unnoticed, because the guard below it names one file by hand.
 *
 * Each face is probed at points DERIVED from the geometry that draws it, never
 * at pasted pixel coordinates, so moving a feature moves its own assertion.
 */
describe("tray faces", () => {
  const trayDir = join(assetsDir, "..", "app/build/tray");

  /** Ghost-local -> the rasterised image's pixel space. */
  const toPixels = (x: number, y: number, scale: number): [number, number] => [
    (x * GHOST_FIT.scale + GHOST_FIT.tx) * scale,
    (y * GHOST_FIT.scale + GHOST_FIT.ty) * scale,
  ];

  const alphaReader = async (
    input: string | Buffer,
    round: (n: number) => number,
  ): Promise<{ at: (x: number, y: number) => number; scale: number }> => {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const scale = info.width / CANVAS;
    return {
      scale,
      at: (x, y) => data[(round(y) * info.width + round(x)) * info.channels + 3]!,
    };
  };

  // Points that tell the faces apart. Directly above the pupil is on the
  // recording aperture's RING, and is plain body ink on every other face — the
  // eyes sit outboard of it. The centre dot of the indexing row is well clear
  // of both the face and the hem's lifted cusps.
  const RING = [aperture.cx, aperture.cy - (aperture.r + aperture.pupilR) / 2] as const;
  const PUPIL = [aperture.cx, aperture.cy] as const;
  const DOT = [workDots.cx, workDots.cy] as const;
  const DOME = [120, 60] as const;

  it("agrees with the runtime about which file each face is", () => {
    // Two lists of four names in two packages that cannot import each other:
    // the emitter writes them, `app/src/main/tray-face.ts` asks for them. This
    // is the only thing standing between them and a silent divergence.
    for (const { face, base } of TRAY_FACES) {
      expect(trayFaceAsset(face.capture === "recording", face.indexing)).toBe(base);
    }
    expect(new Set(TRAY_FACES.map((f) => f.base)).size).toBe(TRAY_FACES.length);
  });

  it("commits both densities of every face", () => {
    for (const { base } of TRAY_FACES) {
      expect(existsSync(join(trayDir, `${base}.png`))).toBe(true);
      expect(existsSync(join(trayDir, `${base}@2x.png`))).toBe(true);
    }
  });

  it.each(TRAY_FACES.map((f) => [f.base, f.face] as const))(
    "renders %s as black+alpha with the right features cut out",
    async (_base, face) => {
      const svg = renderTrayMark(face);
      // Every face, not just the idle one: a state symbol must not be the thing
      // that smuggles a literal colour into a template image.
      expect(svg).not.toContain("url(#tray-body)");
      expect(svg).not.toContain("#8A93A3");
      expect(svg).not.toContain("#A18AF5");
      expect(svg).not.toContain(palette.face);

      const size = 256;
      const { at, scale } = await alphaReader(
        await sharp(Buffer.from(svg)).resize(size, size).toBuffer(),
        Math.round,
      );
      const alpha = (p: readonly [number, number]): number => at(...toPixels(p[0], p[1], scale));

      expect(alpha(DOME)).toBeGreaterThan(200);

      if (face.capture === "recording") {
        // A RING, not a disc: the pupil survives because the mask paints white
        // back over the black circle. Assert both halves, or a solid hole
        // passes the "aperture is cut out" check just as well.
        expect(alpha(RING)).toBe(0);
        expect(alpha(PUPIL)).toBeGreaterThan(200);
      } else {
        const eye = eyes[0]!;
        expect(alpha([eye.cx, eye.cy])).toBe(0);
        expect(alpha(RING)).toBeGreaterThan(200);
      }

      if (face.indexing) expect(alpha(DOT)).toBe(0);
      else expect(alpha(DOT)).toBeGreaterThan(200);
    },
  );

  it.each(TRAY_FACES.map((f) => [f.base, f.face] as const))(
    "committed %s@2x is not stale",
    async (base, face) => {
      // Same reason as the idle guard above: `gen:brand` throws on non-macOS
      // AFTER the SVG and Lottie have been rewritten, so a committed PNG can go
      // stale with a green suite. At 32x32 a feature is 2-3px wide, so this
      // asserts "clearly eaten into" rather than "exactly zero" — floor, not
      // round, for the same sub-pixel reason the idle guard gives.
      const { at, scale } = await alphaReader(join(trayDir, `${base}@2x.png`), Math.floor);
      const alpha = (p: readonly [number, number]): number => at(...toPixels(p[0], p[1], scale));

      expect(alpha(DOME)).toBeGreaterThan(200);
      if (face.capture === "recording") {
        expect(alpha(RING)).toBeLessThan(128);
        expect(alpha(PUPIL)).toBeGreaterThan(128);
      } else {
        const eye = eyes[0]!;
        expect(alpha([eye.cx, eye.cy])).toBe(0);
        expect(alpha(RING)).toBeGreaterThan(200);
      }
      if (face.indexing) expect(alpha(DOT)).toBeLessThan(128);
      else expect(alpha(DOT)).toBeGreaterThan(200);
    },
  );
});
