/**
 * Does a real model actually write a reflection, into a real store, off a real
 * recording — and does the note stay OUT of the record?
 *
 * The root suite structurally cannot answer either question. `deskrag-service.ts`
 * imports electron so nothing in `test/` can construct the service; the stage
 * runner needs a `DualStore`; and the writer needs a daemon. The pure halves are
 * unit-tested (`test/reflection.test.ts`, `test/reflection-brief.test.ts`) and
 * this is the only check on the wiring between them — the same gap `probe:merge`
 * exists for, and the same gap that hid a version bump being computed and then
 * discarded.
 *
 * IT WRITES, so it writes to a COPY. The real `<userData>/DeskRAG` is cloned
 * (APFS copy-on-write, so `lance/` costs nothing) and the app is launched
 * against the clone, which is deleted at the end. The user's own library is
 * opened exactly once, by `cp`, and never by the app.
 *
 * CAPTIONS AND FRAME PATCHES ARE TURNED OFF IN THE CLONE, and that is disclosed
 * rather than quiet. Measured on the author's library, the three of them are
 * essentially the whole cost of a re-index — Captions 51m, App captions 50m,
 * Frame patches minutes-to-tens-of-minutes, and every other stage under five
 * seconds — and Reflecting reads NONE of them: it reads the composed steps.
 * Turning them off is what makes this check minutes rather than hours. It is a
 * property of the clone; the real settings are never touched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { launchApp } from "../.claude/skills/run-app/scripts/launch.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const REAL = join(homedir(), "Library", "Application Support", "deskrag-app", "DeskRAG");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) {
    failures += 1;
    process.exitCode = 1;
  }
  return cond;
};

if (!existsSync(join(REAL, "app.db"))) {
  console.log(`No library at ${REAL}. Record and index something first.`);
  process.exit(0);
}

function clone(src, dst) {
  try {
    execFileSync("cp", ["-Rc", src, dst]);
  } catch {
    execFileSync("cp", ["-R", src, dst]);
  }
}

const until = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
};

const root = mkdtempSync(join(tmpdir(), "deskrag-reflect-probe-"));
const data = join(root, "DeskRAG");
clone(REAL, data);
console.log(`Copied the library to ${data}`);
console.log("The real store is opened once, by cp, and never by the app.\n");

const { app, page } = await launchApp({ width: 1400, height: 1100, userDataDir: root });
let reflections = [];
let renderedSkills = [];
/**
 * Set when there is nothing to measure. NOT `process.exit()` — that skips
 * `finally`, which is what quits the app and deletes the clone, so an early
 * exit from inside the try would leave an Electron process holding a copy of
 * the user's library in /var/folders.
 */
let bail = null;

