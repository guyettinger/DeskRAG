/**
 * Does the configured summary model return a partition the ladder can PARSE?
 *
 * THIS IS THE ONE PIPELINE FAILURE THAT LEAVES NO TRACE. `composeOneLevel`
 * catches everything a provider throws and falls back to `structuralRanges` +
 * `rollupText`, so a model answering in the wrong SHAPE produces no error, no
 * log line and no failed stage — only a rising `template` share in
 * `segment_summary`, which nothing watches. Measured on this library: the real
 * store held 100 `llm` / 4 `template` composed nodes, and a clone re-indexed
 * five days later on the same providers held 23 / 27. Nothing had broken; the
 * model had simply started answering `{start, summary}` — a correct single run,
 * unwrapped — instead of `{groups:[{start,summary},…]}`.
 *
 * IT CALLS THE REAL PROVIDER, and that is the whole point. A hand-rolled
 * /api/chat body measured nothing here: adding `options: { temperature: 0 }`
 * made the model deterministic, so ten calls returned ten byte-identical wrong
 * answers and the resulting "0/10" was a property of the harness, not a rate.
 * The shipped provider sends no `options`, so the model runs at its own default
 * temperature — the only condition under which "how often" has an answer.
 *
 * THE CHILDREN ARE REAL, INCLUDING THEIR `app`. `composePrompt` prefixes each
 * line with `[App] ` when the child has one, so children built with `app: null`
 * send a materially different prompt and the rate would not be the pipeline's.
 * `app`/`url` are resolved latest-at-or-before from the session's own events,
 * the same rule `ComposeRepresenter.leafChildren` uses.
 *
 * READ-ONLY: SQLite opened `readonly`, chat requests to the local daemon, and
 * stdout. No segment, no summary, no vector — it never constructs a
 * `ComposeRepresenter`, whose `represent()` DELETES the composed segments
 * before it starts.
 *
 * PRINTS THE CORPUS FIRST and refuses a block below `MIN_CHILDREN`: the answer
 * to a two-step block is one run starting at 0, which a model can get right
 * while failing every real one, so a rate measured there is not the pipeline's
 * either. The floor is picked, not swept.
 *
 *   npm run probe:compose
 *   npm run probe:compose -- --model qwen3.8:27b-mlx,muse-glimmer:30b-mlx --n 10
 */

import { OllamaSummaryProvider } from "../../src/embed/ollama-summary.js";
import type { ChildSummary, LevelKind } from "../../src/represent/compose/types.js";
import { arg, list, num, refuseBarePositionals } from "../lib/args.js";
import { note, ok, padEnd, padStart, summary } from "../lib/report.js";
import { DATA_DIR, DB_PATH, openReadOnly, readSettings } from "../lib/paths.js";

refuseBarePositionals("npm run probe:compose -- --model qwen3.8:27b-mlx --n 10");

/** Below this the partition is trivial and the rate is not the pipeline's. Picked, unswept. */
const MIN_CHILDREN = 4;

const N = num("n", 10);
const COUNT = num("children", 12);
const KIND = arg("kind", "task") as LevelKind;

const settings = readSettings(DATA_DIR);
const configured = settings.providers?.ollamaSummaryModel;
const host = settings.providers?.ollamaHost;
const MODELS = list("model", configured === undefined ? [] : [configured]);
if (MODELS.length === 0) {
  console.error(
    "No `--model` and no `ollamaSummaryModel` in settings — there is no subject to measure.",
  );
  process.exit(1);
}

interface SegRow {
  digest: string | null;
  caption: string | null;
  t_mono_start: number;
  t_mono_end: number;
  session_id: string;
}
interface EvRow {
  t_mono: number;
  kind: string;
  data: string | null;
}

const db = openReadOnly(DB_PATH);
const rows = db
  .prepare(
    `SELECT digest, caption, t_mono_start, t_mono_end, session_id FROM segment
      WHERE granularity='action'
        AND session_id=(SELECT session_id FROM segment WHERE granularity='action' LIMIT 1)
      ORDER BY t_mono_start LIMIT ?`,
  )
  .all(COUNT) as SegRow[];

const first = rows[0];
if (first === undefined) {
  console.error(`No level-0 segments in ${DB_PATH} — record and index a session first.`);
  db.close();
  process.exit(1);
}

const events = db
  .prepare(
    `SELECT t_mono, kind, data FROM event
      WHERE session_id = ? AND kind IN ('focus_change','url_change') ORDER BY t_mono`,
  )
  .all(first.session_id) as EvRow[];
db.close();

/** The `ComposeRepresenter.leafChildren` rule: latest event at or before the child's start. */
const latestAtOrBefore = (kind: string, tMono: number, field: string): string | null => {
  let found: string | null = null;
  for (const e of events) {
    if (e.t_mono > tMono) break;
    if (e.kind !== kind) continue;
    const v = (JSON.parse(e.data ?? "null") as Record<string, unknown> | null)?.[field];
    if (typeof v === "string" && v.length > 0) found = v;
  }
  return found;
};

