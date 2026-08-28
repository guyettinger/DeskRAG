#!/usr/bin/env node
/**
 * How wide a keyframe has to reach the CAPTIONER — measured on this library,
 * with this model, against answers that were already on disk.
 *
 * Captioning is by far the most expensive stage in the pipeline: measured over
 * two real indexing runs it was 53.5% of all stage time, and the second pass
 * beside it (`app_caption`, now retired) was another 38.5%. The bill is paid in
 * IMAGE TOKENS — one caption cost 4113 prompt tokens at 2560px against 756 at
 * 896px, and the model is prompt-processing bound at roughly 25 tok/s — so the
 * stored width is the single biggest lever on how long indexing takes.
 *
 * `imageMaxWidth` cannot be that lever, because it belongs to something else:
 * ColModernVBERT's preprocessor upscales below 2048px and match quality degrades
 * with no visible error, which is why Settings banners the user to raise it to
 * 2560. Hence `captionMaxWidth`, and hence this probe — the question is not
 * "which is smaller" but AT WHAT WIDTH DOES THE CAPTION STOP SAYING THE THING
 * THE SEGMENT IS ABOUT.
 *
 * READ-ONLY: opens SQLite `readonly`, reads keyframe JPEGs, writes nothing but
 * stdout and a caption request to a local daemon. It registers no vector space,
 * writes no caption, and never touches Lance.
 *
 * It resizes with the REAL `sharpDownscaler` from `src/` and sends the REAL
 * `CAPTION_SYSTEM` / `captionPrompt()`, so the bytes and the words are the ones
 * `index-run.ts` sends. It deliberately does NOT call `OllamaCaptionProvider`,
 * for two reasons that both bite:
 *
 *   - It swallows every failure and returns `""` ("daemon down, model deleted,
 *     malformed response"), which is right for a pipeline that must not die on
 *     one frame and WRONG for a measurement: a timed-out call would score as a
 *     caption that recovered nothing, and the width would take the blame.
 *   - It returns a string. The bill is measured in PROMPT TOKENS, which only the
 *     raw `/api/chat` response carries.
 *
 * The call below therefore sends what the provider sends and reports what the
 * provider discards. It uses `node:http` rather than `fetch` because undici's
 * DEFAULT headersTimeout is 300s and cannot be raised without a dispatcher that
 * Node does not expose — measured: this probe crashed at frame 29 of 33 on a
 * caption slower than that, losing 28 completed frames. The shipped provider has
 * the same 300s ceiling and degrades to `""` there; on this store no caption has
 * hit it (0 empty of 367), but a 2560px caption measured 224s, so the margin was
 * thinner than the stage's own timings suggested.
 *
 * NO CONTEXT IS SENT, AND THAT IS THE WHOLE MEASUREMENT.
 *
 *   `CaptionRepresenter` calls `captioner.caption(bytes, seg.digest)`, and
 *   `captionPrompt(context)` splices that digest into the prompt. The digest is
 *   also this probe's ground truth -- so under the app's real configuration the
 *   model is SHOWN the answers and can emit them having read no pixels at all.
 *
 *   Measured, and it inverted the verdict: a run that scored fresh no-context
 *   captions against the STORED ones reported 1280px losing half the on-screen
 *   text. The stored captions were written with the digest in the prompt. The
 *   number was the context, not the width.
 *
 *   So every width here is captioned WITHOUT context, including the widest, and
 *   `stored` is refused as a width. What this measures is legibility: what the
 *   model can read off the image unaided. That makes it a CONSERVATIVE floor --
 *   a width that passes here passes in the app, which additionally hands the
 *   model the digest -- and it is the only form of the question that isolates
 *   the variable being swept.
 *
 * GROUND TRUTH, without hand-labelling anything:
 *
 *   Each segment's `digest` is templated from events, not from pixels: the
 *   focused app, the window title, the text actually typed, and the LABEL of
 *   what was clicked, resolved from the AX tree. Those strings were on the
 *   screen the keyframe shows, and they were recovered by a path that never saw
 *   the image. So "does the caption still contain them" is a real question with
 *   an answer known by construction, and it is exactly the property that decides
 *   whether a segment is findable: a caption that drops the app name and the
 *   button that was pressed is fast and useless.
 *
 *   It is a FLOOR, not a score. A caption legitimately describes things no
 *   digest knows, so a low recovery rate at every width means the ground truth
 *   was thin, not that the model failed — which is why the corpus is printed
 *   first and why a run with too few answers refuses to report.
 *
 * Usage:
 *   npm run build
 *   npm run probe:caption
 *   npm run probe:caption -- --widths 2560,1280,1024,896 --limit 12
 *   npm run probe:caption -- --model qwen3-vl:4b
 */
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { sharpDownscaler } from "../../src/represent/caption/sharp-downscale.js";
import { CAPTION_SYSTEM, captionPrompt } from "../../src/represent/caption/prompt.js";
import { arg, list, num, refuseBarePositionals } from "../lib/args.js";
import { DATA_DIR, openReadOnly, readSettings } from "../lib/paths.js";
import { seeded } from "../lib/rng.js";

