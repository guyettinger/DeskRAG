/**
 * Rasterises the mark into the icon set: app icon (png/icns/ico) and the
 * menu-bar tray template.
 *
 * macOS-only — `.icns` is produced by the system `iconutil`. The outputs are
 * committed, so packaging never requires running this. Not covered by the drift
 * guard: rasterisation varies with the installed libvips/librsvg version.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderMark } from "./emit-static.js";
import {
  aperture,
  bezierToPath,
  CANVAS,
  eyes,
  GHOST_FIT,
  ghostBodyPath,
  mouthBezier,
  mouthWidth,
  workDots,
} from "./geometry.js";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, "../../../app/build");

/**
 * WHICH STATE THE GHOST'S FACE IS WEARING. Two independent axes, because
 * indexing and recording are independent: a stage already in flight keeps
 * running for a while after a capture starts, and a tray that arbitrated
 * between them would go quiet about one of the two.
 */
export type TrayFace = { capture: "idle" | "recording"; indexing: boolean };

/**
 * THE FOUR FACES AND THE FILE EACH IS WRITTEN TO — the array IS the emitted set,
 * so adding a state means adding a row here and nowhere else.
 *
 * The idle basename is unchanged (`trayTemplate`) so an app built before this
 * change still finds its icon. The runtime picks the same names through
 * `trayFaceAsset` in app/src/main/tray-face.ts, which cannot import this file;
 * `test/brand.assets.test.ts` asserts the two agree rather than trusting them to.
 */
export const TRAY_FACES: readonly { face: TrayFace; base: string }[] = [
  { face: { capture: "idle", indexing: false }, base: "trayTemplate" },
  { face: { capture: "recording", indexing: false }, base: "trayRecordingTemplate" },
  { face: { capture: "idle", indexing: true }, base: "trayIndexingTemplate" },
  { face: { capture: "recording", indexing: true }, base: "trayRecordingIndexingTemplate" },
] as const;

/**
 * The tray mark: ghost silhouette only, solid black on transparent. macOS
 * template images use only the alpha channel — colour is discarded and the
 * shape re-tinted to match the menu bar, so a "white" face is just as opaque
 * as a black body and would not read as knocked out. The face must instead be
 * genuinely transparent: an SVG mask, drawn in the same ghost-local space
 * GHOST_FIT places on the canvas, with the body in mask-white (keep) and the
 * face features in mask-black (cut away). The desk bar is dropped — it is
 * illegible at 16px.
 *
 * STATE IS CARRIED BY THE FACE AND BY NOTHING ELSE. The silhouette never
 * changes, so the mark stays one mark; what changes is what is cut out of it.
 * That is also the whole reason the tray no longer sets a title: a second glyph
 * beside the ghost said what the ghost could say itself.
 *
 * The pupil is the one place the mask paints white on top of black — mask-white
 * RESTORES ink, which is how a filled dot exists at all in a format that has
 * only alpha.
 */
export function renderTrayMark(
  face: TrayFace = { capture: "idle", indexing: false },
): string {
  const fit = `translate(${GHOST_FIT.tx} ${GHOST_FIT.ty}) scale(${GHOST_FIT.scale})`;
  const eyeRow =
    face.capture === "recording"
      ? [
          `        <circle cx="${aperture.cx}" cy="${aperture.cy}" r="${aperture.r}" fill="#000000"/>`,
          `        <circle cx="${aperture.cx}" cy="${aperture.cy}" r="${aperture.pupilR}" fill="#FFFFFF"/>`,
        ]
      : eyes.map(
          (e) => `        <ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="#000000"/>`,
        );
  // The aperture is wide enough to occupy the mouth row too, so the recording
  // face has no smile — it is ONE feature, which is what makes it read as a
  // different face rather than as the idle one with something added.
  const mouthRow =
    face.capture === "recording"
      ? []
      : [
          `        <path d="${bezierToPath(mouthBezier(), false)}" fill="none" stroke="#000000"` +
            ` stroke-width="${mouthWidth}" stroke-linecap="round"/>`,
        ];
  const bellyRow = face.indexing
    ? [-workDots.dx, 0, workDots.dx].map(
        (dx) =>
          `        <circle cx="${workDots.cx + dx}" cy="${workDots.cy}" r="${workDots.r}" fill="#000000"/>`,
      )
    : [];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}"` +
      ` width="${CANVAS}" height="${CANVAS}">`,
    "  <defs>",
    `    <mask id="tray-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${CANVAS}" height="${CANVAS}">`,
    `      <g transform="${fit}">`,
    `        <path d="${ghostBodyPath(0)}" fill="#FFFFFF"/>`,
    ...eyeRow,
    ...mouthRow,
    ...bellyRow,
    "      </g>",
    "    </mask>",
    "  </defs>",
    `  <rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="#000000" mask="url(#tray-mask)"/>`,
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

  const markSvg = renderMark();

  writeFileSync(join(buildDir, "icon.png"), await rasterise(markSvg, 1024));

  const iconset = join(buildDir, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const { name, size } of ICNS_SET) {
    writeFileSync(join(iconset, name), await rasterise(markSvg, size));
  }
  try {
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
  } finally {
    // Clean up scratch directory whether conversion succeeded or failed. Do not
    // swallow the error: if iconutil fails, the exception propagates so the build fails loudly.
    rmSync(iconset, { recursive: true, force: true });
  }

  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoPngs: { size: number; data: Buffer }[] = [];
  for (const size of icoSizes) icoPngs.push({ size, data: await rasterise(markSvg, size) });
  writeFileSync(join(buildDir, "icon.ico"), packIco(icoPngs));

  for (const { face, base } of TRAY_FACES) {
    const traySvg = renderTrayMark(face);
    writeFileSync(join(buildDir, `tray/${base}.png`), await rasterise(traySvg, 16));
    writeFileSync(join(buildDir, `tray/${base}@2x.png`), await rasterise(traySvg, 32));
  }

  console.log(
    `brand: wrote app/build icons (png, icns, ico, ${TRAY_FACES.length} tray faces)`,
  );
}
