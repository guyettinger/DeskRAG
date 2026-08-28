#!/usr/bin/env node
/**
 * Read-only measurement of patch-highlight DISPLACEMENT: paint a marker at a
 * KNOWN frame-space centre, re-embed, and ask where the patch map says it is.
 *
 * This replaces a measurement that was taken once and thrown away. That one
 * painted a 320x240 rect and reported the top changed patches as "inside it or
 * within two patches of its edge" — but a patch cell is ~60x45 frame px, so two
 * patches is ~120px of slop, which cannot tell an exact mapping from one off by
 * half a cell. Containment is the wrong statistic. DISPLACEMENT is the right one:
 * it is signed, it is in cells, and each value of it names a different function.
 *
 *   |mean d| < 0.5 cell, no trend  -> geometry exact; the visible offset is the
 *                                    model's own 60x45px resolution
 *   mean d ~ +-0.5, consistent     -> centre-vs-corner error in cellToBox
 *   mean d ~ +-1.0, consistent     -> indexing error in patchIndexToCell
 *   |d| grows with distance        -> scale error (scaleX/scaleY, or a grid that
 *                                    disagrees with the embedder's)
 *
 * MEASURED 2026-08-14, 36 markers over two real frames of different aspect ratio
 * (1920x1080 and 1728x1117), two sizes x nine positions, real ColModernVBERT:
 *
 *   marker    argmax dcol/drow    centroid@8 dcol/drow    argmax
 *   1x1 (18)    +0.67 / -0.28        +1.86 / +0.06        exact cell 14/18
 *   2x2 (18)    +0.00 / -0.33        +0.30 / -0.07        contained  13/18
 *   slope of d against position: -0.06 col, -0.01 row cells/cell
 *
 * Read the 2x2 row: its truth sits BETWEEN cells, so +-0.5 is the best an integer
 * argmax can do, and its centroid is the number that means something — every
 * |mean| is under half a cell. The 1x1 argmax is exact 14 of 18 times (the four
 * misses all had a near-zero top delta: the marker landed on content it barely
 * changed), while its top-8 centroid is mostly noise because only ~1 patch
 * genuinely moves. No trend with position, so no scale error.
 *
 * CONCLUSION: the geometry is exact. A highlight that looks displaced is the
 * model's own 60x45px cell resolution and its broad attention, not a mapping bug.
 *
 * Read-only by construction: SQLite is opened readonly, blobs are only read, and
 * the only thing written is PNGs under --out. The real geometry is imported from
 * src/ rather than reimplemented — a probe that measures its own copy of the
 * mapping measures something the app does not run.
 *
 * Usage:
 *   npm run build
 *   npm run probe:patchgeom
 *   npm run probe:patchgeom -- --frames <id>,<id> --sizes 1,2 --topk 8
 *   npm run probe:patchgeom -- --no-overlays          # numbers only, much faster to eyeball
 *
 * With no --frames it picks one frame per distinct (width,height) in the store,
 * which is what makes a grid error separable from a centring error.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  cellToBox,
  computeTileGeometry,
  gridTokenCount,
  patchIndexToCell,
} from "../../src/embed/onnx/geometry.js";
import { arg, flag, list, num } from "../lib/args.js";
import { colModernVBertFromSettings } from "../lib/onnx.js";
import { DATA_DIR, openReadOnly } from "../lib/paths.js";

const DATA = arg("data", DATA_DIR);
const OUT = arg("out", ".probe/patchgeom");
const SIZES = list("sizes", ["1", "2"]).map(Number);
const TOPK = num("topk", 8);
const OVERLAYS = !flag("no-overlays");
/** Marker positions as fractions of the frame, snapped to cell centres below. */
const FRACTIONS = list("fractions", ["0.25", "0.5", "0.75"]).map(Number);

mkdirSync(OUT, { recursive: true });
const db = openReadOnly(join(DATA, "app.db"));
const provider = colModernVBertFromSettings(DATA);

