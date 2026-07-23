# DeskRAG Brand Mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a rag-ghost-over-a-desk mark for DeskRAG — static logo, square app/tray icon, and an animated Lottie — and apply it to both READMEs and DeskRAGApp.

**Architecture:** One pure-TypeScript geometry module (`scripts/brand/geometry.ts`) owns the ghost's shape, motion, and palette. Four emitters read from it and write the four asset formats (static SVG, animated SVG, Lottie JSON, raster icons). Because the animated SVG and the Lottie describe identical motion in incompatible formats, neither is hand-authored — both are generated, and a vitest drift guard byte-compares the committed assets against freshly rendered output so they can never diverge.

**Tech Stack:** TypeScript (strict, ESM, NodeNext) run via `tsx`; `sharp` for rasterisation (already a root dependency); macOS `iconutil` for `.icns`; a hand-rolled ICO packer; `lottie-web` (light build) in the Electron renderer; `electron-builder` for packaged icons.

**Spec:** `docs/superpowers/specs/2026-07-23-brand-mark-design.md`

## Global Constraints

- **Palette is fixed, exact values:** ghost gradient `#FFFFFF` → `#F3EEFF` (45%) → `#A18AF5` (100%); face `#12161C`; desk `#8A93A3` at opacity `0.55`; shadow `#6D5BD0` at opacity `0.28` fading to `0`.
- **No SVG filters.** No `feGaussianBlur` or any `<filter>` anywhere. Softness comes from radial gradient stops only — libvips/librsvg (inside `sharp`) renders filters inconsistently, gradients exactly.
- **One mark, no light/dark variants.** Every asset must be legible on GitHub light, GitHub dark, and the app's `#0f1216`.
- **Zero new build dependencies.** Rasterisation uses the existing `sharp`; `.icns` uses macOS's built-in `iconutil`; `.ico` uses a hand-rolled packer. The only new packages in the whole plan are `lottie-web` (runtime, `deskrag-app` workspace only) and `electron-builder` (devDependency, `deskrag-app` workspace only).
- **The library (`src/`) gains no dependencies and is not modified.** No changes to the store, the IPC contract, or `app/src/shared/types.ts`.
- **Loop timing is `FPS = 60`, `FRAMES = 180`** (3 seconds) in both the SVG and the Lottie.
- **Scripts are TypeScript**, matching `scripts/crash-child.ts`. They are covered by the root `tsconfig.json` (`include` already lists `scripts`), so `npm run typecheck` gates them. That tsconfig sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax` — relative imports need explicit `.js` extensions, and array indexing yields `T | undefined`.
- **Generated assets are committed.** `assets/*` and `app/build/*` are checked in so neither packaging nor a fresh clone requires running the generator.
- **Every emitter separates rendering from writing:** it exports a pure `render…()` returning a string/Buffer, and a `main()` that writes files. The drift guard calls `render…()` only.
- **Never transcribe generated art into hand-written code.** Components import the generated asset (raw SVG text, or the Lottie JSON); they do not re-type path data. A transcribed copy forks the art away from `geometry.ts` and silently defeats the whole pipeline.
- **Deviation from the spec, deliberate:** the spec names one test file `test/brand.test.ts`. This plan splits it into `test/brand.geometry.test.ts` (unit tests for the shape/motion math) and `test/brand.assets.test.ts` (the drift guard), because Task 1 must be testable before any asset exists.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `scripts/brand/geometry.ts` | Shape, motion, palette. Pure functions, no I/O, no format knowledge. |
| `scripts/brand/emit-static.ts` | → `assets/deskrag-mark.svg`, `assets/deskrag-logo.svg` |
| `scripts/brand/emit-svg.ts` | → `assets/deskrag-ghost.svg` (CSS bob + SMIL hem morph) |
| `scripts/brand/emit-lottie.ts` | → `assets/deskrag-ghost.lottie.json` (bodymovin v5) |
| `scripts/brand/emit-icons.ts` | → `app/build/icon.{png,icns,ico}`, `app/build/tray/*` |
| `scripts/brand/index.ts` | Runner for all four emitters (`npm run gen:brand`) |
| `test/brand.geometry.test.ts` | Unit tests for the geometry module |
| `test/brand.assets.test.ts` | Drift guard: re-render and byte-compare committed assets |
| `app/src/renderer/src/brand/GhostMark.tsx` | Static inline-SVG mark component |
| `app/src/renderer/src/brand/GhostLottie.tsx` | `lottie-web` wrapper, honors `prefers-reduced-motion` |
| `app/src/renderer/src/brand/lottie-light.d.ts` | Types for the `lottie_light` subpath |
| `app/src/renderer/src/brand/raw-assets.d.ts` | Types for vite's `?raw` import suffix |
| `app/electron-builder.yml` | Packaging config carrying the icons |

**Modified:** `package.json` (root, `gen:brand` script) · `app/package.json` (deps + `dist` script) · `app/electron.vite.config.ts` (`@brand` alias + `server.fs.allow`) · `app/tsconfig.json` (`@brand/*` path) · `app/src/renderer/src/App.tsx` (rail brand) · `app/src/renderer/src/styles.css` (brand + ghost styles) · `app/src/renderer/src/screens/RecordScreen.tsx` · `app/src/renderer/src/screens/SearchScreen.tsx` · `app/src/main/index.ts` (tray + dock icon) · `README.md` · `app/README.md`

---

### Task 1: Geometry module

The foundation. Everything else reads from this file, so it must be correct and well-tested before any emitter exists.

**Files:**
- Create: `scripts/brand/geometry.ts`
- Test: `test/brand.geometry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces — every later task imports from `scripts/brand/geometry.ts`:
  - `palette: { ghostTop, ghostMid, ghostBot, face, desk, deskOpacity, shadow, shadowOpacity }` (readonly)
  - `CANVAS: 256`, `FPS: 60`, `FRAMES: 180`, `KEYFRAMES: readonly number[]`, `BOB_AMPLITUDE: 8`
  - `GHOST_FIT: { scale: number; tx: number; ty: number }`
  - `shadowEllipse: { cx, cy, rx, ry }`, `deskBar: { x, y, w, h, r }`
  - `eyes: readonly { cx, cy, rx, ry }[]`, `mouthPath: string`, `mouthWidth: number`
  - `interface BezierShape { v: Pt[]; i: Pt[]; o: Pt[] }` where `type Pt = [number, number]`
  - `ghostBodyBezier(phase: number): BezierShape`
  - `bezierToPath(s: BezierShape): string`
  - `ghostBodyPath(phase: number): string`
  - `hemShape(phase: number): { depths: [number, number, number]; lifts: [number, number] }`
  - `bob(t: number): number` — negative means risen
  - `shadowAt(t: number): { scale: number; opacity: number }`

- [ ] **Step 1: Write the failing test**

Create `test/brand.geometry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  BOB_AMPLITUDE,
  bezierToPath,
  bob,
  FRAMES,
  ghostBodyBezier,
  ghostBodyPath,
  hemShape,
  KEYFRAMES,
  shadowAt,
} from "../scripts/brand/geometry.js";

describe("ghost geometry", () => {
  it("emits a closed 7-vertex bezier with matching tangent arrays", () => {
    const s = ghostBodyBezier(0);
    expect(s.v).toHaveLength(7);
    expect(s.i).toHaveLength(7);
    expect(s.o).toHaveLength(7);
  });

  it("keeps the vertex count constant across every keyframe phase", () => {
    // Lottie path morphing requires identical vertex counts, or the shape tweens
    // into garbage. This is the invariant that protects that.
    const counts = KEYFRAMES.map((t) => ghostBodyBezier(t).v.length);
    expect(new Set(counts).size).toBe(1);
  });

  it("moves the hem between keyframes so the animation is not static", () => {
    expect(ghostBodyPath(0)).not.toEqual(ghostBodyPath(0.25));
  });

  it("loops seamlessly: phase 1 reproduces phase 0", () => {
    expect(ghostBodyPath(1)).toEqual(ghostBodyPath(0));
  });

  it("holds the body outline fixed while the hem moves", () => {
    // Vertices 1..4 are the sides and dome; only 0, 5, 6 are hem.
    const a = ghostBodyBezier(0);
    const b = ghostBodyBezier(0.5);
    expect(a.v.slice(1, 5)).toEqual(b.v.slice(1, 5));
  });

  it("bobs sinusoidally and returns to rest at the loop point", () => {
    expect(bob(0)).toBe(0);
    expect(bob(0.25)).toBe(-BOB_AMPLITUDE); // risen
    expect(bob(0.75)).toBe(BOB_AMPLITUDE); // sunk
    expect(bob(1)).toBe(bob(0));
  });

  it("tightens and fades the shadow as the ghost rises", () => {
    const high = shadowAt(0.25);
    const low = shadowAt(0.75);
    expect(high.scale).toBeLessThan(low.scale);
    expect(high.opacity).toBeLessThan(low.opacity);
  });

  it("keeps every hem lobe hanging below the hem line", () => {
    for (const t of KEYFRAMES) {
      const { depths, lifts } = hemShape(t);
      for (const d of depths) expect(d).toBeGreaterThan(0);
      for (const l of lifts) expect(l).toBeGreaterThan(0);
    }
  });

  it("renders a path that starts with a move and closes", () => {
    const d = ghostBodyPath(0);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.trimEnd().endsWith("Z")).toBe(true);
    expect(d).not.toMatch(/NaN|Infinity/);
  });

  it("lands keyframes on whole frame numbers", () => {
    for (const t of KEYFRAMES) expect(Number.isInteger(t * FRAMES)).toBe(true);
  });

  it("round-trips a bezier through bezierToPath without NaN", () => {
    expect(bezierToPath(ghostBodyBezier(0.5))).not.toMatch(/NaN/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/brand.geometry.test.ts`
Expected: FAIL — `Failed to resolve import "../scripts/brand/geometry.js"`.

- [ ] **Step 3: Write the geometry module**

Create `scripts/brand/geometry.ts`:

```ts
/**
 * The single source of truth for the DeskRAG mark: shape, motion, and palette.
 *
 * Pure functions, no I/O, no knowledge of any file format. Every emitter
 * (static SVG, animated SVG, Lottie, icons) derives its output from here, which
 * is what stops the animated SVG and the Lottie JSON from drifting apart.
 */

