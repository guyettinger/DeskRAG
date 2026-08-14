#!/usr/bin/env node
/**
 * Read-only calibration for patch highlights: sweep the relative floor over
 * real frames and real queries, and write an overlay per setting so the
 * numbers can be LOOKED AT.
 *
 * Read-only by construction: it opens SQLite readonly, opens the Lance table to
 * read, reads keyframe blobs, and writes only PNGs under --out.
 *
 * It calls the REAL `highlightsFrom` from dist/ rather than reimplementing the
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
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Tier2MultiVectorRetriever } from "../dist/retrieve/tier2-mv.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sharp = require("sharp");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DATA = arg("data", join(homedir(), "Library/Application Support/deskrag-app/DeskRAG"));
const OUT = arg("out", ".probe/highlights");
const FLOORS = arg("floors", "0.6,0.7,0.75,0.8,0.85,0.9").split(",").map(Number);
const cases = arg("set")
  ? JSON.parse(readFileSync(arg("set"), "utf8"))
  : [{ frameId: arg("frame"), query: arg("query") }];
if (!cases.length || !cases[0].frameId || !cases[0].query) {
  console.error("need --frame <id> --query <text>, or --set <file.json>");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const db = new Database(join(DATA, "app.db"), { readonly: true });
const settings = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
const which = settings.providers.imageProvider;
if (which !== "colsmol" && which !== "colmodernvbert") {
  console.error(`imageProvider is "${which}" — this probe needs a late-interaction provider`);
  process.exit(1);
}

const modelDir = join(
  settings.providers.localModels?.dir || join(DATA, "models"),
  which === "colsmol" ? "colSmol-256M-dynamic" : "colmodernvbert-250m",
);
const provider = await (async () => {
  if (which === "colsmol") {
    const { ColSmolMultiVector } = await import("../dist/embed/onnx/colsmol.js");
    return new ColSmolMultiVector({
      modelPath: join(modelDir, "model.onnx"),
      tokenizerPath: join(modelDir, "tokenizer.json"),
    });
  }
  const { ColModernVBertMultiVector } = await import("../dist/embed/onnx/colmodernvbert.js");
  return new ColModernVBertMultiVector({
    modelPath: join(modelDir, "model.onnx"),
    tokenizerPath: join(modelDir, "tokenizer.json"),
  });
})();

const tableName = `frame_patches__${provider.id}__${provider.model}__${provider.dimensions}`;
const table = await (await lancedb.connect(join(DATA, "lance"))).openTable(tableName);
console.log(`provider ${which} — ${tableName}, ${await table.countRows()} frames indexed`);

const frameRow = db.prepare("SELECT width, height, blob_id FROM frame WHERE id = ?");
const blobRow = db.prepare("SELECT path FROM blob WHERE id = ?");
const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** floor -> running totals across cases, so the sweep ends in one table. */
const totals = new Map(FLOORS.map((f) => [f, { boxes: 0, hits: 0, cases: 0, found: 0 }]));

for (const c of cases) {
  const frame = frameRow.get(c.frameId);
  if (!frame) {
    console.error(`no frame ${c.frameId}`);
    continue;
  }
  const [row] = await table.query().where(`id = '${c.frameId}'`).limit(1).toArray();
  if (!row) {
    console.error(`no patches for ${c.frameId} in ${tableName}`);
    continue;
  }
  const patches = [];
  for (let i = 0; i < row.patches.length; i++) patches.push(Float32Array.from(row.patches.get(i)));

  const [q] = await provider.embedQueries([c.query]);
  console.log(
    `\n${JSON.stringify(c.query)} on ${c.frameId}${c.note ? ` (${c.note})` : ""}\n` +
      `  ${frame.width}x${frame.height}, ${patches.length} patches, ` +
      `${q.contentIndices.length} of ${q.vectors.length} vectors are content`,
  );

  const jpeg = blobRow.get(frame.blob_id)?.path;
  for (const relativeFloor of FLOORS) {
    // The REAL rule, not a copy of it. `highlightsFrom` never touches the store.
    const hits = new Tier2MultiVectorRetriever({}, provider, { relativeFloor }).highlightsFrom(
      c.frameId,
      q,
      patches,
      frame.width,
      frame.height,
    );
    const onAnswer = c.answer ? hits.filter((h) => overlaps(h.bbox, c.answer)).length : null;
    const t = totals.get(relativeFloor);
    t.boxes += hits.length;
    if (c.answer) {
      t.cases += 1;
      t.hits += onAnswer;
      if (onAnswer > 0) t.found += 1;
    }
    console.log(
      `  floor ${relativeFloor}: ${String(hits.length).padStart(2)} boxes` +
        (onAnswer === null ? "" : `, ${onAnswer} on the answer, ${hits.length - onAnswer} elsewhere`) +
        `  [${hits.map((h) => h.strength.toFixed(2)).join(" ")}]`,
    );

    if (!jpeg) continue;
    const W = 1280;
    const s = W / frame.width;
    const H = Math.round(frame.height * s);
    const rects = hits
      .map(
        (h) =>
          `<rect x="${h.bbox.x * s}" y="${h.bbox.y * s}" width="${h.bbox.w * s}" ` +
          `height="${h.bbox.h * s}" fill="rgba(255,194,75,${(0.3 * h.strength).toFixed(2)})" ` +
          `stroke="#ffc24b" stroke-width="2"/>`,
      )
      .join("");
    const answer = c.answer
      ? `<rect x="${c.answer.x * s}" y="${c.answer.y * s}" width="${c.answer.w * s}" ` +
        `height="${c.answer.h * s}" fill="none" stroke="#7c9cff" stroke-width="2" ` +
        `stroke-dasharray="6 4"/>`
      : "";
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