interface FrameRow {
  id: string;
  width: number;
  height: number;
  blob_id: string;
}

/**
 * The frames to measure. One per distinct (width,height) unless named, because
 * two aspect ratios is what separates "the grid is wrong" from "the grid is
 * right and the map is shifted".
 */
const named = arg("frames");
const frames: FrameRow[] =
  named !== undefined
    ? named
        .split(",")
        .map(
          (id) =>
            db
              .prepare("SELECT id, width, height, blob_id FROM frame WHERE id = ?")
              .get(id.trim()) as FrameRow | undefined,
        )
        .filter((f): f is FrameRow => f !== undefined)
    : (db
        .prepare(
          `SELECT id, width, height, blob_id FROM frame f
          WHERE f.id = (SELECT id FROM frame g
                         WHERE g.width = f.width AND g.height = f.height
                         ORDER BY g.id LIMIT 1)`,
        )
        .all() as FrameRow[]);
if (frames.length === 0) {
  console.error("no frames");
  process.exit(1);
}
const blobRow = db.prepare("SELECT path FROM blob WHERE id = ?");

/**
 * Cosine, NORMALIZING — deliberately not shared with `embed`'s `cos`, which is
 * a bare dot product because its adapter L2-normalizes both sides. Merging the
 * two would silently change one probe's numbers.
 */
const cos = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let n = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) n += (a[i] ?? 0) * (b[i] ?? 0);
  return n; // both sides are L2-normalized by the provider
};

/** Every marker's result, so the aggregate is computed over frames together. */
interface MarkerRow {
  frameId: string;
  /** `2x2` — the marker's size in cells. */
  size: string;
  trueCol: number;
  trueRow: number;
  argCol: number;
  argRow: number;
  /** SIGNED displacement in cells. Each value names a different function. */
  dArgCol: number;
  dArgRow: number;
  dCentCol: number;
  dCentRow: number;
  /** Did the brightest cell land on a cell the marker actually covers? */
  contained: boolean;
  topDelta: number;
}
const rows: MarkerRow[] = [];

