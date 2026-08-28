/**
 * Watch a stage meter ADVANCE in the running app.
 *
 * The rest of the indexing checks can be taken against a finished job, where
 * every stage is `done` and no meter exists. This is the one that exercises the
 * thing the redesign exists for: a determinate bar, with a real count and a
 * measured rate, moving while a slow stage runs.
 *
 * Nothing in `npm test` can reach it. The suite has no renderer and no Electron,
 * the progress values originate inside `src/represent/*` loops, and they arrive
 * on a tick channel that only this screen subscribes to — so "the meter renders
 * and moves" is only answerable by driving the app.
 *
 * THIS RECORDS THE SCREEN for a few seconds. The recording lands in the real
 * library and indexes normally afterwards.
 */
import { launchApp, gotoScreen } from "../../../../scripts/lib/launch.js";

const out = (label, value) => console.log(`${String(label).padEnd(44)} ${value}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polled from node, never `page.waitForFunction(async …)` — see the skill doc. */
async function until(fn, { timeout = 60_000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

const RECORD_MS = Number(process.env["RECORD_MS"] ?? 8000);
const WATCH_MS = Number(process.env["WATCH_MS"] ?? 240_000);

const { app, page } = await launchApp();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  out(`${ok ? "PASS" : "FAIL"}  ${name}`, detail);
};

try {
  await gotoScreen(page, "Record");
  await page.waitForSelector(".recbtn", { timeout: 20_000 });

  console.log(`=== recording for ${RECORD_MS}ms ===`);
  await page.click(".recbtn");
  await page.waitForFunction(() => document.querySelector(".recbtn.is-live") !== null, {
    timeout: 20_000,
  });
  // Away from the Record screen while capturing: its readout displays
  // MILLISECONDS, so leaving it up changes every sampled frame and defeats
  // keyframe decimation entirely.
  await gotoScreen(page, "Indexing");
  await sleep(RECORD_MS);

  await gotoScreen(page, "Record");
  await page.click(".recbtn.is-live");
  await page.waitForFunction(() => document.querySelector(".recbtn.is-live") === null, {
    timeout: 30_000,
  });
  await gotoScreen(page, "Indexing");

  // Follow the RUNNING job, which is what the screen selects by default.
  await until(async () => (await page.evaluate(() => window.deskrag.indexing.queue())).runningJobId, {
    timeout: 60_000,
  });
  console.log("\n=== sampling the ladder while it indexes ===");

  /** Every distinct meter reading seen, in order. */
  const seen = [];
  const deadline = Date.now() + WATCH_MS;
  let done = false;
  while (Date.now() < deadline && !done) {
    const snap = await page.evaluate(() => {
      const q = document.querySelector(".stagenode--running");
      const fill = q?.querySelector(".stagemeter__fill") ?? null;
      const meter = q?.querySelector(".stagemeter") ?? null;
      const track = q?.querySelector(".stagemeter__track") ?? null;
      return {
        stage: q?.querySelector(".stagenode__name")?.textContent ?? null,
        kind: meter
          ? meter.classList.contains("stagemeter--indeterminate")
            ? "indeterminate"
            : "determinate"
          : null,
        count: q?.querySelector(".stagemeter__count")?.textContent ?? null,
        // The running row's CLOCK. The snapshot only rebuilds on transitions, so
        // this sat at "0ms" for a whole stage until the renderer got its own.
        clock: q?.querySelector(".stagenode__time")?.textContent ?? null,
        // MEASURED width, not the declared percentage: a fill that never grew
        // would still report the right style string.
        fillPx: fill ? Math.round(fill.getBoundingClientRect().width) : null,
        trackPx: track ? Math.round(track.getBoundingClientRect().width) : null,
        anyRunning: q !== null,
      };
    });
    const key = `${snap.stage}|${snap.kind}|${snap.count}|${snap.fillPx}|${snap.clock}`;
    if (snap.anyRunning && key !== seen[seen.length - 1]?.key) {
      seen.push({ key, ...snap });
      console.log(
        `   ${String(snap.stage).padEnd(20)} ${String(snap.kind).padEnd(14)} ` +
          `${String(snap.fillPx).padStart(4)}/${snap.trackPx}px  ` +
          `${String(snap.clock ?? "-").padStart(7)}  ${snap.count ?? ""}`,
      );
    }
    const q = await page.evaluate(() => window.deskrag.indexing.queue());
    if (q.runningJobId === null) done = true;
    await sleep(500);
  }

  console.log("\n=== what was observed ===");
  const determinate = seen.filter((s) => s.kind === "determinate");
  const indeterminate = seen.filter((s) => s.kind === "indeterminate");
  out("distinct meter readings", seen.length);
  out("determinate readings", determinate.length);
  out("indeterminate readings", indeterminate.length);

  check("a determinate meter was rendered", determinate.length > 0);
  check(
    "its count named a unit",
    determinate.some((s) => /\d+\/\d+ \w+/.test(s.count ?? "")),
    determinate[0]?.count ?? "",
  );

  // The bar MOVED. A fill stuck at one width is the defect a style-string
  // assertion cannot see — the playhead shipped exactly that way, moving one
  // pixel across a whole timeline and looking stationary.
  const widths = determinate.map((s) => s.fillPx).filter((w) => w !== null);
  const grew = widths.some((w, i) => i > 0 && w > widths[i - 1]);
  check("the fill actually GREW", grew, `widths ${widths.join(" -> ")}`);
  check(
    "no fill exceeded its track",
    determinate.every((s) => s.fillPx <= s.trackPx),
  );

  // A rate appears only once there is enough to measure — below two units or
  // two seconds it is withheld, which is the rail's 25 keys/s lesson.
  // The running row's clock must ADVANCE. It is rebuilt only on stage
  // transitions server-side, so without a renderer clock it reads 0ms forever.
  const clocks = seen.map((s) => s.clock).filter(Boolean);
  check("the running row's clock ADVANCED", new Set(clocks).size > 1, clocks.slice(0, 6).join(" -> "));

  const withRate = determinate.filter((s) => / · /.test(s.count ?? ""));
  out("readings carrying a rate", withRate.length);
  if (withRate.length > 0) out("example", withRate[withRate.length - 1].count);
  check(
    "no rate claimed before the floor",
    determinate
      .filter((s) => / · /.test(s.count ?? ""))
      .every((s) => {
        const done = Number((s.count ?? "").match(/^(\d+)\//)?.[1] ?? 0);
        return done >= 2;
      }),
  );

  check(
    "an indeterminate meter said WHY it has no count",
    indeterminate.length === 0 || indeterminate.every((s) => /cannot count/.test(s.count ?? "")),
    indeterminate[0]?.count ?? "(none seen)",
  );

  await page.screenshot({ path: process.env["SHOT"] ?? "/tmp/stage-meter.png" });
  console.log(`\nscreenshot -> ${process.env["SHOT"] ?? "/tmp/stage-meter.png"}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  await app.close();
}