// This probe's entire interface is flags, so it is one of the few that may
// refuse a bare positional. `scripts/lib/args.ts` carries the measurement.
refuseBarePositionals("npm run probe:caption -- --widths 2560,1920,1280 --limit 33");

const DATA = arg("data", DATA_DIR);
const LIMIT = num("limit", 10);
const SEED = num("seed", 7);
/**
 * Widths to run, and the pseudo-width `stored`.
 *
 * `stored` reads `segment.caption` — the caption the APP ALREADY WROTE, at
 * whatever `imageMaxWidth` was in force. It is the honest baseline and it is
 * free: re-captioning 33 frames at 2560px to reproduce text already on disk cost
 * 80 minutes the first time this probe was run, and produced captions that were
 * meant to be identical to the stored ones. It is the DEFAULT first entry for
 * that reason. Its latency column is blank, because there was no call to time,
 * and its provenance is disclosed rather than assumed — the store does not record
 * which model or which width wrote a caption, so a library re-indexed under a
 * different captioner would be comparing against that one.
 */
const RAW_WIDTHS = list("widths", ["2560", "1920", "1280"]);
const WIDTHS = RAW_WIDTHS.map(Number).filter((w) => Number.isFinite(w) && w > 0);

if (RAW_WIDTHS.some((w) => w === "stored")) {
  // Refused rather than supported: the stored caption was written WITH the
  // digest in its prompt (see the header), and the digest is this probe's
  // ground truth. Comparing a no-context run against it measures the context.
  console.error(
    "REFUSED: `stored` is not a width. The app captions with the segment's digest as\n" +
      "context, and that digest is this probe's ground truth -- a stored caption can carry\n" +
      "the answers having read no pixels. Sweep explicit widths, widest first; the widest\n" +
      "IS the control.",
  );
  process.exit(1);
}
if (WIDTHS.length < 2) {
  console.error("REFUSED: a sweep needs at least two widths -- the widest is the control.");
  process.exit(1);
}

/** The captioner the app is configured with, unless overridden. */
const settings = readSettings(DATA);
const HOST = arg("host", settings.providers?.ollamaHost ?? "http://localhost:11434");
const MODEL = arg("model", settings.providers?.ollamaCaptionModel ?? "qwen3-vl:4b");

/* --- corpus ---------------------------------------------------------------- */

const db = openReadOnly(join(DATA, "app.db"));

interface SegmentRow {
  segment_id: string;
  digest: string;
  caption: string | null;
  path: string;
  width: number;
  height: number;
}

/**
 * Every keyframe that has BOTH a blob on disk and a segment whose digest yields
 * at least one answer. Anything else cannot be scored, and padding the sample
 * with unscoreable frames would move the denominator without moving the signal.
 */
const rows = db
  .prepare(
    `SELECT s.id AS segment_id, s.digest, s.caption, b.path, f.width, f.height
       FROM segment s
       JOIN frame_segment fs ON fs.segment_id = s.id
       JOIN frame f          ON f.id = fs.frame_id
       JOIN blob b           ON b.id = f.blob_id
      WHERE s.granularity = 'action'
        AND s.digest IS NOT NULL
      ORDER BY s.t_mono_start`,
  )
  .all() as SegmentRow[];