const origin = first.t_mono_start;
const children: ChildSummary[] = rows.map((r, i) => ({
  index: i,
  text: r.caption ?? r.digest ?? "segment",
  app: latestAtOrBefore("focus_change", r.t_mono_start, "app"),
  url: latestAtOrBefore("url_change", r.t_mono_start, "url"),
  startSec: (r.t_mono_start - origin) / 1000,
  endSec: (r.t_mono_end - origin) / 1000,
  barrier: false,
}));

const withApp = children.filter((c) => c.app !== null).length;

console.log("CORPUS");
console.log(`  store            ${DB_PATH}`);
console.log(`  host             ${host ?? "(default)"}`);
console.log(`  configured model ${configured ?? "(none in settings)"}`);
console.log(`  models measured  ${MODELS.join(", ")}`);
console.log(`  session          ${first.session_id}`);
console.log(`  children         ${children.length}, of which ${withApp} carry an [app] prefix`);
console.log(`  level            ${KIND}`);
console.log(`  calls per model  ${N}`);

if (children.length < MIN_CHILDREN) {
  console.error(
    `\nREFUSED: ${children.length} children is below the floor of ${MIN_CHILDREN}. The right\n` +
      "partition of a block this small is one run starting at 0, which a model can answer\n" +
      "correctly while failing every block the ladder actually sends. Index a longer session.",
  );
  process.exit(1);
}

/** `keys` identifies the SHAPE answered in, which is what distinguishes the failures. */
const keysOf = (body: string): string => {
  try {
    const o = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Record<
      string,
      unknown
    >;
    return Object.keys(o).sort().join("+") || "(empty)";
  } catch {
    return `(truncated) ${body.slice(0, 36)}`;
  }
};

interface Result {
  model: string;
  parsed: number;
  shapes: Map<string, number>;
  okMs: number[];
  failMs: number[];
}
const results: Result[] = [];

for (const model of MODELS) {
  const provider = new OllamaSummaryProvider(host === undefined ? { model } : { model, host });
  const r: Result = { model, parsed: 0, shapes: new Map(), okMs: [], failMs: [] };
  console.log(`\n${model}`);
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    try {
      const groups = await provider.compose(children, { kind: KIND });
      const ms = Date.now() - t0;
      r.parsed += 1;
      r.okMs.push(ms);
      r.shapes.set("groups (accepted)", (r.shapes.get("groups (accepted)") ?? 0) + 1);
      console.log(
        `  ${padStart(i + 1, 2)}: OK        ${groups.length} groups  ${(ms / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      const ms = Date.now() - t0;
      r.failMs.push(ms);
      const msg = e instanceof Error ? e.message : String(e);
      const keys = keysOf(msg.replace(/^Ollama compose returned an unparseable partition: /, ""));
      r.shapes.set(keys, (r.shapes.get(keys) ?? 0) + 1);
      console.log(`  ${padStart(i + 1, 2)}: REJECTED  ${keys}  ${(ms / 1000).toFixed(1)}s`);
    }
  }
  results.push(r);
}

const mean = (xs: number[]): string =>
  xs.length === 0 ? "—" : `${(xs.reduce((s, x) => s + x, 0) / xs.length / 1000).toFixed(1)}s`;

console.log("\nmodel                          parsed        ok time   reject time");
console.log("-".repeat(68));
for (const r of results) {
  console.log(
    `${padEnd(r.model, 30)} ${padStart(r.parsed, 2)}/${N} ` +
      `(${padStart(((r.parsed / N) * 100).toFixed(0), 3)}%) ${padStart(mean(r.okMs), 10)} ` +
      `${padStart(mean(r.failMs), 13)}`,
  );
}
for (const r of results) {
  console.log(`\n${r.model} reply shapes:`);
  for (const [k, n] of [...r.shapes].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${k}`);
}

console.log("");
// The VERDICT belongs to the model the app is configured with — that is the one whose
// rejections become `template` rows tonight. Anything else on the command line is a
// comparison, and a comparison gets a reading, never a pass/fail.
for (const r of results) {
  const detail = `${r.parsed}/${N} parsed, ${mean(r.failMs)} mean spent on rejects`;
  if (r.model === configured) {
    ok(
      `${r.model} returns a parseable partition every time`,
      r.parsed === N,
      detail,
      "every reject silently rolls its block up as `template` — compare models with --model",
    );
  } else {
    note(`${r.model} (not the configured model)`, detail);
  }
}
if (configured === undefined || !MODELS.includes(configured)) {
  note("no verdict", "the configured model was not among those measured");
}
summary("\n");
