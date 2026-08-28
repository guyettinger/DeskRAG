#!/usr/bin/env node
/**
 * WHAT THE MENU BAR ACTUALLY SHOWS, and what the tray can do without the window.
 *
 * Nothing else can answer either question. The suite has no Electron, and a
 * status item is not in any DOM — so the four faces, the fact that no text is
 * drawn beside them, and the whole start/stop-from-the-tray path were verifiable
 * only by reading the real menu bar and clicking the real menu. This does both:
 * it locates the status item through the accessibility API, screenshots it, and
 * drives its menu the way a person does.
 *
 * IT WRITES — it takes a real recording — so it writes to a COPY. The real
 * `<userData>/DeskRAG` is cloned (APFS copy-on-write, so `models/` costs
 * nothing), the app is launched against the clone, and the clone is deleted.
 * The real store is opened once, by `cp`, and never by the app.
 *
 * THE PIXEL CHECK IS MEASURED AGAINST THE COMMITTED FACE, and carries its own
 * control. A menu bar can be translucent, so two captures of the SAME face may
 * already differ; idle is therefore captured twice and a face change has to beat
 * its own noise. But beating the floor is only half of it — the other half is
 * that each face is compared against the number of pixels ITS OWN committed PNG
 * says it should move. Diffing `trayTemplate` against `trayIndexingTemplate` is
 * the design's own answer, so the threshold moves when `geometry.ts` moves and
 * is never a constant somebody picked.
 *
 * It was one, and it was wrong. A single absolute floor tuned on the recording
 * face failed the indexing one: three dots are a 3.4x smaller change than an
 * aperture (16 px against 54 at @2x), and the statistic it was measured with —
 * a mean over the whole captured rect — divided both by a crop that is mostly
 * menu bar. See `faceDiff`.
 *
 * It needs Accessibility (to read and click the status item) and Screen
 * Recording (to capture it) for whatever runs it. Both failures are reported as
 * failures, never skipped — a check that quietly measures nothing looks exactly
 * like one that found nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import "../lib/renderer-globals.js";
import { ROOT, launchApp } from "../lib/launch.js";
import { cloneLibrary } from "../lib/library-clone.js";
import { failureCount, note, ok } from "../lib/report.js";
import { sleep, until } from "../lib/wait.js";

const RECORD_MS = 6000;

const osa = (s: string): string =>
  execFileSync("osascript", ["-e", s], { encoding: "utf8" }).trim();

/** Poll, and treat a timeout as an ANSWER — see `until`'s `onTimeout`. */
const poll = <T>(fn: () => T | Promise<T>, timeout: number, every = 250): Promise<T | null> =>
  until(fn, { timeout, every, onTimeout: "null" });

const copy = cloneLibrary("deskrag-tray-probe");
if (copy === null) process.exit(0);
const root = copy.root;

// The captures OUTLIVE the clone on purpose: a width assertion cannot tell
// you whether a face is legible, and only a person looking can.
const shots = mkdtempSync(join(tmpdir(), "deskrag-tray-shots-"));

const BASES = [
  "trayTemplate",
  "trayRecordingTemplate",
  "trayIndexingTemplate",
  "trayRecordingIndexingTemplate",
];

const { app, page } = await launchApp({ userDataDir: root });

/** The status item's screen rect, via the accessibility API. */
const rectOf = (pid: number): string =>
  osa(`tell application "System Events" to tell (item 1 of (every process whose unix id is ${pid}))
  set b to menu bar item 1 of menu bar 2
  set {x, y} to position of b
  set {w, h} to size of b
  return (x as string) & "," & (y as string) & "," & (w as string) & "," & (h as string)
end tell`);

