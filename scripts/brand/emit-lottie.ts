/**
 * Emits the animated ghost as bodymovin v5 JSON for lottie-web.
 *
 * Layer order is top-first (Lottie renders earlier layers above later ones):
 * ghost, shadow, desk. Only the ghost body's shape morphs; the face and shadow
 * ride their layer transforms.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetsDir } from "./emit-static.js";
import {
  bob,
  CANVAS,
  deskBar,
  eyes,
  FPS,
  FRAMES,
  GHOST_FIT,
  ghostBodyBezier,
  KEYFRAMES,
  palette,
  shadowAt,
  shadowEllipse,
  type BezierShape,
} from "./geometry.js";

/** Lottie colours are 0..1 RGB triples. */
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [
    Math.round((((n >> 16) & 255) / 255) * 1000) / 1000,
    Math.round((((n >> 8) & 255) / 255) * 1000) / 1000,
    Math.round(((n & 255) / 255) * 1000) / 1000,
  ];
}

/** Symmetric ease-in-out, matching the SVG's keySplines. */
const EASE_IN = { x: 0.42, y: 0 };
const EASE_OUT = { x: 0.58, y: 1 };

interface ShapeValue {
  i: number[][];
  o: number[][];
  v: number[][];
  c: true;
}

function toShapeValue(b: BezierShape): ShapeValue {
  return { i: b.i.map((p) => [...p]), o: b.o.map((p) => [...p]), v: b.v.map((p) => [...p]), c: true };
}

function shapeKeyframes(): unknown[] {
  return KEYFRAMES.map((t, idx) => {
    const frame = { t: Math.round(t * FRAMES), s: [toShapeValue(ghostBodyBezier(t))] };
    // The final keyframe is a hold — it carries no easing handles.
    return idx === KEYFRAMES.length - 1 ? frame : { i: EASE_OUT, o: EASE_IN, ...frame };
  });
}

function valueKeyframes(values: number[][]): unknown[] {
  return KEYFRAMES.map((t, idx) => {
    const frame = { t: Math.round(t * FRAMES), s: values[idx]! };
    return idx === KEYFRAMES.length - 1
      ? frame
      : { i: { x: [EASE_OUT.x], y: [EASE_OUT.y] }, o: { x: [EASE_IN.x], y: [EASE_IN.y] }, ...frame };
  });
}

function fill(hex: string, opacity = 100): unknown {
  return { ty: "fl", c: { a: 0, k: [...rgb(hex), 1] }, o: { a: 0, k: opacity }, r: 1, nm: "fill" };
}

/**
 * A LAYER transform (the `ks` field). Must NOT carry a `ty`.
 * Group transforms are a different shape — see groupTransform below. Getting
 * these two confused makes lottie-web render nothing, with no console error.
 */
function layerTransform(): unknown {
  return {
    o: { a: 0, k: 100 },
    r: { a: 0, k: 0 },
    p: { a: 0, k: [0, 0] },
    a: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] },
  };
}

/** A GROUP transform — the last item of a `ty: "gr"` group's `it` array. */
function groupTransform(p: [number, number], scalePct = 100, nm = "transform"): unknown {
  return {
    ty: "tr",
    p: { a: 0, k: p },
    a: { a: 0, k: [0, 0] },
    s: { a: 0, k: [scalePct, scalePct] },
    r: { a: 0, k: 0 },
    o: { a: 0, k: 100 },
    sk: { a: 0, k: 0 },
    sa: { a: 0, k: 0 },
    nm,
  };
}

function layer(ind: number, nm: string, transform: unknown, shapes: unknown[]): unknown {
  return {
    ddd: 0,
    ind,
    ty: 4,
    nm,
    sr: 1,
    ks: transform,
    ao: 0,
    shapes,
    ip: 0,
    op: FRAMES,
    st: 0,
    bm: 0,
  };
}