export type Pt = [number, number];

export const palette = {
  ghostTop: "#FFFFFF",
  ghostMid: "#F3EEFF",
  ghostBot: "#A18AF5",
  face: "#12161C",
  desk: "#8A93A3",
  deskOpacity: 0.55,
  shadow: "#6D5BD0",
  shadowOpacity: 0.28,
} as const;

/** The mark is composed on a 256x256 square. */
export const CANVAS = 256;

/** Loop timing, shared by the animated SVG and the Lottie. 3 seconds. */
export const FPS = 60;
export const FRAMES = 180;

/**
 * Sampled phases. Four distinct hem shapes plus a repeat of the first, so the
 * loop closes seamlessly. Each lands on a whole frame: 0, 45, 90, 135, 180.
 */
export const KEYFRAMES = [0, 0.25, 0.5, 0.75, 1] as const;

// --- Ghost-local coordinate box (240 x 260) -------------------------------
// Authoring the ghost in its own box keeps the numbers legible; GHOST_FIT
// places it on the 256 canvas.

const LEFT = 24;
const RIGHT = 216;
const APEX_Y = 20;
const SHOULDER_Y = 130;
const HEM_Y = 196;
const CUSP_X: readonly [number, number] = [88, 152];

const LOBE_DEPTH = 22;
const LOBE_WOBBLE = 5;
const CUSP_LIFT = 10;
const CUSP_WOBBLE = 3;

/** Places the 240x260 ghost box onto the 256 canvas: translate then scale. */
export const GHOST_FIT = { scale: 0.86, tx: 24.8, ty: 4.8 } as const;

/** Contact shadow, in canvas coordinates. Sits on the desk bar. */
export const shadowEllipse = { cx: 128, cy: 216, rx: 56, ry: 11 } as const;

/** The implied desk: one rounded bar, in canvas coordinates. */
export const deskBar = { x: 20, y: 213, w: 216, h: 7, r: 3.5 } as const;

/** Face, in ghost-local coordinates. */
export const eyes = [
  { cx: 88, cy: 112, rx: 13, ry: 17 },
  { cx: 152, cy: 112, rx: 13, ry: 17 },
] as const;
export const mouthPath = "M 110 130 Q 120 141 130 130";
export const mouthWidth = 6;

/** Vertical bob amplitude, in ghost-local units. */
export const BOB_AMPLITUDE = 8;

/**
 * Two decimals — enough precision to be smooth, few enough to be stable output.
 * Normalises -0 to 0: Object.is(-0, 0) is false, so an unnormalised -0 makes
 * loop-seam assertions fail and puts a stray "-0" in generated path strings.
 */
const r = (n: number): number => {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
};

export interface Hem {
  /** Depth each of the three lobes hangs below the hem line. */
  depths: [number, number, number];
  /** Height each of the two cusps rises above the hem line. */
  lifts: [number, number];
}

/**
 * The hem at a given phase. Each lobe is phase-offset from its neighbour so the
 * cloth ripples left-to-right rather than pulsing in unison.
 */
export function hemShape(phase: number): Hem {
  const w = (i: number): number => 2 * Math.PI * (phase + i * 0.22);
  return {
    depths: [
      LOBE_DEPTH + LOBE_WOBBLE * Math.sin(w(0)),
      LOBE_DEPTH + LOBE_WOBBLE * Math.sin(w(1)),
      LOBE_DEPTH + LOBE_WOBBLE * Math.sin(w(2)),
    ],
    lifts: [
      CUSP_LIFT + CUSP_WOBBLE * Math.sin(w(0.5)),
      CUSP_LIFT + CUSP_WOBBLE * Math.sin(w(1.5)),
    ],
  };
}

export interface BezierShape {
  /** Vertices. */
  v: Pt[];
  /** In-tangents, relative to their vertex. */
  i: Pt[];
  /** Out-tangents, relative to their vertex. */
  o: Pt[];
}

/**
 * The ghost outline as a closed cubic bezier, traversed clockwise from the
 * bottom-left: up the left side, over the dome, down the right side, then the
 * hem right-to-left. Lottie needs vertices-and-tangents; SVG needs a path
 * string. Producing the bezier once and deriving the path from it guarantees
 * the two formats describe the same curve.
 */
export function ghostBodyBezier(phase: number): BezierShape {
  const { depths, lifts } = hemShape(phase);
  const [d0, d1, d2] = depths;
  const [l0, l1] = lifts;
  const [cuspL, cuspR] = CUSP_X;

  const v: Pt[] = [
    [LEFT, HEM_Y], // 0 bottom-left
    [LEFT, SHOULDER_Y], // 1 left shoulder
    [120, APEX_Y], // 2 apex
    [RIGHT, SHOULDER_Y], // 3 right shoulder
    [RIGHT, HEM_Y], // 4 bottom-right
    [cuspR, HEM_Y - l1], // 5 right cusp
    [cuspL, HEM_Y - l0], // 6 left cusp
  ];

  const o: Pt[] = [
    [0, 0], // 0 straight up the left side
    [0, 62 - SHOULDER_Y], // 1 into the dome
    [54, 0], // 2 out of the apex
    [0, 0], // 3 straight down the right side
    [0, d2], // 4 vertical, so the hem meets the side seamlessly
    [132 - cuspR, d1 + l1], // 5 into the middle lobe
    [68 - cuspL, d0 + l0], // 6 into the left lobe
  ];

  const i: Pt[] = [
    [0, d0], // 0 vertical, closing the left lobe into the side
    [0, 0], // 1 straight
    [-54, 0], // 2 into the apex
    [0, 62 - SHOULDER_Y], // 3 out of the dome
    [0, 0], // 4 straight
    [172 - cuspR, d2 + l1], // 5 closing the right lobe
    [108 - cuspL, d1 + l0], // 6 closing the middle lobe
  ];

  return { v, i, o };
}