/**
 * The strings a caption should still contain, in TWO CLASSES, reported apart, because they answer different questions and only
 * one of them decides the setting.
 *
 * `screen` — quoted spans: `clicked "Save"`, `typed "..."`. These are exact text
 * that was rendered somewhere on the display, often small, and a caption losing
 * them means the model can no longer READ THE SCREEN at this width. That is a
 * real loss, because no other view carries what a control said.
 *
 * `chrome` — the leading `App — Window Title`, split so an app name counts on
 * its own (a caption naming Calculator while paraphrasing the title is not a
 * miss). The digest carries these already,
 * independently, from events that never saw a pixel, and the digest is
 * concatenated into the SAME FTS row and embedded into its OWN dense lane. So a
 * caption declining to repeat a window title costs the index approximately
 * nothing. Collapsing the two classes into one percentage hides exactly this,
 * and would argue for a wider image on the strength of duplicated text.
 *
 * Anything under 3 characters is dropped from either class: a one-letter label
 * matches by accident in prose of 350 characters, and a ground truth that cannot
 * be missed measures nothing.
 */
type AnswerKind = "screen" | "chrome";
interface Answer {
  text: string;
  kind: AnswerKind;
}

function answersOf(digest: string): Answer[] {
  const screen = new Set<string>();
  for (const m of digest.matchAll(/"([^"]+)"/g)) {
    const t = (m[1] ?? "").trim();
    if (t.length >= 3) screen.add(t);
  }
  const chrome = new Set<string>();
  const head = digest.split(".")[0] ?? "";
  for (const part of head.split("—")) {
    const t = part.trim();
    if (t.length >= 3 && !screen.has(t)) chrome.add(t);
  }
  return [
    ...[...screen].map((text): Answer => ({ text, kind: "screen" })),
    ...[...chrome].map((text): Answer => ({ text, kind: "chrome" })),
  ];
}

const scoreable = rows
  .map((r) => ({ ...r, answers: answersOf(r.digest) }))
  .filter((r) => r.answers.length > 0 && existsSync(r.path));

/* --- the corpus, BEFORE any assertion -------------------------------------- */

console.log("caption width probe");
console.log(`  store          ${DATA}`);
console.log(`  captioner      ${MODEL} @ ${HOST}`);
console.log(`  widths         ${WIDTHS.join(", ")}px`);
console.log(`  action frames  ${rows.length} with a digest and a keyframe on disk`);
console.log(`  scoreable      ${scoreable.length} (their digest yields at least one answer)`);
const nOf = (kind: AnswerKind): number =>
  scoreable.reduce((n, r) => n + r.answers.filter((a) => a.kind === kind).length, 0);
console.log(
  `  answers        ${nOf("screen")} on-screen strings (typed / clicked) + ${nOf("chrome")} app and window titles`,
);

// Counted in SCREEN answers, because that is the only class the verdict reads.
// A corpus of 400 window titles and no clicked labels cannot say anything about
// width, and would otherwise sail past a frame-count check.
if (scoreable.length < 5 || nOf("screen") < 10) {
  console.error(
    `\nNOT A MEASUREMENT: ${scoreable.length} scoreable frames carrying ${nOf("screen")} on-screen ` +
      `strings. Record a session that TYPES and CLICKS something named, index it, and run this ` +
      `again — the verdict is read off that column, and with a handful of them the table below ` +
      `would be a coin flip wearing one.`,
  );
  process.exit(1);
}

/** Deterministic sampling, so two runs are comparable. */

/**
 * SCREEN-BEARING FRAMES FIRST, and this is not cherry-picking — it is sampling
 * from the population that can answer the question.
 *
 * The verdict reads the `screen` column, and on a real desktop library those
 * strings are sparse: measured here, 56 of 448 action segments carry a quoted
 * span, because most actions are a click on something the AX tree named and a
 * move. A uniform sample of 14 frames would draw one or two of them and decide
 * the width off three or four answers. Frames with no on-screen string are used
 * to fill the sample out — they still measure latency and titles honestly — but
 * they cannot move the column the verdict is read from, so they go last.
 */
