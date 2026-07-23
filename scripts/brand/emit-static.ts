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
  bezierToPath,
  bodyGradient,
  CANVAS,
  deskBar,
  eyes,
  GHOST_FIT,
  ghostBodyPath,
  mouthBezier,
  mouthWidth,
  palette,
  shadowEllipse,
  shadowGradient,
} from "./geometry.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo's canonical assets directory. */
export const assetsDir = join(here, "../../assets");

/** Gradients. Prefixed ids so an inlined mark cannot collide with page ids. */
export function ghostDefs(idPrefix: string): string {
  const bodyStops = bodyGradient.stops.map(
    (s) => `      <stop offset="${s.offset}" stop-color="${s.color}"/>`,
  );
  const shadowStops = shadowGradient.stops.map(
    (s) => `      <stop offset="${s.offset}" stop-color="${palette.shadow}" stop-opacity="${s.alpha}"/>`,
  );
  return [
    "  <defs>",
    `    <linearGradient id="${idPrefix}-body" x1="0" y1="0" x2="0" y2="1">`,
    ...bodyStops,
    "    </linearGradient>",
    `    <radialGradient id="${idPrefix}-shadow">`,
    ...shadowStops,
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
    `      <path d="${bezierToPath(mouthBezier(), false)}" fill="none" stroke="${palette.face}"` +
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
