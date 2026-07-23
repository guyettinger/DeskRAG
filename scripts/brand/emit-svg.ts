/**
 * Emits the animated ghost SVG used in the READMEs.
 *
 * CSS drives the bob and the shadow; SMIL drives the hem morph, because CSS
 * `d` animation is Chromium/WebKit-only while SMIL is portable.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assetsDir,
  deskRect,
  ghostDefs,
  ghostGroup,
  shadowEl,
} from "./emit-static.js";
import {
  CANVAS,
  FPS,
  FRAMES,
  bob,
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
  // Generate bob keyframes by sampling bob(t) at each keyframe phase.
  const bobKeyframes = KEYFRAMES.map((t) => {
    const percent = Math.floor(t * 100);
    const translateY = bob(t);
    // Use units only for non-zero values, and pad percentage to align braces.
    const unit = translateY === 0 ? "" : "px";
    const spaces = " ".repeat(4 - percent.toString().length);
    return `      ${percent}%${spaces}{ transform: translateY(${translateY}${unit}); }`;
  }).join("\n");
  return [
    "  <style>",
    "    @keyframes dr-bob {",
    bobKeyframes,
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
  // ghostGroup emits a self-closing <path>, but we need to inject the hem's SMIL
  // <animate> child. Splice it in by converting the self-closing tag to a full
  // opening tag and closing it after the animation element.
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
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "deskrag-ghost.svg"), renderAnimatedSvg());
  console.log("brand: wrote deskrag-ghost.svg");
}