const menuLabels = (pid: number): string[] =>
  osa(`tell application "System Events" to tell (item 1 of (every process whose unix id is ${pid}))
  click menu bar item 1 of menu bar 2
  delay 0.4
  set acc to {}
  repeat with mi in menu items of menu 1 of menu bar item 1 of menu bar 2
    set end of acc to (name of mi as string)
  end repeat
  key code 53
  set AppleScript's text item delimiters to "\n"
  return acc as string
end tell`)
    .split("\n")
    // A separator's name is `missing value`; keep the slot so the ORDER of the
    // real items is still readable, but do not print it.
    .map((s) => (s.trim() === "missing value" ? "" : s.trim()));

const clickItem = (pid: number, label: string): string =>
  osa(`tell application "System Events" to tell (item 1 of (every process whose unix id is ${pid}))
  click menu bar item 1 of menu bar 2
  delay 0.4
  click menu item "${label}" of menu 1 of menu bar item 1 of menu bar 2
end tell`);

const shot = (rect: string, name: string): string => {
  const p = join(shots, `${name}.png`);
  execFileSync("screencapture", ["-x", `-R${rect}`, p]);
  return p;
};

/**
 * HOW MANY PIXELS MOVED, and by how much.
 *
 * A MEAN OVER THE CAPTURE IS THE WRONG STATISTIC, and it shipped a false FAIL.
 * The mean divides by the whole captured rect, so it measures the size of the
 * change RELATIVE TO THE CROP — and the crop is mostly menu bar: 68x48 px of
 * capture around a 32x32 icon. Two things then dilute it at once, and the
 * smaller face loses. Measured on one real run: the recording face read 1.365
 * and the indexing face 0.302, against a single absolute threshold of 0.5
 * calibrated on the recording face. So a correct indexing face FAILED.
 *
 * That is the same error `probe:patchgeom` records: "within two patches" is a
 * slop, DISPLACEMENT is a statistic. Here the statistic is the COUNT of pixels
 * that perceptibly moved, which does not shrink when the crop grows.
 *
 * `> 8` per channel is the perceptible floor. It is not tuned: the faces differ
 * by ink against transparency, so a changed pixel moves by a lot (measured max
 * deltas 197-236 against a threshold of 8) and a pixel that merely resampled
 * moves by a little. Nothing sits near the boundary.
 */
interface FaceDiff {
  /** Pixels where any channel moved by more than PERCEPTIBLE. */
  px: number;
  /** Kept for the log line only — never asserted on. See above. */
  mean: number;
  max: number;
}

const PERCEPTIBLE = 8;

async function faceDiff(a: string, b: string): Promise<FaceDiff> {
  const [x, y] = await Promise.all(
    [a, b].map((p) => sharp(p).raw().toBuffer({ resolveWithObject: true })),
  );
  if (x === undefined || y === undefined || x.data.length !== y.data.length) {
    return { px: Infinity, mean: Infinity, max: Infinity };
  }
  const { width, height, channels } = x.info;
  let px = 0;
  let sum = 0;
  let max = 0;
  for (let p = 0; p < width * height; p++) {
    let moved = false;
    for (let c = 0; c < channels; c++) {
      const i = p * channels + c;
      const d = Math.abs((x.data[i] ?? 0) - (y.data[i] ?? 0));
      sum += d;
      if (d > max) max = d;
      if (d > PERCEPTIBLE) moved = true;
    }
    if (moved) px += 1;
  }
  return { px, mean: sum / x.data.length, max };
}

/**
 * WHAT THE COMMITTED FACE PREDICTS — the threshold, derived rather than picked.
 *
 * Diffing the two PNGs `geometry.ts` emitted says exactly how many pixels this
 * face differs from idle by. That number is the design's own answer, it moves
 * automatically when the geometry moves, and it is what makes the assertion
 * below a comparison instead of a magic constant.
 *
 * Measured 2026-08-28 on the committed assets, @2x: recording 54 px, indexing
 * 16 px, recording+indexing 70 px — the indexing face is a 3.4x SMALLER change
 * than the recording one, which is precisely what one shared absolute floor
 * could not express. The real menu bar reproduced both counts EXACTLY (16 and
 * 54), so the share below is slack for tinting and clipping, not fudge.
 */