/** Converts a closed bezier to an SVG path. Straight runs become zero-tangent curves. */
export function bezierToPath(s: BezierShape): string {
  const n = s.v.length;
  const start = s.v[0]!;
  const parts: string[] = [`M ${r(start[0])} ${r(start[1])}`];
  for (let k = 1; k <= n; k++) {
    const a = s.v[(k - 1) % n]!;
    const b = s.v[k % n]!;
    const ao = s.o[(k - 1) % n]!;
    const bi = s.i[k % n]!;
    parts.push(
      `C ${r(a[0] + ao[0])} ${r(a[1] + ao[1])}` +
        ` ${r(b[0] + bi[0])} ${r(b[1] + bi[1])}` +
        ` ${r(b[0])} ${r(b[1])}`,
    );
  }
  parts.push("Z");
  return parts.join(" ");
}

/** The ghost outline at a phase, as an SVG path string. */
export function ghostBodyPath(phase: number): string {
  return bezierToPath(ghostBodyBezier(phase));
}

/** Vertical offset at normalised time t. Negative means risen. */
export function bob(t: number): number {
  return r(-BOB_AMPLITUDE * Math.sin(2 * Math.PI * t));
}

/**
 * The shadow tightens and fades as the ghost rises. This is the cue that reads
 * as "hovering" rather than "sliding".
 */
export function shadowAt(t: number): { scale: number; opacity: number } {
  const u = (Math.sin(2 * Math.PI * t) + 1) / 2; // 0 at the lowest point, 1 at the highest
  return {
    scale: r(1 - 0.14 * u),
    opacity: r(palette.shadowOpacity - 0.1 * u),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/brand.geometry.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verify types**

Run: `npm run typecheck`
Expected: no output (success). If `noUncheckedIndexedAccess` complains about a `Pt` index, the `!` assertions in `bezierToPath` are the fix — they are already present.

- [ ] **Step 6: Commit**

```bash
git add scripts/brand/geometry.ts test/brand.geometry.test.ts
git commit -m "feat(brand): ghost geometry module — the single source of truth

Shape, motion, and palette as pure functions. Emits a bezier that both the
SVG path and the Lottie shape derive from, so the two formats cannot describe
different curves."
```

---

### Task 2: Static SVG emitter — mark and logo

**Files:**
- Create: `scripts/brand/emit-static.ts`, `scripts/brand/index.ts`
- Create (generated): `assets/deskrag-mark.svg`, `assets/deskrag-logo.svg`
- Modify: `package.json` (add `gen:brand` script)
- Test: `test/brand.assets.test.ts`

**Interfaces:**
- Consumes: everything from `geometry.js` (Task 1).
- Produces:
  - `renderMark(): string` — the 256×256 square mark
  - `renderLogo(): string` — the horizontal lockup
  - `ghostDefs(idPrefix: string): string` — the `<defs>` block (gradients), reused by Tasks 3 and 5
  - `deskRect(): string` — the desk bar, reused by Task 3
  - `shadowEl(idPrefix: string, extra?: string): string` — the contact shadow, reused by Task 3
  - `ghostGroup(pathD: string, idPrefix: string): string` — the fitted ghost `<g>` (body + face), reused by Tasks 3 and 5
  - `main(): void` — writes both files
  - `assetsDir: string` — absolute path to the repo's `assets/`

- [ ] **Step 1: Write the failing test**

Create `test/brand.assets.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/brand.assets.test.ts`
Expected: FAIL — cannot resolve `../scripts/brand/emit-static.js`.

- [ ] **Step 3: Write the emitter**

Create `scripts/brand/emit-static.ts`:

```ts
/**
 * Emits the static brand assets: the square mark and the horizontal lockup.
 *
 * Rendering is separated from writing so the drift guard in
 * test/brand.assets.test.ts can compare committed bytes against fresh output
 * without touching the filesystem.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANVAS,
  deskBar,
  eyes,
  GHOST_FIT,
  ghostBodyPath,
  mouthPath,
  mouthWidth,
  palette,
  shadowEllipse,
} from "./geometry.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo's canonical assets directory. */
export const assetsDir = join(here, "../../assets");

/** Gradients. Prefixed ids so an inlined mark cannot collide with page ids. */
export function ghostDefs(idPrefix: string): string {
  return [
    "  <defs>",
    `    <linearGradient id="${idPrefix}-body" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0" stop-color="${palette.ghostTop}"/>`,
    `      <stop offset="0.45" stop-color="${palette.ghostMid}"/>`,
    `      <stop offset="1" stop-color="${palette.ghostBot}"/>`,
    "    </linearGradient>",
    `    <radialGradient id="${idPrefix}-shadow">`,
    `      <stop offset="0" stop-color="${palette.shadow}" stop-opacity="${palette.shadowOpacity}"/>`,
    `      <stop offset="0.55" stop-color="${palette.shadow}" stop-opacity="0.2"/>`,
    `      <stop offset="1" stop-color="${palette.shadow}" stop-opacity="0"/>`,
    "    </radialGradient>",
    "  </defs>",
  ].join("\n");
}

/** The desk bar. Drawn first, so the contact shadow lands on top of it. */
export function deskRect(): string {
  return (
    `  <rect x="${deskBar.x}" y="${deskBar.y}" width="${deskBar.w}" height="${deskBar.h}"` +
    ` rx="${deskBar.r}" fill="${palette.desk}" fill-opacity="${palette.deskOpacity}"/>`
  );
}

/** The contact shadow. `extra` carries per-format attributes (class, id). */
export function shadowEl(idPrefix: string, extra = ""): string {
  return (
    `  <ellipse cx="${shadowEllipse.cx}" cy="${shadowEllipse.cy}"` +
    ` rx="${shadowEllipse.rx}" ry="${shadowEllipse.ry}"` +
    ` fill="url(#${idPrefix}-shadow)"${extra}/>`
  );
}

/** The fitted ghost: body plus face, placed on the canvas by GHOST_FIT. */
export function ghostGroup(pathD: string, idPrefix: string): string {
  const fit = `translate(${GHOST_FIT.tx} ${GHOST_FIT.ty}) scale(${GHOST_FIT.scale})`;
  const eyeEls = eyes
    .map(
      (e) =>
        `      <ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="${palette.face}"/>`,
    )
    .join("\n");
  return [
    `    <g transform="${fit}">`,
    `      <path d="${pathD}" fill="url(#${idPrefix}-body)"/>`,
    eyeEls,
    `      <path d="${mouthPath}" fill="none" stroke="${palette.face}"` +
      ` stroke-width="${mouthWidth}" stroke-linecap="round"/>`,
    "    </g>",
  ].join("\n");
}

export function renderMark(): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}"` +
      ` width="${CANVAS}" height="${CANVAS}" role="img" aria-label="DeskRAG">`,
    ghostDefs("dr"),
    deskRect(),
    shadowEl("dr"),
    "  <g>",
    ghostGroup(ghostBodyPath(0), "dr"),
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

const WORDMARK_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