for (const frame of frames) {
  const jpegPath = (blobRow.get(frame.blob_id) as { path: string } | undefined)?.path;
  if (!jpegPath) {
    console.error(`frame ${frame.id}: no blob on disk`);
    continue;
  }
  const jpeg = readFileSync(jpegPath);
  const meta = await sharp(jpeg).metadata();

  // The geometry the HIGHLIGHTER uses: computed from the frame row's screen
  // points, not from the JPEG. That difference is the thing under test.
  const geo = computeTileGeometry(frame.width, frame.height);
  const cellW = (geo.tileSize / geo.tokenGrid) * geo.scaleX;
  const cellH = (geo.tileSize / geo.tokenGrid) * geo.scaleY;
  const gridCols = geo.cols * geo.tokenGrid;
  const gridRows = geo.rows * geo.tokenGrid;
  const gridCount = gridTokenCount(geo);
  // JPEG space vs frame space. The embedder tiles the JPEG; the marker is
  // specified in frame points, so it is painted through this factor.
  const jx = meta.width / frame.width;
  const jy = meta.height / frame.height;

  console.log(
    `\n=== ${frame.id}  frame ${frame.width}x${frame.height}  jpeg ${meta.width}x${meta.height}\n` +
      `    grid ${geo.cols}x${geo.rows} tiles -> ${gridCols}x${gridRows} cells of ` +
      `${cellW.toFixed(1)}x${cellH.toFixed(1)} frame px, ${gridCount} grid tokens`,
  );

  const [base] = await provider.embedImages([jpeg]);
  if (base === undefined || meta.width === undefined || meta.height === undefined) {
    console.error(`  frame ${frame.id}: no patches, or a JPEG with no dimensions`);
    continue;
  }
  if (base.length < gridCount) {
    console.error(
      `  patch count ${base.length} < grid ${gridCount} — geometry disagrees with the model`,
    );
    continue;
  }

  for (const cells of SIZES) {
    for (const fy of FRACTIONS) {
      for (const fx of FRACTIONS) {
        // Snap the marker to a whole number of cells so the truth is an INTEGER
        // cell coordinate and a fractional delta can only come from the mapping.
        const col0 = Math.min(
          Math.max(0, Math.round(fx * gridCols - cells / 2)),
          gridCols - cells,
        );
        const row0 = Math.min(
          Math.max(0, Math.round(fy * gridRows - cells / 2)),
          gridRows - cells,
        );
        const trueCol = col0 + (cells - 1) / 2;
        const trueRow = row0 + (cells - 1) / 2;

        const fxPx = col0 * cellW;
        const fyPx = row0 * cellH;
        const fwPx = cells * cellW;
        const fhPx = cells * cellH;

        const painted = await sharp(jpeg)
          .composite([
            {
              input: Buffer.from(
                `<svg width="${meta.width}" height="${meta.height}">` +
                  `<rect x="${fxPx * jx}" y="${fyPx * jy}" width="${fwPx * jx}" ` +
                  `height="${fhPx * jy}" fill="#ff00ff"/></svg>`,
              ),
              top: 0,
              left: 0,
            },
          ])
          .jpeg({ quality: 92 })
          .toBuffer();

        const [after] = await provider.embedImages([painted]);
        if (after === undefined) continue;

        const deltas: { p: number; d: number }[] = [];
        for (let p = 0; p < gridCount; p++) {
          deltas.push({ p, d: 1 - cos(base[p] ?? [], after[p] ?? []) });
        }
        deltas.sort((a, b) => b.d - a.d);
        const top = deltas[0];
        if (top === undefined) continue;

        const argmax = patchIndexToCell(top.p, geo);
        const k = Math.min(TOPK, deltas.length);
        let wsum = 0;
        let cSum = 0;
        let rSum = 0;
        for (let i = 0; i < k; i++) {
          const e = deltas[i];
          if (e === undefined) continue;
          const cell = patchIndexToCell(e.p, geo);
          if (!cell) continue;
          const w = Math.max(0, e.d);
          wsum += w;
          cSum += w * cell.col;
          rSum += w * cell.row;
        }
        const centCol = wsum > 0 ? cSum / wsum : NaN;
        const centRow = wsum > 0 ? rSum / wsum : NaN;

        const row: MarkerRow = {
          frameId: frame.id,
          size: `${cells}x${cells}`,
          trueCol,
          trueRow,
          argCol: argmax ? argmax.col : NaN,
          argRow: argmax ? argmax.row : NaN,
          dArgCol: (argmax ? argmax.col : NaN) - trueCol,
          dArgRow: (argmax ? argmax.row : NaN) - trueRow,
          dCentCol: centCol - trueCol,
          dCentRow: centRow - trueRow,
          // Did the brightest cell land on a cell the marker actually covers?
          contained:
            !!argmax &&
            argmax.col >= col0 &&
            argmax.col < col0 + cells &&
            argmax.row >= row0 &&
            argmax.row < row0 + cells,
          topDelta: top.d,
        };
        rows.push(row);
        console.log(
          `  ${row.size} @ cell (${trueCol},${trueRow})  argmax (${row.argCol},${row.argRow}) ` +
            `dArg (${fmt(row.dArgCol)},${fmt(row.dArgRow)})  ` +
            `dCentroid (${fmt(row.dCentCol)},${fmt(row.dCentRow)})  ` +
            `${row.contained ? "hit " : "miss"}  top delta ${top.d.toFixed(4)}`,
        );

        if (!OVERLAYS) continue;
        const W = 1280;
        const s = W / frame.width;
        const H = Math.round(frame.height * s);
        const boxes = deltas
          .slice(0, k)
          .map((e) => {
            const cell = patchIndexToCell(e.p, geo);
            return { box: cell === null ? null : cellToBox(cell, geo), d: e.d };
          })
          .filter((e): e is { box: NonNullable<typeof e.box>; d: number } => e.box !== null);
        const svg =
          `<svg width="${W}" height="${H}">` +
          boxes
            .map(
              (e) =>
                `<rect x="${e.box.x * s}" y="${e.box.y * s}" width="${e.box.w * s}" ` +
                `height="${e.box.h * s}" fill="rgba(255,194,75,${(
                  0.35 *
                  (e.d / top.d)
                ).toFixed(2)})" stroke="#ffc24b" stroke-width="1.5"/>`,
            )
            .join("") +
          `<rect x="${fxPx * s}" y="${fyPx * s}" width="${fwPx * s}" height="${fhPx * s}" ` +
          `fill="none" stroke="#7c9cff" stroke-width="2" stroke-dasharray="6 4"/></svg>`;
        await sharp(painted)
          .resize(W, H)
          .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
          .png()
          .toFile(join(OUT, `${frame.id.slice(-6)}-${cells}c-${col0}_${row0}.png`));
      }
    }
  }
}
db.close();