async function predictedDelta(face: string, scale: number): Promise<number> {
  const suffix = scale >= 2 ? "@2x" : "";
  const dir = join(ROOT, "app", "build", "tray");
  const { px } = await faceDiff(
    join(dir, `trayTemplate${suffix}.png`),
    join(dir, `${face}${suffix}.png`),
  );
  return px;
}

/**
 * The band the on-screen change has to land in, as a share of the prediction.
 *
 * A LOWER BOUND ALONE CANNOT TELL TWO FACES APART, and that is the whole
 * question here. "Enough pixels moved" is satisfied by the WRONG face just as
 * happily as the right one: the recording face moves 54 px, so it clears any
 * floor the 16 px indexing face could be given, and an app that showed the
 * aperture while indexing would have passed. The old mean check had the same
 * hole; having the prediction makes closing it free.
 *
 * Not 1.0 on either side. Below, because macOS tints a template image to match
 * the menu bar and a pixel at the edge of a dot can composite into the
 * background and stop counting. Above, because the two states are INDEPENDENT
 * axes — a recording that starts while an earlier job is still indexing legally
 * shows `trayRecordingIndexingTemplate`, which is 70 px against the recording
 * face's 54, and that must not read as a failure.
 *
 * The band still separates what it has to: [8, 32] for indexing excludes 54,
 * and [27, 108] for recording excludes 16. Measured twice at different status
 * item positions, both faces reproduced their prediction EXACTLY (16 and 54),
 * so every bit of this slack is for the two effects named above.
 */
const MIN_SHARE = 0.5;
const MAX_SHARE = 2;