export function renderLogo(): string {
  // The mark at 176px on the left, wordmark to its right. "Desk" in a mid tone
  // that holds on light and dark; "RAG" in the ghost's violet to tie them.
  const markScale = 176 / CANVAS;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 208"` +
      ` width="720" height="208" role="img" aria-label="DeskRAG">`,
    ghostDefs("dr"),
    `  <g transform="translate(8 16) scale(${markScale})">`,
    deskRect(),
    shadowEl("dr"),
    ghostGroup(ghostBodyPath(0), "dr"),
    "  </g>",
    `  <text x="212" y="134" font-family="${WORDMARK_FONT}" font-size="88"` +
      ` font-weight="650" letter-spacing="-1.5">`,
    `    <tspan fill="#8892A3">Desk</tspan><tspan fill="${palette.ghostBot}">RAG</tspan>`,
    "  </text>",
    "</svg>",
    "",
  ].join("\n");
}

export function main(): void {
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "deskrag-mark.svg"), renderMark());
  writeFileSync(join(assetsDir, "deskrag-logo.svg"), renderLogo());
  console.log("brand: wrote deskrag-mark.svg, deskrag-logo.svg");
}
```

- [ ] **Step 4: Write the runner**

Create `scripts/brand/index.ts`:

```ts
/**
 * Regenerates every brand asset from scripts/brand/geometry.ts.
 * Run with: npm run gen:brand
 */

import { main as emitStatic } from "./emit-static.js";

emitStatic();
```

(Later tasks append their emitters to this file.)

- [ ] **Step 5: Add the npm script**

In `package.json`, add to `"scripts"` immediately after `"build:ax"`:

```json
    "gen:brand": "tsx scripts/brand/index.ts",
```

- [ ] **Step 6: Generate the assets**

Run: `npm run gen:brand`
Expected: `brand: wrote deskrag-mark.svg, deskrag-logo.svg`, and `assets/` now contains both files.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/brand.assets.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Eyeball the mark**

Open `assets/deskrag-mark.svg` in a browser (`open assets/deskrag-mark.svg`). Confirm: a smooth-domed ghost with two oval eyes and a small smile, hovering clear of a horizontal bar with a soft shadow beneath it. Nothing should be clipped by the viewBox.

If the ghost sits too low or too high relative to the desk, adjust `GHOST_FIT.ty` / `shadowEllipse.cy` / `deskBar.y` in `geometry.ts`, re-run `npm run gen:brand`, and re-check. Do **not** hand-edit the SVG — the drift guard will reject it.

- [ ] **Step 9: Verify types and commit**

```bash
npm run typecheck
git add scripts/brand/emit-static.ts scripts/brand/index.ts assets/ test/brand.assets.test.ts package.json
git commit -m "feat(brand): static mark and logo lockup

Generated from geometry.ts via npm run gen:brand, with a drift guard that
byte-compares the committed SVGs against fresh output."
```

---

### Task 3: Animated SVG emitter

The README asset. CSS drives the bob and the shadow; SMIL drives the hem morph (CSS `d` animation is not supported in Firefox, SMIL is portable).

**Files:**
- Create: `scripts/brand/emit-svg.ts`
- Create (generated): `assets/deskrag-ghost.svg`
- Modify: `scripts/brand/index.ts`, `test/brand.assets.test.ts`

**Interfaces:**
- Consumes: `geometry.js` (Task 1); `assetsDir`, `ghostDefs`, `deskRect`, `shadowEl`, `ghostGroup` from `emit-static.js` (Task 2).
- Produces: `renderAnimatedSvg(): string`, `main(): void`.

- [ ] **Step 1: Write the failing test**

Append to `test/brand.assets.test.ts`:

```ts
import { renderAnimatedSvg } from "../scripts/brand/emit-svg.js";
import { FPS, FRAMES, KEYFRAMES } from "../scripts/brand/geometry.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/brand.assets.test.ts`
Expected: FAIL — cannot resolve `../scripts/brand/emit-svg.js`.

- [ ] **Step 3: Write the emitter**

Create `scripts/brand/emit-svg.ts`:

```ts
/**
 * Emits the animated ghost SVG used in the READMEs.
 *
 * CSS drives the bob and the shadow; SMIL drives the hem morph, because CSS
 * `d` animation is Chromium/WebKit-only while SMIL is portable.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assetsDir,
  deskRect,
  ghostDefs,
  ghostGroup,
  shadowEl,
} from "./emit-static.js";
import {
  BOB_AMPLITUDE,
  CANVAS,
  FPS,
  FRAMES,
  ghostBodyPath,
  KEYFRAMES,
  shadowAt,
} from "./geometry.js";

const DUR = FRAMES / FPS;
/** Symmetric ease-in-out, matching the Lottie's keyframe easing. */
const SPLINE = "0.42 0 0.58 1";

function css(): string {
  const s0 = shadowAt(0);
  const s25 = shadowAt(0.25);
  const s50 = shadowAt(0.5);
  const s75 = shadowAt(0.75);
  // Element opacity is expressed relative to the gradient's own alpha, so the
  // rendered alpha matches shadowAt() exactly in both formats.
  const rel = (o: number): number => Math.round((o / s75.opacity) * 1000) / 1000;
  return [
    "  <style>",
    "    @keyframes dr-bob {",
    "      0%   { transform: translateY(0); }",
    `      25%  { transform: translateY(-${BOB_AMPLITUDE}px); }`,
    "      50%  { transform: translateY(0); }",
    `      75%  { transform: translateY(${BOB_AMPLITUDE}px); }`,
    "      100% { transform: translateY(0); }",
    "    }",
    "    @keyframes dr-shadow {",
    `      0%   { transform: scale(${s0.scale}); opacity: ${rel(s0.opacity)}; }`,
    `      25%  { transform: scale(${s25.scale}); opacity: ${rel(s25.opacity)}; }`,
    `      50%  { transform: scale(${s50.scale}); opacity: ${rel(s50.opacity)}; }`,
    `      75%  { transform: scale(${s75.scale}); opacity: ${rel(s75.opacity)}; }`,
    `      100% { transform: scale(${s0.scale}); opacity: ${rel(s0.opacity)}; }`,
    "    }",
    `    .dr-bob { animation: dr-bob ${DUR}s ease-in-out infinite; }`,
    "    .dr-shadow {",
    "      transform-box: fill-box;",
    "      transform-origin: 50% 50%;",
    `      animation: dr-shadow ${DUR}s ease-in-out infinite;`,
    "    }",
    "    @media (prefers-reduced-motion: reduce) {",
    "      .dr-bob, .dr-shadow { animation: none; }",
    "    }",
    "  </style>",
  ].join("\n");
}

function hemAnimate(): string {
  const values = KEYFRAMES.map((t) => ghostBodyPath(t)).join(";");
  const keyTimes = KEYFRAMES.join(";");
  const keySplines = KEYFRAMES.slice(1)
    .map(() => SPLINE)
    .join(";");
  return [
    `        <animate attributeName="d" dur="${DUR}s" repeatCount="indefinite"`,
    `          calcMode="spline" keyTimes="${keyTimes}" keySplines="${keySplines}"`,
    `          values="${values}"/>`,
  ].join("\n");
}

export function renderAnimatedSvg(): string {
  // ghostGroup's <path> gets the SMIL child injected via bodyExtra by closing
  // the tag ourselves: pass an attribute-free extra, then splice the animate in.
  const group = ghostGroup(ghostBodyPath(0), "dr").replace(
    /(<path d="[^"]*" fill="url\(#dr-body\)")\/>/,
    `$1>\n${hemAnimate()}\n      </path>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}"` +
      ` width="${CANVAS}" height="${CANVAS}" role="img" aria-label="DeskRAG">`,
    ghostDefs("dr"),
    css(),
    deskRect(),
    shadowEl("dr", ' class="dr-shadow"'),
    '  <g class="dr-bob">',
    group,
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

