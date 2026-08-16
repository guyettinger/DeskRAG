#!/usr/bin/env node
/**
 * Which text model actually retrieves better ON THIS CORPUS — measured, not
 * inferred from an MTEB column.
 *
 * Read-only by construction: opens SQLite `readonly`, reads model weights, and
 * writes nothing but stdout. It never touches Lance and never writes a vector.
 *
 * It runs the REAL adapters from `dist/` — `OnnxTextEmbedding` with the same
 * profile the app loads — rather than reimplementing the embedding call or
 * proxying through Ollama. A probe that measures its own copy of the pipeline
 * measures something the app does not run, and the two disagree in exactly the
 * places that matter here (task prefixes, which output tensor is read).
 *
 * GROUND TRUTH, without hand-labeling 849 segments:
 *
 *   Each segment has a `digest` (window title, URL, typed text, clicked labels
 *   — short, keyword-dense, ~68 chars here) and, independently, a `caption`
 *   (VLM prose describing the same moment). They are produced by different
 *   models from different inputs, so "find the segment whose digest belongs to
 *   this caption" is a real retrieval task whose answer is known by
 *   construction: the segment's own id.
 *
 *   That is also the task the user performs — describe a moment in words, get
 *   the moment back — which is why it is worth more than a synthetic set.
 *
 * A hand-written case file is supported too and is worth more per case; the
 * automatic lane exists because 120 free cases beat 8 laboured ones.
 *
 * Usage:
 *   npm run build
 *   npm run probe:embed
 *   npm run probe:embed -- --limit 200 --view digest
 *   npm run probe:embed -- --set scripts/embed-cases.json
 *
 * --set is a JSON array of { query, answerSegmentId, note? }.
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DATA = arg("data", join(homedir(), "Library/Application Support/deskrag-app/DeskRAG"));
const MODELS_DIR = arg("models-dir", join(DATA, "models"));
const VIEW = arg("view", "digest");
const LIMIT = Number(arg("limit", "150"));
const SEED = Number(arg("seed", "7"));
const CANDIDATES = arg("models", "nomic-embed-text-v1.5,embeddinggemma-300m").split(",");

const WEIGHTS = {
  "nomic-embed-text-v1.5": "model_int8.onnx",
  "embeddinggemma-300m": "model_quantized.onnx",
};

const { OnnxTextEmbedding } = await import(`file://${join(process.cwd(), "dist/embed/onnx/text.js")}`);
const { textProfile } = await import(`file://${join(process.cwd(), "dist/embed/text-profiles.js")}`);

/* --- corpus ---------------------------------------------------------------- */

const db = new Database(join(DATA, "app.db"), { readonly: true });

// Documents: every segment with text in the view under test. This is the whole
// haystack, not a sample — shrinking it would flatter every model equally but
// would stop measuring the thing that gets harder as a library grows.
const rows = db
  .prepare(
    `SELECT id, ${VIEW} AS text FROM segment
      WHERE ${VIEW} IS NOT NULL AND length(trim(${VIEW})) > 0`,
  )
  .all();

if (rows.length === 0) {
  console.error(`no segments have a non-empty ${VIEW} in ${DATA}`);
  process.exit(1);
}

/**
 * The haystack is DISTINCT TEXT, not segments — and this is load-bearing.
 *
 * Measured on LIB-14 (the author's 14-session library as of 2026-08-16, since
 * reset — see docs/internals/models.md): 750 segments carried a digest and 144
 * of them were distinct. One string ("Calculator — Calculator. 1 click. clicked
 * in Calculator.") appeared 85 times, because that is genuinely what happened 85
 * times. Scoring "did the model return this exact segment id" against 85
 * byte-identical documents caps top-1 at 1/85 for that query, and the first
 * run of this probe duly reported 1-3% top-1 and a 28.6% MRR "lift" that was
 * entirely noise off an unreachable ceiling.
 *
 * That store is gone, but the RATIO is not specific to it: a digest is a window
 * title plus a gesture, so any desktop corpus is mostly repeats. The header this
 * probe prints reports both counts every run, so the ratio you are actually
 * measuring against is never left implicit.
 *
 * Identical documents are ONE document. Ranking a tied duplicate is not an
 * error, so a hit is "the returned text equals the gold text", which restores
 * a reachable 100% and measures the question actually being asked: does the
 * model rank the right KIND of moment first.
 */
const byText = new Map();
for (const r of rows) {
  if (!byText.has(r.text)) byText.set(r.text, { text: r.text, ids: new Set() });
  byText.get(r.text).ids.add(r.id);
}
const docs = [...byText.values()];
/** segment id -> index of its text group, so a case's answer can be located. */
const groupOf = new Map();
docs.forEach((d, i) => d.ids.forEach((id) => groupOf.set(id, i)));

/** Deterministic sampling, so two runs of the probe are comparable. */
function seeded(n) {
  let s = SEED;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}

