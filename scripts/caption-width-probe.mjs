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
 * It uses the REAL adapters from `dist/` — `sharpDownscaler` and
 * `OllamaCaptionProvider`, the same objects `index-run.ts` builds — rather than
 * its own resize and its own fetch. A probe that measures its own copy of the
 * pipeline measures something the app does not run.
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
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DATA = arg("data", join(homedir(), "Library/Application Support/deskrag-app/DeskRAG"));
const LIMIT = Number(arg("limit", "10"));
const SEED = Number(arg("seed", "7"));
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
const WIDTHS = arg("widths", "stored,1280,1024,896")
  .split(",")
  .map((w) => w.trim())
  .map((w) => (w === "stored" ? "stored" : Number(w)))
  .filter((w) => w === "stored" || (Number.isFinite(w) && w > 0));

/** The captioner the app is configured with, unless overridden. */
const settingsPath = join(DATA, "settings.json");
const settings = existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, "utf8"))
  : {};
const HOST = arg("host", settings.providers?.ollamaHost ?? "http://localhost:11434");
const MODEL = arg("model", settings.providers?.ollamaCaptionModel ?? "qwen3-vl:4b");

const dist = (p) => import(`file://${join(process.cwd(), "dist", p)}`);
const { sharpDownscaler } = await dist("represent/caption/sharp-downscale.js");
const { CAPTION_SYSTEM, captionPrompt } = await dist("represent/caption/prompt.js");

/* --- corpus ---------------------------------------------------------------- */

const db = new Database(join(DATA, "app.db"), { readonly: true });

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
  .all();

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
function answersOf(digest) {
  const screen = new Set();
  for (const m of digest.matchAll(/"([^"]+)"/g)) {
    const t = m[1].trim();
    if (t.length >= 3) screen.add(t);
  }
  const chrome = new Set();
  const head = digest.split(".")[0] ?? "";
  for (const part of head.split("—")) {
    const t = part.trim();
    if (t.length >= 3 && !screen.has(t)) chrome.add(t);
  }
  return [
    ...[...screen].map((text) => ({ text, kind: "screen" })),
    ...[...chrome].map((text) => ({ text, kind: "chrome" })),
  ];
}

const needsStored = WIDTHS.includes("stored");
const scoreable = rows
  .map((r) => ({ ...r, answers: answersOf(r.digest) }))
  .filter((r) => r.answers.length > 0 && existsSync(r.path))
  // A frame with no stored caption cannot serve the `stored` baseline, and a
  // sample where the baseline is missing for half the rows is not a comparison.
  .filter((r) => !needsStored || (r.caption !== null && r.caption.trim().length > 0));

/* --- the corpus, BEFORE any assertion -------------------------------------- */

console.log("caption width probe");
console.log(`  store          ${DATA}`);
console.log(`  captioner      ${MODEL} @ ${HOST}`);
console.log(`  widths         ${WIDTHS.join(", ")}px`);
console.log(`  action frames  ${rows.length} with a digest and a keyframe on disk`);
console.log(`  scoreable      ${scoreable.length} (their digest yields at least one answer)`);
const nOf = (kind) =>
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
function seeded(n) {
  let s = SEED;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}
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
  const pick = seeded(pool.length);
  const taken = new Set();
  while (chosen.length < LIMIT && taken.size < pool.length) {
    const i = pick();
    if (taken.has(i)) continue;
    taken.add(i);
    chosen.push(pool[i]);
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

async function caption(bytes) {
  const t0 = Date.now();
  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
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
    }),
  });
  const j = await res.json();
  return {
    ms: Date.now() - t0,
    text: (j.message?.content ?? "").trim(),
    promptTokens: j.prompt_eval_count ?? 0,
    outTokens: j.eval_count ?? 0,
  };
}

const results = [];
for (const width of WIDTHS) {
  const shrink = width === "stored" ? null : sharpDownscaler(width);
  let ms = 0;
  let promptTokens = 0;
  let outTokens = 0;
  let bytes = 0;
  const hit = { screen: 0, chrome: 0 };
  const seen = { screen: 0, chrome: 0 };
  /** Answer -> whether this width recovered it, so a loss can be NAMED. */
  const kept = new Map();

  for (const row of chosen) {
    let r;
    if (shrink === null) {
      // No call: the app already made it. Nothing to time and nothing to send.
      r = { ms: 0, text: row.caption, promptTokens: 0, outTokens: 0 };
    } else {
      const raw = new Uint8Array(readFileSync(row.path));
      const sent = await shrink(raw);
      bytes += sent.length;
      r = await caption(sent);
    }
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
    ms,
    promptTokens: Math.round(promptTokens / chosen.length),
    outTokens: Math.round(outTokens / chosen.length),
    kb: Math.round(bytes / chosen.length / 1024),
    screen: seen.screen > 0 ? hit.screen / seen.screen : 0,
    chrome: seen.chrome > 0 ? hit.chrome / seen.chrome : 0,
    hit,
    seen,
    kept,
  });
}

/* --- the table ------------------------------------------------------------- */

const base = results[0];
const pad = (s, n) => String(s).padStart(n);

console.log(
  "\n  width   sent    prompt tok   out tok    per frame   vs base    READ SCREEN      repeated title",
);
console.log("  " + "-".repeat(96));
for (const r of results) {
  const stored = r.width === "stored";
  const per = stored ? "—" : (r.ms / chosen.length / 1000).toFixed(1) + "s";
  const speedup = stored || base.ms === 0 ? "—" : (base.ms / r.ms).toFixed(2) + "x";
  console.log(
    `  ${pad(r.width, 6)}  ${pad(stored ? "—" : r.kb + "KB", 6)}  ${pad(stored ? "—" : r.promptTokens, 10)}   ` +
      `${pad(stored ? "—" : r.outTokens, 7)}   ${pad(per, 9)}   ${pad(speedup, 9)}   ` +
      `${pad((r.screen * 100).toFixed(0) + "%", 5)} (${pad(r.hit.screen + "/" + r.seen.screen, 7)})   ` +
      `${pad((r.chrome * 100).toFixed(0) + "%", 5)} (${r.hit.chrome}/${r.seen.chrome})`,
  );
}
if (results[0].width === "stored") {
  console.log(
    `\n  BASELINE IS THE STORED CAPTION — what the app actually wrote, at whatever imageMaxWidth\n` +
      `  was in force. Free, and more faithful than re-captioning; but the store does not record\n` +
      `  which model or width produced it, so a library re-indexed under a different captioner\n` +
      `  would be compared against that one. It has no latency column because there was no call.`,
  );
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
if (base.screen === 0) {
  console.log(
    "  NO VERDICT: the widest width read none of the on-screen strings, so there is " +
      "nothing for a narrower one to lose. Check the captioner is answering at all.",
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
        `${base.width === "stored" ? "stored caption" : base.width + "px"} did — ${verdict}` +
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
