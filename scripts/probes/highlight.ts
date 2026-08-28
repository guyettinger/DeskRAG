#!/usr/bin/env node
/**
 * Read-only calibration for patch highlights: sweep the relative floor over
 * real frames and real queries, and write an overlay per setting so the
 * numbers can be LOOKED AT.
 *
 * Read-only by construction: it opens SQLite readonly, opens the Lance table to
 * read, reads keyframe blobs, and writes only PNGs under --out.
 *
 * It calls the REAL `highlightsFrom` from src/ rather than reimplementing the
 * rule — a probe that calibrates its own copy of the algorithm calibrates
 * something the app does not run.
 *
 * The optional `answer` box (frame-space points, i.e. the same space as
 * frame.width/height) is what turns this from a picture into a count: a box is
 * a HIT if it overlaps it.
 *
 * Usage:
 *   npm run build
 *   npm run probe:highlight -- --frame <frameId> --query "probe mcp"
 *   npm run probe:highlight -- --set scripts/highlight-cases.json
 *   npm run probe:highlight -- --set scripts/highlight-cases.json --floors 0.6,0.7,0.8,0.9
 *
 * --set is a JSON array of { frameId, query, answer?: {x,y,w,h}, note?: string }.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import sharp from "sharp";
import { Tier2MultiVectorRetriever } from "../../src/retrieve/tier2-mv.js";
import type { Store } from "../../src/store/types.js";
import { arg, list } from "../lib/args.js";
import { colModernVBertFromSettings, patchTableName } from "../lib/onnx.js";
import { DATA_DIR, openReadOnly, readSettings } from "../lib/paths.js";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Case {
  frameId: string;
  query: string;
  answer?: Box;
  note?: string;
}

const DATA = arg("data", DATA_DIR);
const OUT = arg("out", ".probe/highlights");
const FLOORS = list("floors", ["0.6", "0.7", "0.75", "0.8", "0.85", "0.9"]).map(Number);
const setPath = arg("set");
const cases: Case[] =
  setPath !== undefined
    ? (JSON.parse(readFileSync(setPath, "utf8")) as Case[])
    : [{ frameId: arg("frame", ""), query: arg("query", "") }];
if (cases.length === 0 || !cases[0]?.frameId || !cases[0]?.query) {
  console.error("need --frame <id> --query <text>, or --set <file.json>");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const db = openReadOnly(join(DATA, "app.db"));
const settings = readSettings(DATA);
const provider = colModernVBertFromSettings(DATA, settings);

const tableName = patchTableName(provider);
const table = await (await lancedb.connect(join(DATA, "lance"))).openTable(tableName);
console.log(
  `provider ${settings.providers?.imageProvider} — ${tableName}, ` +
    `${await table.countRows()} frames indexed`,
);

const frameRow = db.prepare("SELECT width, height, blob_id FROM frame WHERE id = ?");
const blobRow = db.prepare("SELECT path FROM blob WHERE id = ?");
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** floor -> running totals across cases, so the sweep ends in one table. */
interface Totals {
  boxes: number;
  hits: number;
  cases: number;
  found: number;
}
const totals = new Map<number, Totals>(
  FLOORS.map((f) => [f, { boxes: 0, hits: 0, cases: 0, found: 0 }]),
);

for (const c of cases) {
  const frame = frameRow.get(c.frameId) as
    | { width: number; height: number; blob_id: string }
    | undefined;
  if (!frame) {
    console.error(`no frame ${c.frameId}`);
    continue;
  }
  const [row] = await table.query().where(`id = '${c.frameId}'`).limit(1).toArray();
  if (!row) {
    console.error(`no patches for ${c.frameId} in ${tableName}`);
    continue;
  }
  const patchList = (row as { patches: { length: number; get(i: number): number[] } }).patches;
  const patches: Float32Array[] = [];
  for (let i = 0; i < patchList.length; i++) patches.push(Float32Array.from(patchList.get(i)));

  const [q] = await provider.embedQueries([c.query]);
  if (q === undefined) continue;
  console.log(
    `\n${JSON.stringify(c.query)} on ${c.frameId}${c.note ? ` (${c.note})` : ""}\n` +
      `  ${frame.width}x${frame.height}, ${patches.length} patches, ` +
      `${q.contentIndices.length} of ${q.vectors.length} vectors are content`,
  );

  const jpeg = (blobRow.get(frame.blob_id) as { path: string } | undefined)?.path;
  for (const relativeFloor of FLOORS) {
    // The REAL rule, not a copy of it. `highlightsFrom` never touches the store.
    // The store is never read — `highlightsFrom` is pure — so an empty one is
    // honest about what this probe touches.
    const hits = new Tier2MultiVectorRetriever({} as Store, provider, {
      relativeFloor,
    }).highlightsFrom(
      c.frameId,
      q,
      patches,
      frame.width,
      frame.height,
    );
    const answerBox = c.answer;
    const onAnswer =
      answerBox === undefined ? null : hits.filter((h) => overlaps(h.bbox, answerBox)).length;
    const t = totals.get(relativeFloor);
    if (t === undefined) continue;
    t.boxes += hits.length;
    if (onAnswer !== null) {
      t.cases += 1;
      t.hits += onAnswer;
      if (onAnswer > 0) t.found += 1;
    }
    console.log(
      `  floor ${relativeFloor}: ${String(hits.length).padStart(2)} boxes` +
        (onAnswer === null ? "" : `, ${onAnswer} on the answer, ${hits.length - onAnswer} elsewhere`) +
        `  [${hits.map((h) => (h.strength ?? 0).toFixed(2)).join(" ")}]`,
    );

    if (!jpeg) continue;
    const W = 1280;
    const s = W / frame.width;
    const H = Math.round(frame.height * s);
    const rects = hits
      .map(
        (h) =>
          `<rect x="${h.bbox.x * s}" y="${h.bbox.y * s}" width="${h.bbox.w * s}" ` +
          `height="${h.bbox.h * s}" fill="rgba(255,194,75,${(0.3 * (h.strength ?? 0)).toFixed(2)})" ` +
          `stroke="#ffc24b" stroke-width="2"/>`,
      )
      .join("");
    const answer =
      answerBox === undefined
        ? ""
        : `<rect x="${answerBox.x * s}" y="${answerBox.y * s}" width="${answerBox.w * s}" ` +
          `height="${answerBox.h * s}" fill="none" stroke="#7c9cff" stroke-width="2" ` +
          `stroke-dasharray="6 4"/>`;
    const name = `${c.query.replace(/\W+/g, "_")}-${c.frameId.slice(-6)}-${relativeFloor}.png`;
    await sharp(jpeg)
      .resize(W, H)
      .composite([
        { input: Buffer.from(`<svg width="${W}" height="${H}">${answer}${rects}</svg>`), top: 0, left: 0 },
      ])
      .png()
      .toFile(join(OUT, name));
  }
}
db.close();

console.log("\nfloor  boxes  on-answer  cases-found");
for (const [floor, t] of totals) {
  console.log(
    `${floor.toFixed(2)}   ${String(t.boxes).padStart(5)}  ${String(t.hits).padStart(9)}  ` +
      `${t.found}/${t.cases}`,
  );
}
console.log(`\noverlays in ${OUT}`);