const withScreen = scoreable.filter((r) => r.answers.some((a) => a.kind === "screen"));
const without = scoreable.filter((r) => !r.answers.some((a) => a.kind === "screen"));
const chosen = [];
for (const pool of [withScreen, without]) {
  if (chosen.length >= LIMIT || pool.length === 0) continue;
  const pick = seeded(pool.length, SEED);
  const taken = new Set();
  while (chosen.length < LIMIT && taken.size < pool.length) {
    const i = pick();
    if (taken.has(i)) continue;
    taken.add(i);
    const r = pool[i];
    if (r !== undefined) chosen.push(r);
  }
}
const sampledScreen = chosen.reduce(
  (n, r) => n + r.answers.filter((a) => a.kind === "screen").length,
  0,
);
console.log(
  `  sampled        ${chosen.length} frames (seed ${SEED}) — ${chosen.filter((r) => r.answers.some((a) => a.kind === "screen")).length} ` +
    `carry on-screen text, ${sampledScreen} such strings in total\n`,
);
if (sampledScreen < 10) {
  console.error(
    `NOT A MEASUREMENT: only ${sampledScreen} on-screen strings in the sample. Raise --limit ` +
      `(there are ${withScreen.length} frames that carry any) or record a session that types ` +
      `and clicks more.`,
  );
  process.exit(1);
}

/* --- the run --------------------------------------------------------------- */

/**
 * One caption call. Returns `{ failed: true }` rather than throwing, so a slow
 * or refused frame costs ONE frame instead of the whole sweep.
 *
 * `CALL_TIMEOUT_MS` is ours and is generous on purpose: the point of the probe
 * is that the widest width is slow, so a timeout tuned to the fast widths would
 * fail the very case under test and report it as a quality loss.
 */
const CALL_TIMEOUT_MS = 20 * 60 * 1000;

/** One width's run over the sample. */
interface WidthResult {
  width: number;
  failures: string[];
  scored: number;
  ms: number;
  promptTokens: number;
  outTokens: number;
  kb: number;
  screen: number;
  chrome: number;
  hit: Record<AnswerKind, number>;
  seen: Record<AnswerKind, number>;
  /** answer key -> whether this width recovered it, so a loss can be NAMED. */
  kept: Map<string, boolean>;
}

interface CaptionResult {
  ms: number;
  text: string;
  promptTokens: number;
  outTokens: number;
  /** Set when the call never returned a caption — NOT evidence about width. */
  failed?: string;
}

function caption(bytes: Uint8Array): Promise<CaptionResult> {
  const body = JSON.stringify({
    model: MODEL,
    stream: false,
    messages: [
      { role: "system", content: CAPTION_SYSTEM },
      {
        role: "user",
        content: captionPrompt(),
        images: [Buffer.from(bytes).toString("base64")],
      },
    ],
  });
  const u = new URL(`${HOST}/api/chat`);
  const t0 = Date.now();
  return new Promise<CaptionResult>((resolve) => {
    const done = (v: Omit<CaptionResult, "ms">): void => resolve({ ms: Date.now() - t0, ...v });
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              message?: { content?: string };
              prompt_eval_count?: number;
              eval_count?: number;
            };
            done({
              text: (j.message?.content ?? "").trim(),
              promptTokens: j.prompt_eval_count ?? 0,
              outTokens: j.eval_count ?? 0,
            });
          } catch {
            done({ failed: "malformed response", text: "", promptTokens: 0, outTokens: 0 });
          }
        });
      },
    );
    req.setTimeout(CALL_TIMEOUT_MS, () => {
      req.destroy();
      done({ failed: `no response in ${CALL_TIMEOUT_MS / 60000}m`, text: "", promptTokens: 0, outTokens: 0 });
    });
    req.on("error", (e) => done({ failed: e.message, text: "", promptTokens: 0, outTokens: 0 }));
    req.end(body);
  });
}