/** The ghost: morphing body plus a static face, all inside one fitted group. */
function ghostLayer(): unknown {
  // GHOST_FIT as a group transform, applied identically to body, eyes, and
  // mouth so the face can never detach from the body.
  const fit = (): unknown =>
    groupTransform([GHOST_FIT.tx, GHOST_FIT.ty], GHOST_FIT.scale * 100, "fit");

  const body = { ty: "sh", ind: 0, ks: { a: 1, k: shapeKeyframes() }, nm: "body" };

  const eyeShapes = eyes.map((e, k) => ({
    ty: "el",
    p: { a: 0, k: [e.cx, e.cy] },
    s: { a: 0, k: [e.rx * 2, e.ry * 2] },
    nm: `eye-${k}`,
  }));

  // The mouth is a stroked arc; Lottie has no quadratic primitive, so the
  // quadratic M 110 130 Q 120 141 130 130 is raised to its exact cubic
  // equivalent: control points sit 2/3 of the way from each endpoint to (120,141).
  const mouth = {
    ty: "sh",
    ind: 1,
    ks: {
      a: 0,
      k: {
        i: [[0, 0], [-6.67, 7.33]],
        o: [[6.67, 7.33], [0, 0]],
        v: [[110, 130], [130, 130]],
        c: false,
      },
    },
    nm: "mouth",
  };

  return layer(1, "ghost", {
    o: { a: 0, k: 100 },
    r: { a: 0, k: 0 },
    p: { a: 1, k: valueKeyframes(KEYFRAMES.map((t) => [0, bob(t)])) },
    a: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] },
  }, [
    // Shape group order within a layer: Lottie paints EARLIER groups on top
    // (the opposite of SVG, where later elements are on top). ghost-group is
    // an opaque gradient-filled body, so it must come LAST or it covers the
    // face. Do not "tidy" this back into SVG order (mouth, face, body would
    // become body, face, mouth) — that hides the face again.
    {
      ty: "gr",
      nm: "mouth-group",
      it: [
        mouth,
        {
          ty: "st",
          nm: "mouth-stroke",
          c: { a: 0, k: [...rgb(palette.face), 1] },
          o: { a: 0, k: 100 },
          w: { a: 0, k: 6 },
          lc: 2,
          lj: 2,
        },
        fit(),
      ],
    },
    {
      ty: "gr",
      nm: "face-group",
      it: [...eyeShapes, fill(palette.face), fit()],
    },
    {
      ty: "gr",
      nm: "ghost-group",
      it: [
        body,
        {
          ty: "gf",
          nm: "body-gradient",
          o: { a: 0, k: 100 },
          r: 1,
          t: 1,
          s: { a: 0, k: [120, 20] },
          e: { a: 0, k: [120, 218] },
          g: {
            p: 3,
            k: {
              a: 0,
              k: [
                0, ...rgb(palette.ghostTop),
                0.45, ...rgb(palette.ghostMid),
                1, ...rgb(palette.ghostBot),
              ],
            },
          },
        },
        fit(),
      ],
    },
  ]);
}

function shadowLayer(): unknown {
  const scales = KEYFRAMES.map((t) => {
    const s = shadowAt(t).scale * 100;
    return [Math.round(s * 100) / 100, Math.round(s * 100) / 100];
  });
  const opacities = KEYFRAMES.map((t) => [
    Math.round((shadowAt(t).opacity / palette.shadowOpacity) * 10000) / 100,
  ]);
  return layer(2, "shadow", {
    o: { a: 1, k: valueKeyframes(opacities) },
    r: { a: 0, k: 0 },
    p: { a: 0, k: [shadowEllipse.cx, shadowEllipse.cy] },
    a: { a: 0, k: [shadowEllipse.cx, shadowEllipse.cy] },
    s: { a: 1, k: valueKeyframes(scales) },
  }, [
    {
      ty: "gr",
      nm: "shadow-group",
      it: [
        {
          ty: "el",
          p: { a: 0, k: [shadowEllipse.cx, shadowEllipse.cy] },
          s: { a: 0, k: [shadowEllipse.rx * 2, shadowEllipse.ry * 2] },
          nm: "shadow-ellipse",
        },
        {
          ty: "gf",
          nm: "shadow-gradient",
          o: { a: 0, k: 100 },
          r: 1,
          t: 2, // radial
          s: { a: 0, k: [shadowEllipse.cx, shadowEllipse.cy] },
          e: { a: 0, k: [shadowEllipse.cx + shadowEllipse.rx, shadowEllipse.cy] },
          g: {
            // `p` counts COLOUR stops; the alpha stops are appended after them
            // as [offset, alpha] pairs. Without the alpha stops the shadow is a
            // hard-edged disc instead of a soft contact shadow.
            p: 3,
            k: {
              a: 0,
              k: [
                0, ...rgb(palette.shadow),
                0.55, ...rgb(palette.shadow),
                1, ...rgb(palette.shadow),
                0, palette.shadowOpacity,
                0.55, 0.2,
                1, 0,
              ],
            },
          },
        },
        groupTransform([0, 0], 100, "shadow-transform"),
      ],
    },
  ]);
}

function deskLayer(): unknown {
  return layer(3, "desk", layerTransform(), [
    {
      ty: "gr",
      nm: "desk-group",
      it: [
        {
          ty: "rc",
          p: { a: 0, k: [deskBar.x + deskBar.w / 2, deskBar.y + deskBar.h / 2] },
          s: { a: 0, k: [deskBar.w, deskBar.h] },
          r: { a: 0, k: deskBar.r },
          nm: "desk-rect",
        },
        fill(palette.desk, Math.round(palette.deskOpacity * 100)),
        groupTransform([0, 0], 100, "desk-transform"),
      ],
    },
  ]);
}

export function renderLottie(): string {
  const doc = {
    v: "5.9.0",
    fr: FPS,
    ip: 0,
    op: FRAMES,
    w: CANVAS,
    h: CANVAS,
    nm: "DeskRAG Ghost",
    ddd: 0,
    assets: [],
    layers: [ghostLayer(), shadowLayer(), deskLayer()],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function main(): void {
  writeFileSync(join(assetsDir, "deskrag-ghost.lottie.json"), renderLottie());
  console.log("brand: wrote deskrag-ghost.lottie.json");
}