export function main(): void {
  writeFileSync(join(assetsDir, "deskrag-ghost.svg"), renderAnimatedSvg());
  console.log("brand: wrote deskrag-ghost.svg");
}
```

- [ ] **Step 4: Wire it into the runner**

In `scripts/brand/index.ts`, add the import and call:

```ts
import { main as emitStatic } from "./emit-static.js";
import { main as emitSvg } from "./emit-svg.js";

emitStatic();
emitSvg();
```

- [ ] **Step 5: Generate and test**

```bash
npm run gen:brand
npx vitest run test/brand.assets.test.ts
```
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify the animation visually**

Run: `open assets/deskrag-ghost.svg`
Expected: the ghost bobs up and down over 3 seconds; its hem ripples left-to-right; the shadow beneath tightens as it rises. The motion loops with no visible jump at the seam.

If the hem "pops" at the loop point, `ghostBodyPath(1)` is not equal to `ghostBodyPath(0)` — the Task 1 test covers this, so re-run `npx vitest run test/brand.geometry.test.ts`.

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add scripts/brand/emit-svg.ts scripts/brand/index.ts assets/deskrag-ghost.svg test/brand.assets.test.ts
git commit -m "feat(brand): animated ghost SVG for the READMEs

CSS bob + shadow, SMIL hem morph. Same 3s loop and easing as the Lottie,
both generated from the same geometry."
```

---

### Task 4: Lottie emitter

The app's animation. Hand-rolled bodymovin v5 JSON, verified in a real `lottie-web` player before it goes anywhere near the app.

**Files:**
- Create: `scripts/brand/emit-lottie.ts`
- Create (generated): `assets/deskrag-ghost.lottie.json`
- Create (temporary, not committed): a scratch HTML harness
- Modify: `scripts/brand/index.ts`, `test/brand.assets.test.ts`, `app/package.json`

**Interfaces:**
- Consumes: `geometry.js` (Task 1); `assetsDir` from `emit-static.js` (Task 2).
- Produces: `renderLottie(): string` (pretty-printed JSON, newline-terminated), `main(): void`.

- [ ] **Step 1: Install lottie-web in the app workspace**

```bash
npm --workspace deskrag-app install lottie-web@^5.12.2
```

Expected: `lottie-web` appears under `"dependencies"` in `app/package.json`. It must be a **dependency**, not a devDependency — the renderer bundle needs it at runtime.

- [ ] **Step 2: Write the failing test**

Append to `test/brand.assets.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/brand.assets.test.ts`
Expected: FAIL — cannot resolve `../scripts/brand/emit-lottie.js`.

- [ ] **Step 4: Write the emitter**

Create `scripts/brand/emit-lottie.ts`:

```ts
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
    {
      ty: "gr",
      nm: "face-group",
      it: [...eyeShapes, fill(palette.face), fit()],
    },
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
```

- [ ] **Step 5: Wire it into the runner**

`scripts/brand/index.ts` becomes:

```ts
import { main as emitStatic } from "./emit-static.js";
import { main as emitSvg } from "./emit-svg.js";
import { main as emitLottie } from "./emit-lottie.js";

emitStatic();
emitSvg();
emitLottie();
```

- [ ] **Step 6: Generate and test**

```bash
npm run gen:brand
npx vitest run test/brand.assets.test.ts
```
Expected: PASS, 16 tests.

- [ ] **Step 7: Verify the Lottie in a real player**

This is the step that catches a structurally-valid-but-visually-wrong Lottie. Write the harness to the scratch directory (it is **not** committed):

```bash
SCRATCH="$(ls -d /private/tmp/claude-*/*/*/scratchpad 2>/dev/null | head -1)"; SCRATCH="${SCRATCH:-/tmp}"
cat > "$SCRATCH/lottie-check.html" <<'HTML'
<!doctype html>
<body style="margin:0;display:flex;gap:24px;background:#0f1216">
  <div id="dark" style="width:256px;height:256px"></div>
  <div id="light" style="width:256px;height:256px;background:#fff"></div>
  <script src="LOTTIE_JS"></script>
  <script>
    fetch("ANIM_JSON").then(r => r.json()).then(data => {
      for (const id of ["dark", "light"]) {
        lottie.loadAnimation({
          container: document.getElementById(id),
          renderer: "svg", loop: true, autoplay: true, animationData: data,
        });
      }
    });
  </script>
</body>
HTML
python3 - "$SCRATCH/lottie-check.html" "$PWD" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); root = sys.argv[2]
p.write_text(p.read_text()
  .replace("LOTTIE_JS", f"file://{root}/node_modules/lottie-web/build/player/lottie_light.min.js")
  .replace("ANIM_JSON", f"file://{root}/assets/deskrag-ghost.lottie.json"))
PY
open "$SCRATCH/lottie-check.html"
```

Expected in the browser: two ghosts — one on the app's dark background, one on white — each bobbing over 3 seconds with a rippling hem and a shadow that tightens as it rises. Both must be legible.

**If the ghost renders as a filled blob or the hem tears**, the shape keyframes are wrong. Check the browser console for lottie errors, then re-check that `ghostBodyBezier`'s `i`/`o` arrays are ordered to match `v` (Task 1 defines the traversal: bottom-left → left shoulder → apex → right shoulder → bottom-right → right cusp → left cusp).

**If `fetch` is blocked by the `file://` origin**, serve the directory instead: `npx --yes serve -l 877 .` from the repo root, then open `http://localhost:877/` and load the harness from there.

- [ ] **Step 8: Confirm it matches the SVG twin**

Open `assets/deskrag-ghost.svg` beside the Lottie harness. The two must read as the same animation — same bob height, same rhythm, same shadow behaviour. If they differ, one emitter is misreading `geometry.ts`; fix the emitter, never the asset.

- [ ] **Step 9: Commit**

```bash
npm run typecheck
git add scripts/brand/emit-lottie.ts scripts/brand/index.ts assets/deskrag-ghost.lottie.json test/brand.assets.test.ts app/package.json package-lock.json
git commit -m "feat(brand): animated ghost as bodymovin v5 Lottie

Generated from the same geometry as the SVG twin, with a drift guard and a
constant-vertex-count invariant test (mismatched counts are how hand-rolled
Lottie shape morphs break)."
```

---

### Task 5: Icon emitter

Raster icons for the dock, the tray, and packaged builds.

**Files:**
- Create: `scripts/brand/emit-icons.ts`
- Create (generated): `app/build/icon.png`, `app/build/icon.icns`, `app/build/icon.ico`, `app/build/tray/trayTemplate.png`, `app/build/tray/trayTemplate@2x.png`
- Modify: `scripts/brand/index.ts`

**Interfaces:**
- Consumes: `geometry.js` (Task 1); `renderMark`, `ghostGroup`, `ghostDefs` from `emit-static.js` (Task 2).
- Produces: `renderTrayMark(): string`, `packIco(pngs: { size: number; data: Buffer }[]): Buffer`, `main(): Promise<void>`.

**Note:** this emitter is macOS-only (it shells out to `iconutil`). Its outputs are committed, so contributors on other platforms never need to run it. It is deliberately **not** covered by the drift guard — rasterisation output varies with the installed libvips/librsvg version, so byte-comparing PNGs would fail across machines.

- [ ] **Step 1: Write the emitter**

Create `scripts/brand/emit-icons.ts`:

```ts
/**
 * Rasterises the mark into the icon set: app icon (png/icns/ico) and the
 * menu-bar tray template.
 *
 * macOS-only — `.icns` is produced by the system `iconutil`. The outputs are
 * committed, so packaging never requires running this. Not covered by the drift
 * guard: rasterisation varies with the installed libvips/librsvg version.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { assetsDir, ghostDefs, ghostGroup } from "./emit-static.js";
import { CANVAS, ghostBodyPath, palette } from "./geometry.js";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, "../../app/build");

/**
 * The tray mark: ghost silhouette only, solid black on transparent. macOS
 * template images must be black + alpha; the OS inverts them for a dark menu
 * bar. The desk bar is dropped — it is illegible at 16px.
 */
export function renderTrayMark(): string {
  const body = ghostBodyPath(0);
  const mono = ghostGroup(body, "tray")
    .replace('fill="url(#tray-body)"', 'fill="#000000"')
    .replace(new RegExp(palette.face, "g"), "#FFFFFF");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}"` +
      ` width="${CANVAS}" height="${CANVAS}">`,
    ghostDefs("tray"),
    "  <g>",
    mono,
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

/**
 * Packs PNGs into an ICO container: a 6-byte header, a 16-byte directory entry
 * per image, then the payloads. Too small a format to warrant a dependency.
 */
export function packIco(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const dirSize = 16 * pngs.length;
  let offset = header.length + dirSize;
  const entries: Buffer[] = [];
  for (const png of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(png.size >= 256 ? 0 : png.size, 0); // 0 means 256
    e.writeUInt8(png.size >= 256 ? 0 : png.size, 1);
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const rasterise = (svg: string, size: number): Promise<Buffer> =>
  sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();

const ICNS_SET: { name: string; size: number }[] = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

export async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(
      "emit-icons requires macOS (iconutil). The generated icons are committed, " +
        "so this only needs to run when the mark changes.",
    );
  }

  mkdirSync(buildDir, { recursive: true });
  mkdirSync(join(buildDir, "tray"), { recursive: true });

  const markSvg = readFileSync(join(assetsDir, "deskrag-mark.svg"), "utf8");

  writeFileSync(join(buildDir, "icon.png"), await rasterise(markSvg, 1024));

  const iconset = join(buildDir, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const { name, size } of ICNS_SET) {
    writeFileSync(join(iconset, name), await rasterise(markSvg, size));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });

  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoPngs: { size: number; data: Buffer }[] = [];
  for (const size of icoSizes) icoPngs.push({ size, data: await rasterise(markSvg, size) });
  writeFileSync(join(buildDir, "icon.ico"), packIco(icoPngs));

  const traySvg = renderTrayMark();
  writeFileSync(join(buildDir, "tray/trayTemplate.png"), await rasterise(traySvg, 16));
  writeFileSync(join(buildDir, "tray/trayTemplate@2x.png"), await rasterise(traySvg, 32));

  console.log("brand: wrote app/build icons (png, icns, ico, tray)");
}
```

- [ ] **Step 2: Wire it into the runner**

`scripts/brand/index.ts` becomes:

```ts
import { main as emitStatic } from "./emit-static.js";
import { main as emitSvg } from "./emit-svg.js";
import { main as emitLottie } from "./emit-lottie.js";
import { main as emitIcons } from "./emit-icons.js";

emitStatic();
emitSvg();
emitLottie();
await emitIcons();
```

Top-level `await` is fine — the file is ESM and the package is `"type": "module"`.

- [ ] **Step 3: Generate the icons**

Run: `npm run gen:brand`
Expected: the four "brand: wrote …" lines, ending with the icons line.

- [ ] **Step 4: Verify the icons rendered, not blanked**

```bash
ls -l app/build app/build/tray
sips -g pixelWidth -g pixelHeight app/build/icon.png
open app/build/icon.png app/build/tray/trayTemplate@2x.png
```

Expected: `icon.png` is 1024×1024 and shows the full colour mark; `trayTemplate@2x.png` is a 32×32 solid-black ghost silhouette with **white eyes and mouth** on transparency, and no desk bar.

A fully transparent or fully black `icon.png` means `sharp` failed to resolve the gradients — confirm no `<filter>` crept into `deskrag-mark.svg` (the Task 2 test guards this).

- [ ] **Step 5: Verify the ICO is well-formed**

```bash
node -e "const b=require('fs').readFileSync('app/build/icon.ico');console.log('type',b.readUInt16LE(2),'count',b.readUInt16LE(4),'firstOffset',b.readUInt32LE(18))"
```
Expected: `type 1 count 6 firstOffset 102` (6 header bytes + 6×16 directory bytes).

- [ ] **Step 6: Commit**

```bash
npm run typecheck
npm test
git add scripts/brand/emit-icons.ts scripts/brand/index.ts app/build
git commit -m "feat(brand): rasterise app, tray, and packaging icons

sharp for SVG->PNG, system iconutil for .icns, a hand-rolled packer for .ico.
No new build dependencies. Tray art is a black+alpha template so macOS inverts
it for the menu bar."
```

---

### Task 6: Static mark in the app rail

**Files:**
- Create: `app/src/renderer/src/brand/GhostMark.tsx`, `app/src/renderer/src/brand/raw-assets.d.ts`
- Modify: `app/electron.vite.config.ts`, `app/tsconfig.json`, `app/src/renderer/src/App.tsx:33`, `app/src/renderer/src/styles.css:102-110`

**Interfaces:**
- Consumes: `assets/deskrag-mark.svg` (Task 2), via the new `@brand` alias and vite's `?raw` suffix.
- Produces: `GhostMark({ size?: number, className?: string }): React.JSX.Element` — inlined SVG, no network, no `<img>`, no CSP change.

- [ ] **Step 1: Add the `@brand` alias to vite**

In `app/electron.vite.config.ts`, inside the `renderer` block, extend `resolve.alias` and add `server`:

```ts
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared"),
        // Canonical brand assets live at the repo root so the library, the app,
        // and the READMEs all read one copy.
        "@brand": resolve(__dirname, "../assets"),
      },
    },
    server: {
      // assets/ sits outside the app's vite root; production builds resolve the
      // import fine, but the dev server refuses to serve it without this.
      fs: { allow: [resolve(__dirname, ".."), resolve(__dirname)] },
    },
  },
```

- [ ] **Step 2: Add the matching TypeScript path**

In `app/tsconfig.json`, extend `compilerOptions.paths`:

```json
    "paths": {
      "@/*": ["src/renderer/src/*"],
      "@shared/*": ["src/shared/*"],
      "@brand/*": ["../assets/*"]
    },
```

- [ ] **Step 3: Write the component**

Create `app/src/renderer/src/brand/GhostMark.tsx`:

```tsx
/**
 * The static DeskRAG mark.
 *
 * The SVG source is imported as raw text and inlined, rather than transcribed
 * into JSX — transcribing would fork the art away from geometry.ts, which is
 * exactly what this whole pipeline exists to prevent. Regenerate the source
 * with `npm run gen:brand` at the repo root.
 *
 * Inlined rather than used as an <img src>, so it needs no relaxation of the
 * renderer's Content-Security-Policy.
 */

import React from "react";
import markSvg from "@brand/deskrag-mark.svg?raw";