const results: WidthResult[] = [];
for (const width of WIDTHS) {
  const shrink = sharpDownscaler(width);
  let ms = 0;
  let promptTokens = 0;
  let outTokens = 0;
  let bytes = 0;
  const hit = { screen: 0, chrome: 0 };
  /** Calls that never returned a caption. Their answers are NOT scored. */
  const failures = [];
  const seen = { screen: 0, chrome: 0 };
  /** Answer -> whether this width recovered it, so a loss can be NAMED. */
  const kept = new Map();

  for (const row of chosen) {
    const raw = new Uint8Array(readFileSync(row.path));
    const sent = await shrink(raw);
    const r = await caption(sent);
    if (r.failed !== undefined) {
      // A frame the model never answered for is not evidence about the WIDTH.
      // Scoring it as a miss is how a probe blames a resize for a daemon.
      failures.push(`${row.segment_id}: ${r.failed}`);
      process.stderr.write("!");
      continue;
    }
    bytes += sent.length; // only frames that were SCORED reach the average
    ms += r.ms;
    promptTokens += r.promptTokens;
    outTokens += r.outTokens;
    const hay = r.text.toLowerCase();
    for (const a of row.answers) {
      seen[a.kind]++;
      const got = hay.includes(a.text.toLowerCase());
      if (got) hit[a.kind]++;
      // Delimited by "|" rather than a NUL byte: this file is read by people,
      // and a literal NUL is exactly what makes `grep` skip src/store/store.ts.
      // Neither a segment id nor a class name can contain one.
      kept.set(`${row.segment_id}|${a.kind}|${a.text}`, got);
    }
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  results.push({
    width,
    failures,
    scored: chosen.length - failures.length,
    ms,
    promptTokens: Math.round(promptTokens / Math.max(1, chosen.length - failures.length)),
    outTokens: Math.round(outTokens / Math.max(1, chosen.length - failures.length)),
    kb: Math.round(bytes / Math.max(1, chosen.length - failures.length) / 1024),
    screen: seen.screen > 0 ? hit.screen / seen.screen : 0,
    chrome: seen.chrome > 0 ? hit.chrome / seen.chrome : 0,
    hit,
    seen,
    kept,
  });
}

/* --- the table ------------------------------------------------------------- */

const base = results[0];
if (base === undefined) {
  console.error("no width produced a result");
  process.exit(1);
}
const pad = (s: unknown, n: number): string => String(s).padStart(n);

console.log(
  "\n  width   sent    prompt tok   out tok    per frame   vs base    READ SCREEN      repeated title",
);
console.log("  " + "-".repeat(96));
for (const r of results) {
  const per = (r.ms / Math.max(1, r.scored) / 1000).toFixed(1) + "s";
  const speedup = base.ms === 0 ? "—" : (base.ms / r.ms).toFixed(2) + "x";
  console.log(
    `  ${pad(r.width, 6)}  ${pad(r.kb + "KB", 6)}  ${pad(r.promptTokens, 10)}   ` +
      `${pad(r.outTokens, 7)}   ${pad(per, 9)}   ${pad(speedup, 9)}   ` +
      `${pad((r.screen * 100).toFixed(0) + "%", 5)} (${pad(r.hit.screen + "/" + r.seen.screen, 7)})   ` +
      `${pad((r.chrome * 100).toFixed(0) + "%", 5)} (${r.hit.chrome}/${r.seen.chrome})`,
  );
}
const failed = results.filter((r) => r.failures.length > 0);
if (failed.length > 0) {
  console.log(
    `\n  CALLS THAT NEVER ANSWERED — these frames are excluded from their width's score and\n` +
      `  from its per-frame time. A width is only comparable to another over the same frames,\n` +
      `  so read any row with failures as measured on a SMALLER sample, not as a worse caption:`,
  );
  for (const r of failed) {
    console.log(`    ${r.width}: ${r.failures.length} of ${chosen.length} — ${r.failures.join("; ")}`);
  }
}

/**
 * The verdict is a FLOOR against the widest width, never an absolute score.
 *
 * The widest run is the one the app used to do, so the question this probe
 * exists to answer is whether a narrower one loses anything RELATIVE TO IT —
 * an absolute recall of 60% at every width says the digest ground truth is thin,
 * which is a fact about the corpus and not about the width.
 */
console.log("");
/**
 * THE CONTROL HAS TO BE ABLE TO LOSE SOMETHING, and below seven answers it
 * cannot -- so the verdict is withheld rather than printed at low resolution.
 *
 * The verdict is a RATIO against the widest width, so its resolution is 1/n
 * where n is what the control actually recovered. The bands are 0.95 and 0.85,
 * and the smallest n for which any k/n lands between them is SEVEN (6/7 =
 * 0.857); at n <= 6 the MARGINAL band is unreachable and the verdict has only
 * two states it can ever print. At n = 1 -- which is what a run
 * whose --limit was eaten produced -- "reads 100% of the on-screen text the
 * 2560px did, SAFE" is a comparison of one string against one string, and it
 * reads exactly like a measurement.
 *
 * The timing columns above are unaffected and stay printed: latency needs no
 * ground truth, and it was corroborated independently against `index_job`.
 */
const VERDICT_MIN_ANSWERS = 7;
// `base.screen` is a RATIO; `base.hit.screen` is the COUNT the ratio's
// resolution comes from. Reading the ratio here would make the guard fire on
// every run that is not perfect, which is every run.
const baseAnswers = base.hit.screen;
if (baseAnswers === 0) {
  console.log(
    "  NO VERDICT: the widest width read none of the on-screen strings, so there is " +
      "nothing for a narrower one to lose. Check the captioner is answering at all.",
  );
} else if (baseAnswers < VERDICT_MIN_ANSWERS) {
  console.log(
    `  NO VERDICT ON CONTENT: the ${base.width}px control recovered ${baseAnswers} of ` +
      `${sampledScreen} on-screen strings, so the finest step this ratio can take is ` +
      `1/${baseAnswers} (${(100 / baseAnswers).toFixed(0)}%).\n` +
      `  The MARGINAL band between 85% and 95% is unreachable -- the verdict could only ` +
      `read SAFE or LOSES CONTENT. The LATENCY column above stands; the content column ` +
      `is not a measurement.\n` +
      `  Raise --limit (there are ${withScreen.length} frames that carry on-screen text) ` +
      `and remember the npm separator: npm run probe:caption -- --limit 33`,
  );
} else {
  for (const r of results.slice(1)) {
    // Judged on SCREEN ONLY. A title the caption stops repeating is already in
    // the digest, in the same FTS row and its own dense lane; text the model can
    // no longer read is carried by nothing else.
    const ratio = r.screen / base.screen;
    const verdict = ratio >= 0.95 ? "SAFE" : ratio >= 0.85 ? "MARGINAL" : "LOSES CONTENT";
    console.log(
      `  ${pad(r.width, 5)}px reads ${(ratio * 100).toFixed(0)}% of the on-screen text the ` +
        `${base.width}px did — ${verdict}` +
        (base.ms > 0 ? `, at ${(base.ms / r.ms).toFixed(1)}x the speed` : ""),
    );
    /**
     * WHAT was lost, not just how much — a percentage cannot be acted on.
     *
     * The distinction that decides the setting is whether the dropped strings
     * are things only the caption could carry (an on-screen expression, a
     * dialog's text) or things the DIGEST already carries independently. The
     * digest is concatenated into the same FTS row and embedded into its own
     * dense lane, so a caption declining to repeat a window title costs the
     * index nothing; a caption that can no longer read the screen costs it the
     * whole segment.
     */
    const lost = [...base.kept]
      .filter(([k, got]) => got && r.kept.get(k) === false && k.split("|")[1] === "screen")
      .map(([k]) => k.split("|").slice(2).join("|"));
    if (lost.length > 0) {
      const shown = [...new Set(lost)].slice(0, 8);
      console.log(
        `         dropped: ${shown.map((t) => JSON.stringify(t)).join(", ")}` +
          (lost.length > shown.length ? ` … and ${lost.length - shown.length} more` : ""),
      );
    }
  }
}
console.log(
  `\n  Ground truth is the DIGEST's own strings, recovered from events by a path that never\n` +
    `  saw the image. READ SCREEN is what decides the width: quoted text that was rendered\n` +
    `  somewhere on the display, carried by no other view. The title column is reported\n` +
    `  beside it and NOT judged -- the digest already carries those strings into the same\n` +
    `  FTS row and its own dense lane, so a caption that stops repeating them costs the\n` +
    `  index nothing. A caption legitimately says more than the digest; it must not say less.`,
);

db.close();