try {
  // --- what this is running against, BEFORE anything is asserted -------------
  const settings = await page.evaluate(async () => await window.deskrag.settings.get());
  const p = settings.providers;
  console.log("CONFIGURATION");
  console.log(`  summary provider   ${p.summaryProvider} / ${p.ollamaSummaryModel}`);
  console.log(`  ollama host        ${p.ollamaHost}`);
  console.log(`  caption provider   ${p.captionProvider} (about to be turned off IN THE CLONE)`);
  console.log(`  image provider     ${p.imageProvider} (about to be turned off IN THE CLONE)`);
  console.log("");

  if (p.summaryProvider === "none") {
    bail =
      "No summary model is configured, so there is nothing for this probe to measure —\n" +
      "a reflection is model-only by design. Configure one in Settings -> Providers.";
  }

  const sessions =
    bail === null ? await page.evaluate(async () => await window.deskrag.sessions.list()) : [];
  // The SMALLEST recording that still has something to compose. A reflection is
  // written over the composed steps, so the frame count is what costs time and
  // the step count is what makes the note meaningful.
  const target = [...sessions].sort((a, b) => (a.frameCount ?? 0) - (b.frameCount ?? 0))[0];
  if (bail === null && target === undefined) bail = "The library has no recordings.";

  if (bail === null) {
    await page.evaluate(
      async () =>
        await window.deskrag.settings.set({
          providers: { captionProvider: "none", imageProvider: "none" },
        }),
    );

    console.log(
      `Re-indexing ${target.id} (${target.frameCount} frames) in the clone. This runs a real model.\n`,
    );

    await page.evaluate(async (id) => await window.deskrag.indexing.reindexSession(id), target.id);

    const jobOf = async () => {
      const q = await page.evaluate(async () => await window.deskrag.indexing.queue());
      return q.jobs.find((j) => j.sessionId === target.id && j.kind === "reindex") ?? null;
    };

    // The stage has to be in the PREDICTED ladder before it has run anything —
    // that is `plannedFacts` and `stageWorld` agreeing, which is the pair that
    // can silently disagree.
    const queued = await until(jobOf, 30_000, "the job to appear");
    const planned = queued.stages.find((s) => s.id === "reflect");
    ok("the ladder plans a Reflecting stage", planned !== undefined);
    ok(
      "and does not mark it skipped, with a summary model configured",
      planned?.state !== "skipped",
      `state=${planned?.state}`,
    );

    const finished = await until(
      async () => {
        const j = await jobOf();
        if (j === null) return null;
        const st = j.stages.find((s) => s.id === "reflect");
        process.stdout.write(`\r  ${j.state} ${j.done}/${j.total} stages · reflect=${st?.state ?? "-"}    `);
        return j.state === "done" || j.state === "failed" ? j : null;
      },
      30 * 60_000,
      "the re-index to finish",
    );
    console.log("");

    const stage = finished.stages.find((s) => s.id === "reflect");
    ok("the job finished", finished.state === "done", finished.error ?? "");
    ok("Reflecting ran to done", stage?.state === "done", `state=${stage?.state}`);
    ok(
      "and its detail says what it read and who wrote it",
      typeof stage?.detail === "string" && /steps read, note written by /.test(stage.detail),
      stage?.detail ?? "(none)",
    );

    // The rendered skills, to prove the note did NOT reach one.
    const listed = await page.evaluate(async () => await window.deskrag.skills.list());
    renderedSkills = (listed?.skills ?? []).map((s) => s.markdown ?? "");
  }
} finally {
  await app.close();

  // Read the BYTES, not the row count. This is the whole point of the probe.
  try {
    const db = new Database(join(data, "app.db"), { readonly: true });
    reflections = db
      .prepare(
        `SELECT sr.segment_id AS segmentId, sr.source AS source, sr.text AS text,
                s.granularity AS granularity
           FROM session_reflection sr JOIN segment s ON s.id = sr.segment_id`,
      )
      .all();
    db.close();
  } catch (err) {
    console.log("could not read the clone:", err.message);
  }
}

if (bail !== null) {
  console.log(`\n${bail}`);
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

console.log("");
ok("a reflection landed in session_reflection", reflections.length > 0, `${reflections.length} row(s)`);

const note = reflections[0];
if (note !== undefined) {
  ok(
    "it hangs off the COMPOSED ROOT, which is what makes a purge reach it",
    note.granularity === "session",
    `granularity=${note.granularity}`,
  );
  ok(
    "its source names the MODEL, not 'llm'",
    /\S+ \S+/.test(note.source) && note.source !== "llm" && note.source !== "template",
    note.source,
  );
  for (const head of ["Goal:", "What worked:", "What stalled:", "A better order:"]) {
    ok(`the note carries "${head}"`, note.text.includes(head));
  }
  // A torn reply is rejected wholesale, so a stored note can never be a
  // fragment — every heading above is present or there is no row at all.
  ok("and is not an empty shell", note.text.replace(/\w+:/g, "").trim().length > 40);

  console.log("\n--- the note, as it was written ---");
  console.log(note.text);
  console.log("-----------------------------------\n");

  // THE SEAM. A reflection reaches a skill as an opinion in the PROMPT and never
  // as text in the file: `recordedBlocks()` takes the route and nothing else.
  const leaked = renderedSkills.filter((md) => md.includes(note.text.split("\n")[0]));
  ok(
    "and no rendered SKILL.md contains it — a note is prompt input, never record",
    leaked.length === 0,
    `${renderedSkills.length} skill(s) checked`,
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`Removed the clone.\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