let cases;
if (arg("set")) {
  cases = JSON.parse(readFileSync(arg("set"), "utf8")).map((c) => ({
    query: c.query,
    answer: c.answerSegmentId,
    note: c.note,
  }));
} else {
  // Caption -> its own segment. Only segments that have BOTH a caption and the
  // view under test can be a case, since the answer must be in the haystack.
  const ids = groupOf;
  const pool = db
    .prepare(
      `SELECT id, caption FROM segment
        WHERE caption IS NOT NULL AND length(trim(caption)) > 0`,
    )
    .all()
    .filter((r) => ids.has(r.id));
  const rand = seeded(pool.length);
  const picked = new Map();
  for (let i = 0; i < LIMIT * 20 && picked.size < Math.min(LIMIT, pool.length); i++) {
    const r = pool[rand()];
    if (r) picked.set(r.id, r);
  }
  cases = [...picked.values()].map((r) => ({
    // Truncated: a full VLM caption is a paragraph, and a user types a sentence.
    query: r.caption.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").slice(0, 300),
    answer: r.id,
  }));
}

if (cases.length === 0) {
  console.error("no cases — need segments carrying both a caption and the view under test");
  process.exit(1);
}

/* --- scoring --------------------------------------------------------------- */

const cos = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // both sides are L2-normalized by the adapter
};

async function evaluate(model) {
  const dir = join(MODELS_DIR, model);
  const weights = join(dir, WEIGHTS[model] ?? "model_int8.onnx");
  if (!existsSync(weights)) return { model, skipped: `no weights at ${weights}` };

  const e = new OnnxTextEmbedding({
    modelPath: weights,
    tokenizerPath: join(dir, "tokenizer.json"),
    profile: textProfile(model),
  });

  const t0 = Date.now();
  const D = [];
  for (let i = 0; i < docs.length; i += 32) {
    const batch = docs.slice(i, i + 32);
    D.push(...(await e.embed(batch.map((d) => d.text), { role: "document" })));
  }
  const indexSec = (Date.now() - t0) / 1000;

  const t1 = Date.now();
  const Q = [];
  for (let i = 0; i < cases.length; i += 32) {
    const batch = cases.slice(i, i + 32);
    Q.push(...(await e.embed(batch.map((c) => c.query), { role: "query" })));
  }
  const querySec = (Date.now() - t1) / 1000;

  let top1 = 0;
  let top5 = 0;
  let mrr = 0;
  let margin = 0;
  for (let qi = 0; qi < cases.length; qi++) {
    const gold = groupOf.get(cases[qi].answer);
    if (gold === undefined) continue;
    const scored = docs.map((_, i) => cos(Q[qi], D[i]));
    const order = scored.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
    const rank = order.findIndex(([, i]) => i === gold);
    if (rank === 0) top1++;
    if (rank < 5) top5++;
    mrr += 1 / (rank + 1);
    // Positive = the right answer beat everything else; negative = it lost, and
    // by how much. A model can hold top-1 while its margin collapses.
    const best = order[0][1] === gold ? order[1][0] : order[0][0];
    margin += scored[gold] - best;
  }
  const n = cases.length;
  return {
    model,
    dims: D[0].length,
    top1: top1 / n,
    top5: top5 / n,
    mrr: mrr / n,
    margin: margin / n,
    indexSec,
    querySec,
  };
}

/* --- report ---------------------------------------------------------------- */

console.log(`corpus:  ${docs.length} distinct ${VIEW}s (from ${rows.length} segments)`);
console.log(
  `cases:   ${cases.length} ${arg("set") ? `hand-written (${arg("set")})` : "caption -> own segment"}`,
);
console.log(`models:  ${MODELS_DIR}\n`);
console.log("model                      dim   top1   top5    MRR   margin   index    query");
console.log("-".repeat(84));

const results = [];
for (const m of CANDIDATES) {
  const r = await evaluate(m);
  if (r.skipped) {
    console.log(`${m.padEnd(26)} SKIP — ${r.skipped}`);
    continue;
  }
  results.push(r);
  console.log(
    `${r.model.padEnd(26)} ${String(r.dims).padStart(4)} ` +
      `${(r.top1 * 100).toFixed(1).padStart(5)}% ${(r.top5 * 100).toFixed(1).padStart(5)}% ` +
      `${r.mrr.toFixed(3).padStart(6)} ${r.margin >= 0 ? "+" : ""}${r.margin.toFixed(3).padStart(6)} ` +
      `${r.indexSec.toFixed(1).padStart(6)}s ${r.querySec.toFixed(1).padStart(7)}s`,
  );
}

if (results.length > 1) {
  const [a, b] = results.sort((x, y) => y.mrr - x.mrr);
  const lift = ((b.mrr === 0 ? 0 : a.mrr / b.mrr - 1) * 100).toFixed(1);
  console.log(
    `\n${a.model} leads ${b.model} by ${lift}% MRR, at ` +
      `${(a.indexSec / b.indexSec).toFixed(1)}x the indexing cost.`,
  );
  console.log(
    "One corpus, one machine, one run. Switching the default strands every\n" +
      "text vector on disk, so treat a narrow win as no win.",
  );
}
db.close();
