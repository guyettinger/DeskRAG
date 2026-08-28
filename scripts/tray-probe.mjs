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
 * THE PIXEL CHECK CARRIES ITS OWN CONTROL. A menu bar is translucent, so two
 * captures of the SAME face already differ a little; a difference between two
 * different faces means nothing until you know what that floor is. So idle is
 * captured twice, and the face-change has to beat its own noise.
 *
 * It needs Accessibility (to read and click the status item) and Screen
 * Recording (to capture it) for whatever runs it. Both failures are reported as
 * failures, never skipped — a check that quietly measures nothing looks exactly
 * like one that found nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { launchApp } from "../.claude/skills/run-app/scripts/launch.mjs";

const REAL = join(homedir(), "Library", "Application Support", "deskrag-app", "DeskRAG");
const RECORD_MS = 6000;

let failed = false;
/** `detail` is printed either way; `hint` only when the check fails. */
const ok = (label, cond, detail = "", hint = "") => {
  const tail = cond ? detail : [detail, hint].filter(Boolean).join(" — ");
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${tail ? ` — ${tail}` : ""}`);
  if (!cond) failed = true;
  return cond;
};
const note = (label, detail) => console.log(`  --  ${label}${detail ? ` — ${detail}` : ""}`);

const osa = (s) => execFileSync("osascript", ["-e", s], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

if (!existsSync(join(REAL, "app.db"))) {
  console.log(`No library at ${REAL}. Record and index something first.`);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "deskrag-tray-probe-"));
// The captures OUTLIVE the clone on purpose: a width assertion cannot tell
// you whether a face is legible, and only a person looking can.
const shots = mkdtempSync(join(tmpdir(), "deskrag-tray-shots-"));
try {
  execFileSync("cp", ["-Rc", REAL, join(root, "DeskRAG")]);
} catch {
  execFileSync("cp", ["-R", REAL, join(root, "DeskRAG")]);
}
console.log(`Copied the library to ${join(root, "DeskRAG")}`);
console.log("The real store is opened once, by `cp`, and never by the app.\n");

const BASES = [
  "trayTemplate",
  "trayRecordingTemplate",
  "trayIndexingTemplate",
  "trayRecordingIndexingTemplate",
];

const { app, page } = await launchApp({ userDataDir: root });

/** The status item's screen rect, via the accessibility API. */
const rectOf = (pid) =>
  osa(`tell application "System Events" to tell (item 1 of (every process whose unix id is ${pid}))
  set b to menu bar item 1 of menu bar 2
  set {x, y} to position of b
  set {w, h} to size of b
  return (x as string) & "," & (y as string) & "," & (w as string) & "," & (h as string)
end tell`);

const menuLabels = (pid) =>
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

const clickItem = (pid, label) =>
  osa(`tell application "System Events" to tell (item 1 of (every process whose unix id is ${pid}))
  click menu bar item 1 of menu bar 2
  delay 0.4
  click menu item "${label}" of menu 1 of menu bar item 1 of menu bar 2
end tell`);

const shot = (rect, name) => {
  const p = join(shots, `${name}.png`);
  execFileSync("screencapture", ["-x", `-R${rect}`, p]);
  return p;
};

/** Mean absolute difference per channel-byte between two captures of one rect. */
async function meanDiff(a, b) {
  const [x, y] = await Promise.all(
    [a, b].map((p) => sharp(p).raw().toBuffer({ resolveWithObject: true })),
  );
  if (x.data.length !== y.data.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < x.data.length; i++) sum += Math.abs(x.data[i] - y.data[i]);
  return sum / x.data.length;
}

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
    BASES.map((b) => join(process.cwd(), "app/build/tray", `${b}.png`)),
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
  const floor = await meanDiff(idleA, idleB);
  ok(
    "the capture is a real screenshot, not a blank",
    (await sharp(idleA).stats()).channels.some((c) => c.max > c.min),
    "",
    "flat image — grant Screen Recording to whatever runs this",
  );
  note(
    "noise floor, two captures of the same face",
    floor === 0
      ? "0.000 — an opaque menu bar, so the ABSOLUTE floors below are what carry these checks"
      : floor.toFixed(3),
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

  const recording = await until(
    async () => (await page.evaluate(() => window.deskrag.recording.status())).state === "recording",
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
  const change = await meanDiff(idleA, recShot);
  ok(
    "the face itself changed",
    change > floor * 4 && change > 1,
    `${change.toFixed(3)} against a ${floor.toFixed(3)} floor`,
  );

  const recMenu = menuLabels(pid);
  console.log(`  menu: ${recMenu.filter(Boolean).join(" / ")}`);
  ok(
    "the status line reports a START TIME, never an elapsed count",
    /^Recording since /.test(recMenu[0]),
    recMenu[0],
  );
  ok("the toggle now stops", recMenu.includes("Stop recording"));

  await sleep(RECORD_MS);

  // --- stop, from the tray ----------------------------------------------
  console.log("\nStopping FROM THE TRAY — the window must stay where it was put");
  clickItem(pid, "Stop recording");
  const idled = await until(
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
  const running = await until(
    async () => (await page.evaluate(() => window.deskrag.indexing.queue())).runningJobId !== null,
    30_000,
  );
  if (running) {
    const idxShot = shot(rectOf(pid), "indexing");
    const idxChange = await meanDiff(idleA, idxShot);
    ok(
      "the ghost picked up its indexing dots — the recording's receipt",
      idxChange > floor * 3 && idxChange > 0.5,
      `${idxChange.toFixed(3)} against a ${floor.toFixed(3)} floor`,
    );
    const idxMenu = menuLabels(pid);
    ok("the status line says so too", /^Indexing/.test(idxMenu[0]), idxMenu[0]);
  } else {
    // Not a pass. The queue not starting means this half was not exercised.
    note("the queue never started within 30s — the indexing face was NOT exercised");
  }

  console.log(`\nCaptures: ${shots}`);
  console.log("Look at them. A width assertion cannot tell you a face is legible.");
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
  console.log(`\nDeleted the clone at ${root}`);
}

process.exit(failed ? 1 : 0);