export function GhostMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={`brand-mark${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label="DeskRAG"
      // Build-time asset from this repo, not user content.
      dangerouslySetInnerHTML={{ __html: markSvg }}
    />
  );
}
```

**Note:** the generated SVG carries `width="256" height="256"`, so the wrapper's
CSS in Step 5 must force the inner `<svg>` to fill the span. The mark's gradient
ids (`dr-body`, `dr-shadow`) are document-global once inlined — fine for the
single rail instance, but a second `GhostMark` on the same screen would share
them. Do not add one without prefixing the ids first.

Create `app/src/renderer/src/brand/raw-assets.d.ts` so TypeScript understands the
`?raw` suffix:

```ts
declare module "*.svg?raw" {
  const contents: string;
  export default contents;
}
```

- [ ] **Step 4: Use it in the rail**

In `app/src/renderer/src/App.tsx`, add the import beside the existing icon import:

```tsx
import { GhostMark } from "./brand/GhostMark.js";
```

Replace line 33:

```tsx
        <div className="rail__brand">DESK·RAG</div>
```

with:

```tsx
        <div className="rail__brand">
          <GhostMark size={30} />
          <span className="rail__brand-word">DeskRAG</span>
        </div>
```

- [ ] **Step 5: Style it**

In `app/src/renderer/src/styles.css`, replace the `.rail__brand` rule (lines 102–110) with:

```css
.rail__brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 8px 0 18px;
}
.rail__brand-word {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--muted);
}
/* The generated SVG carries its own 256x256 width/height; override so the
   inlined mark fills whatever box GhostMark's `size` prop sets. */
.brand-mark {
  display: inline-flex;
}
.brand-mark > svg {
  width: 100%;
  height: 100%;
  display: block;
}
```

- [ ] **Step 6: Typecheck**

Run: `npm --workspace deskrag-app run typecheck`
Expected: no output (success).

- [ ] **Step 7: Verify in the running app**

Run: `npm run app:dev`
Expected: the left rail shows the ghost mark above a `DeskRAG` wordmark. The ghost must be crisp at 30px and clearly readable against the `#0f1216` rail — if the desk bar disappears at that size, that is expected and acceptable; the ghost is the identifying element.

Quit the app.

- [ ] **Step 8: Commit**

```bash
git add app/electron.vite.config.ts app/tsconfig.json app/src/renderer/src/brand/ app/src/renderer/src/App.tsx app/src/renderer/src/styles.css
git commit -m "feat(app): ghost mark in the rail brand

Adds a @brand alias to the repo-root assets/ so the app reads the canonical
art with no duplicated copy in git."
```

---

### Task 7: Animated ghost on busy and empty states

**Files:**
- Create: `app/src/renderer/src/brand/GhostLottie.tsx`, `app/src/renderer/src/brand/lottie-light.d.ts`
- Modify: `app/src/renderer/src/screens/RecordScreen.tsx`, `app/src/renderer/src/screens/SearchScreen.tsx`, `app/src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `assets/deskrag-ghost.lottie.json` (Task 4); `lottie-web` (installed in Task 4 Step 1); the `@brand` alias (Task 6).
- Produces: `GhostLottie({ size?: number, playing?: boolean, className?: string }): React.JSX.Element`.

- [ ] **Step 1: Declare types for the light build**

Create `app/src/renderer/src/brand/lottie-light.d.ts`:

```ts
// lottie-web ships types for its main entry but not for the light build's
// subpath. The light build has the same default export.
declare module "lottie-web/build/player/lottie_light" {
  import lottie from "lottie-web";
  export default lottie;
}
```

- [ ] **Step 2: Write the component**

Create `app/src/renderer/src/brand/GhostLottie.tsx`:

```tsx
/**
 * The animated DeskRAG ghost, played by lottie-web's light build.
 *
 * Honors prefers-reduced-motion: renders a single static frame rather than
 * looping. `playing={false}` also parks it on a static frame, so the same
 * component covers idle and busy states.
 */

import React, { useEffect, useRef } from "react";
import lottie from "lottie-web/build/player/lottie_light";
import type { AnimationItem } from "lottie-web";
import animationData from "@brand/deskrag-ghost.lottie.json";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function GhostLottie({
  size = 96,
  playing = true,
  className,
}: {
  size?: number;
  playing?: boolean;
  className?: string;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const anim = useRef<AnimationItem | null>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const reduced = prefersReducedMotion();
    const item = lottie.loadAnimation({
      container,
      renderer: "svg",
      loop: true,
      autoplay: false,
      animationData,
    });
    anim.current = item;
    if (reduced) item.goToAndStop(0, true);
    return () => {
      item.destroy();
      anim.current = null;
    };
  }, []);

  useEffect(() => {
    const item = anim.current;
    if (!item) return;
    if (playing && !prefersReducedMotion()) item.play();
    else item.goToAndStop(0, true);
  }, [playing]);

  return (
    <div
      ref={host}
      className={className}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
```

- [ ] **Step 3: Show it while indexing**

In `app/src/renderer/src/screens/RecordScreen.tsx`, add the import:

```tsx
import { GhostLottie } from "../brand/GhostLottie.js";
```

Then, in the `{busy && (` block, put the ghost above the progress row — replace:

```tsx
        <div className="indexing">
          <div className="indexing__row">
```

with:

```tsx
        <div className="indexing">
          <div className="indexing__ghost">
            <GhostLottie size={84} playing />
          </div>
          <div className="indexing__row">
```

- [ ] **Step 4: Show it on the empty search states**

In `app/src/renderer/src/screens/SearchScreen.tsx`, add the import:

```tsx
import { GhostLottie } from "../brand/GhostLottie.js";
```

Replace the no-matches block:

```tsx
            <div className="empty">
              <h3>No matches</h3>
              <p>Try different words, or record more sessions first.</p>
            </div>
```

with:

```tsx
            <div className="empty">
              <GhostLottie size={104} className="empty__ghost" playing />
              <h3>No matches</h3>
              <p>Try different words, or record more sessions first.</p>
            </div>
```

And the nothing-searched-yet block:

```tsx
        <div className="empty">
          <h3>Nothing searched yet</h3>
          <p>Record a session on the Record tab, then search for what you did.</p>
        </div>
```

with:

```tsx
        <div className="empty">
          <GhostLottie size={104} className="empty__ghost" playing />
          <h3>Nothing searched yet</h3>
          <p>Record a session on the Record tab, then search for what you did.</p>
        </div>
```

- [ ] **Step 5: Style the placements**

Append to `app/src/renderer/src/styles.css`:

```css
/* Brand ghost — animated only where it means something: the app is working
   (indexing) or there is nothing yet to show (empty states). */
.empty__ghost {
  margin: 0 auto 14px;
}
.indexing__ghost {
  display: flex;
  justify-content: center;
  margin-bottom: 10px;
}
```

- [ ] **Step 6: Typecheck**

Run: `npm --workspace deskrag-app run typecheck`
Expected: no output.

If it fails with `Cannot find module '@brand/deskrag-ghost.lottie.json'`, the Task 6 Step 2 `paths` entry is missing. If it fails with an implicit-`any` on the JSON import, `resolveJsonModule` is already `true` in `app/tsconfig.json` — check the path mapping resolves to a real file with `ls assets/deskrag-ghost.lottie.json`.

- [ ] **Step 7: Verify in the running app**

Run: `npm run app:dev`

Check all three placements:
1. **Search tab, before any query** — the ghost bobs above "Nothing searched yet".
2. **Search for something with no matches** — the ghost bobs above "No matches".
3. **Record tab** — start a short recording, stop it, and watch the indexing panel: the ghost bobs above the stage progress bar, and disappears when indexing completes.

Then verify reduced motion: **System Settings → Accessibility → Display → Reduce motion**, on. Restart the app. The ghost must render as a static frame — visible, not blank, not moving. Turn the setting back off.

Quit the app.

- [ ] **Step 8: Commit**

```bash
git add app/src/renderer/src/brand/ app/src/renderer/src/screens/RecordScreen.tsx app/src/renderer/src/screens/SearchScreen.tsx app/src/renderer/src/styles.css
git commit -m "feat(app): animated ghost on indexing and empty states

lottie-web light build, honoring prefers-reduced-motion by parking on a
static frame. Animated only where it signals state, not as decoration."
```

---

### Task 8: Tray, dock, and packaging icons

The tray is currently `nativeImage.createEmpty()` — a blank menu-bar icon. This task fixes that.

**Files:**
- Create: `app/electron-builder.yml`
- Modify: `app/src/main/index.ts:7` (imports), `:29-45` (window), `:101-105` (`createTray`), `:107+` (`whenReady`); `app/package.json`
- Uses: `app/build/*` from Task 5

**Interfaces:**
- Consumes: `app/build/icon.png`, `app/build/tray/trayTemplate.png`, `app/build/tray/trayTemplate@2x.png`.
- Produces: no new exports. `brandAsset(...segments): string` is a local helper in `index.ts`.

- [ ] **Step 1: Resolve the build assets from the main process**

In `app/src/main/index.ts`, below the existing `ERAG_AX_BIN` block (after line 28), add:

```ts
/**
 * Icons live in app/build/, outside the bundle. In dev the main bundle runs
 * from app/out/main; packaged, resources sit beside it. Try both.
 */
function brandAsset(...segments: string[]): string {
  const candidates = [
    join(__dirname, "../../build", ...segments),
    join(process.resourcesPath ?? "", "build", ...segments),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}
```

- [ ] **Step 2: Give the tray a real icon**

Replace `createTray` (lines 101–105):

```ts
function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.on("click", () => showWindow());
  rebuildTray();
}
```

with:

```ts
function createTray(): void {
  // A template image is black + alpha; macOS inverts it for the menu bar, so
  // one asset covers light and dark. Falls back to an empty image rather than
  // throwing if the generated icon is missing.
  const trayIcon = nativeImage.createFromPath(brandAsset("tray", "trayTemplate.png"));
  if (!trayIcon.isEmpty()) trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip("DeskRAG");
  tray.on("click", () => showWindow());
  rebuildTray();
}
```

- [ ] **Step 3: Set the window and dock icon**

In `createWindow`, add `icon` to the `BrowserWindow` options, immediately after `titleBarStyle`:

```ts
    icon: brandAsset("icon.png"),
```

And in the `app.whenReady().then(...)` body, immediately before `createWindow();`, add:

```ts
  // An unpackaged macOS dev run shows Electron's own dock icon otherwise.
  if (process.platform === "darwin" && app.dock) {
    const dockIcon = nativeImage.createFromPath(brandAsset("icon.png"));
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }
```

- [ ] **Step 4: Add the packaging config**

Create `app/electron-builder.yml`:

```yaml
appId: com.deskrag.app
productName: DeskRAG
directories:
  output: dist-app
  buildResources: build
files:
  - out/**/*
  - build/**/*
  - package.json
mac:
  icon: build/icon.icns
  category: public.app-category.productivity
win:
  icon: build/icon.ico
linux:
  icon: build/icon.png
  category: Utility
```

- [ ] **Step 5: Add electron-builder and the dist script**

```bash
npm --workspace deskrag-app install --save-dev electron-builder@^25.1.8
```

In `app/package.json`, add to `"scripts"` after `"build"`:

```json
    "dist": "electron-vite build && electron-builder --config electron-builder.yml",
```

And in the root `package.json`, add after `"app:build"`:

```json
    "app:dist": "npm run build && npm --workspace deskrag-app run dist",
```

- [ ] **Step 6: Ignore the packaging output**

Append to `.gitignore`:

```
app/dist-app/
```

- [ ] **Step 7: Verify the dev icons**

Run: `npm run app:dev`

Expected:
1. **Menu bar** — a ghost silhouette, not a blank gap. It must be dark on a light menu bar and light on a dark one (toggle **System Settings → Appearance** to check both).
2. **Dock** — the full colour DeskRAG mark, not the Electron logo.
3. Clicking the tray icon still shows the window; the tray menu still reflects recording state.

Quit the app.

- [ ] **Step 8: Verify the packaging config parses**

Run: `npm --workspace deskrag-app exec -- electron-builder --config electron-builder.yml --dir --mac`

Expected: electron-builder reads the config and reaches the packaging stage, producing `app/dist-app/mac*/DeskRAG.app`. Confirm the icon: `open app/dist-app` and look at the bundle in Finder.

**If it fails while collecting native modules** (`better-sqlite3`, `@lancedb/lancedb`, `sharp` are hoisted to the repo root and externalised), that is a **pre-existing packaging gap, not a regression from this task** — the app has never been packaged. Record the exact error in the commit message and move on; this task's deliverable is correct icon *configuration*, verified by steps 7 and by `icon.icns` existing and opening. Do not attempt to solve native-module packaging here.

- [ ] **Step 9: Commit**

```bash
npm --workspace deskrag-app run typecheck
git add app/src/main/index.ts app/electron-builder.yml app/package.json package.json package-lock.json .gitignore
git commit -m "feat(app): real tray, dock, and packaging icons

Replaces nativeImage.createEmpty() in the tray with a black+alpha template
image so macOS inverts it per menu-bar theme, sets the dock icon in dev, and
adds electron-builder config pointing at the generated icon set."
```

---

### Task 9: READMEs

**Files:**
- Modify: `README.md:1`, `app/README.md:1`

- [ ] **Step 1: Put the animated ghost atop the root README**

In `README.md`, replace line 1:

```markdown
# DeskRAG
```

with:

```markdown
<p align="center">
  <img src="assets/deskrag-ghost.svg" alt="DeskRAG" width="150" height="150">
</p>

<h1 align="center">DeskRAG</h1>
```

Leave the existing bolded tagline paragraph immediately below it unchanged.

- [ ] **Step 2: Put the static mark atop the app README**

In `app/README.md`, replace line 1:

```markdown
# DeskRAGApp
```

with:

```markdown
<p align="center">
  <img src="../assets/deskrag-mark.svg" alt="DeskRAGApp" width="112" height="112">
</p>

<h1 align="center">DeskRAGApp</h1>
```

- [ ] **Step 3: Document the regeneration command**

In `README.md`, in the **Repo layout** table, add a row after the `test/` row:

```markdown
| `assets/` | the brand mark — generated from `scripts/brand/geometry.ts` via `npm run gen:brand` |
```

- [ ] **Step 4: Verify the markdown renders**

Run: `open README.md` in a markdown previewer, or push the branch and view it on GitHub.

Expected on GitHub: the ghost appears centred above the title and **animates**. GitHub serves README images through its camo proxy; CSS and SMIL inside an `<img>`-referenced SVG normally survive it.

**If it renders static**, that is the known caveat from the spec. Do not work around it silently — report it, and the documented fallback is generating a GIF twin (a fifth emitter), which is explicitly out of scope for this plan and would be added on request.

- [ ] **Step 5: Full verification**

```bash
npm run typecheck
npm test
npm --workspace deskrag-app run typecheck
npm run gen:brand && git status --porcelain assets app/build
```

Expected: typecheck silent, full vitest suite green (including `brand.geometry` and `brand.assets`), app typecheck silent, and `git status` showing **no changes** after regeneration — proving the committed assets are exactly what the generator produces.

`app/build/*.png` may show as modified if the local libvips version differs from the one that produced the committed icons. That is expected and is why the drift guard excludes them; `git checkout app/build` to discard, or commit them if the icons genuinely improved.

- [ ] **Step 6: Commit**

```bash
git add README.md app/README.md
git commit -m "docs: lead both READMEs with the DeskRAG ghost mark"
```

---

## Verification checklist

Against the spec's own verification section:

1. `npm run gen:brand` regenerates all assets; `git diff` is empty on a clean tree — Task 9 Step 5.
2. `npm test` passes including the drift guard — Task 9 Step 5.
3. Both typechecks pass — Task 9 Step 5.
4. `npm run app:dev` shows the rail mark, the animated ghost on indexing and empty states, the tray icon, and the dock icon — Tasks 6 Step 7, 7 Step 7, 8 Step 7.
5. The mark is legible at small sizes and on light and dark — Task 5 Step 4, Task 4 Step 7 (dark/light side by side), Task 6 Step 7.