// Broken out by marker size, because the two carry different statistics. A 1x1
// marker's truth is an INTEGER cell, so its argmax delta is exact or it is not —
// but only ~1 patch genuinely changes, so most of a top-K centroid is noise. A
// 2x2 marker's truth sits between cells, so its argmax can only ever be +-0.5,
// and its centroid is the number that means something.
console.log(`\n${rows.length} markers`);
for (const size of [...new Set(rows.map((r) => r.size))]) {
  const g = rows.filter((r) => r.size === size);
  console.log(`  ${size} (${g.length}):`);
  report("    argmax   ", g.map((r) => r.dArgCol), g.map((r) => r.dArgRow));
  report(`    centroid@${TOPK}`, g.map((r) => r.dCentCol), g.map((r) => r.dCentRow));
  console.log(
    `    argmax containment ${g.filter((r) => r.contained).length}/${g.length}` +
      `, exact cell ${g.filter((r) => r.dArgCol === 0 && r.dArgRow === 0).length}/${g.length}`,
  );
}
console.log(`\nall markers:`);
report("  argmax   ", rows.map((r) => r.dArgCol), rows.map((r) => r.dArgRow));
report(`  centroid@${TOPK}`, rows.map((r) => r.dCentCol), rows.map((r) => r.dCentRow));
console.log(
  `  argmax containment: ${rows.filter((r) => r.contained).length}/${rows.length}`,
);

// A trend with position is what separates a scale error from a shift, so it is
// reported rather than left to be read off the per-marker lines.
/** Numeric columns of a marker row, so a key cannot name `size` by mistake. */
type NumericKey = {
  [K in keyof MarkerRow]: MarkerRow[K] extends number ? K : never;
}[keyof MarkerRow];

const trend = (key: NumericKey, truth: NumericKey): number => {
  const xs = rows.map((r) => r[truth]);
  const ys = rows.map((r) => r[key]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
    den += ((xs[i] ?? 0) - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
};
console.log(
  `slope of d against position: col ${fmt(trend("dCentCol", "trueCol"))} cells/cell, ` +
    `row ${fmt(trend("dCentRow", "trueRow"))} cells/cell  (0 = no scale error)`,
);
if (OVERLAYS) console.log(`\noverlays in ${OUT}`);

function mean(v: readonly number[]): number {
  return v.reduce((a, b) => a + b, 0) / (v.length || 1);
}
function sd(v: readonly number[]): number {
  const m = mean(v);
  return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
}
function fmt(n: number): string {
  return Number.isFinite(n) ? (n >= 0 ? "+" : "") + n.toFixed(2) : "  n/a";
}
function report(label: string, cols: readonly number[], rowsD: readonly number[]): void {
  console.log(
    `${label}  dcol mean ${fmt(mean(cols))} sd ${sd(cols).toFixed(2)}   ` +
      `drow mean ${fmt(mean(rowsD))} sd ${sd(rowsD).toFixed(2)}`,
  );
}