try {
  const pid = await app.evaluate(() => process.pid);

  console.log("The four faces, as the app itself resolves them");
  const faces = await app.evaluate(
    ({ nativeImage }, ps) =>
      ps.map((p) => {
        const img = nativeImage.createFromPath(p);
        const s = img.getSize();
        return { empty: img.isEmpty(), template: img.isTemplateImage(), w: s.width, h: s.height };
      }),
    BASES.map((b) => join(ROOT, "app", "build", "tray", `${b}.png`)),
  );
  faces.forEach((f, i) => {
    ok(
      `${BASES[i]} loads as a ${f.w}x${f.h} template`,
      !f.empty && f.template && f.w === 16,
      f.empty ? "empty — the menu bar would show nothing" : "",
    );
  });

  // --- idle -------------------------------------------------------------
  const idleRect = rectOf(pid);
  const idleW = Number(idleRect.split(",")[2]);
  console.log(`\nThe status item, idle: ${idleRect} (x,y,w,h)`);
  const idleA = shot(idleRect, "idle-a");
  const idleB = shot(idleRect, "idle-b");
  const floor = await faceDiff(idleA, idleB);
  ok(
    "the capture is a real screenshot, not a blank",
    (await sharp(idleA).stats()).channels.some((c) => c.max > c.min),
    "",
    "flat image — grant Screen Recording to whatever runs this",
  );
  // The capture's scale decides WHICH committed face to predict from, and it is
  // read off the capture rather than assumed: a non-Retina display captures the
  // @1x asset, where the same faces differ by 8 and 18 px instead of 16 and 54.
  const captureW = (await sharp(idleA).metadata()).width;
  if (captureW === undefined) {
    throw new Error(`the idle capture has no dimensions — ${idleA} is not an image`);
  }
  const scale = captureW / idleW;
  note(
    "noise floor, two captures of the same face",
    `${floor.px} px moved` +
      (floor.px === 0 ? " — an opaque menu bar" : "") +
      `, at ${scale}x`,
  );

  const idleMenu = menuLabels(pid);
  console.log(`  menu: ${idleMenu.filter(Boolean).join(" / ")}`);
  ok("the menu opens with the status line first", idleMenu[0] === "Ready to record");
  ok(
    "the toggle comes before Open DeskRAG",
    idleMenu.indexOf("Start recording") < idleMenu.indexOf("Open DeskRAG"),
    idleMenu.filter(Boolean).join(" / "),
  );

  // --- start, from the tray, with the window on screen -------------------
  console.log("\nStarting the recording FROM THE TRAY");
  ok("the window is on screen before the click", await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isVisible()));
  clickItem(pid, "Start recording");

  const recording = await poll(
    async () =>
      (await page.evaluate(() => window.deskrag.recording.status())).state === "recording",
    20_000,
  );
  ok("the capture started with nothing shown", Boolean(recording));
  ok(
    "the window hid itself for the recording",
    !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())),
  );

  const recRect = rectOf(pid);
  const recW = Number(recRect.split(",")[2]);
  // THE ASSERTION THAT "TWO SIDE-BY-SIDE SYMBOLS" IS GONE. `⏺ REC` beside the
  // mark made the item visibly wider while recording; one mark cannot.
  ok(
    "the item is the same width recording as idle — no title beside the mark",
    recW === idleW,
    `idle ${idleW}px, recording ${recW}px`,
  );
  const recShot = shot(recRect, "recording");
  const change = await faceDiff(idleA, recShot);
  const recPredicted = await predictedDelta("trayRecordingTemplate", scale);
  ok(
    "the face itself changed, by what the recording face predicts",
    change.px > floor.px &&
      change.px >= recPredicted * MIN_SHARE &&
      change.px <= recPredicted * MAX_SHARE,
    `${change.px} px moved, of the ${recPredicted} the committed face predicts ` +
      `(floor ${floor.px})`,
  );

  const recMenu = menuLabels(pid);
  console.log(`  menu: ${recMenu.filter(Boolean).join(" / ")}`);
  ok(
    "the status line reports a START TIME, never an elapsed count",
    /^Recording since /.test(recMenu[0] ?? ""),
    recMenu[0],
  );
  ok("the toggle now stops", recMenu.includes("Stop recording"));

  await sleep(RECORD_MS);

  // --- stop, from the tray ----------------------------------------------
  console.log("\nStopping FROM THE TRAY — the window must stay where it was put");
  clickItem(pid, "Stop recording");
  const idled = await poll(
    async () => (await page.evaluate(() => window.deskrag.recording.status())).state === "idle",
    30_000,
  );
  ok("the capture stopped", Boolean(idled));
  ok(
    "THE WINDOW IS STILL HIDDEN",
    !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())),
    "a tray stop used to summon it back",
  );

  // --- the receipt -------------------------------------------------------
  const running = await poll(
    async () =>
      (await page.evaluate(() => window.deskrag.indexing.queue())).runningJobId !== null,
    30_000,
  );
  if (running) {
    const idxShot = shot(rectOf(pid), "indexing");
    const idxChange = await faceDiff(idleA, idxShot);
    // Its OWN prediction, not the recording face's. Three dots are a 3.4x
    // smaller change than an aperture, and one shared floor made a correct
    // indexing face read as a failure.
    const idxPredicted = await predictedDelta("trayIndexingTemplate", scale);
    ok(
      "the ghost picked up its indexing dots — the recording's receipt",
      idxChange.px > floor.px &&
        idxChange.px >= idxPredicted * MIN_SHARE &&
        idxChange.px <= idxPredicted * MAX_SHARE,
      `${idxChange.px} px moved, of the ${idxPredicted} the committed face predicts ` +
        `(floor ${floor.px})`,
      "a count near the RECORDING face's 54 means the wrong asset is on screen",
    );
    const idxMenu = menuLabels(pid);
    ok("the status line says so too", /^Indexing/.test(idxMenu[0] ?? ""), idxMenu[0]);
  } else {
    // Not a pass. The queue not starting means this half was not exercised.
    note("the queue never started within 30s — the indexing face was NOT exercised");
  }

  console.log(`\nCaptures: ${shots}`);
  console.log("Look at them. A width assertion cannot tell you a face is legible.");
} finally {
  await app.close();
  copy.dispose();
  console.log(`\nDeleted the clone at ${root}`);
}

process.exit(failureCount() > 0 ? 1 : 0);
