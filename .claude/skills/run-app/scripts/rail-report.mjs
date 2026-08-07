/**
 * rail-report.mjs — a worked example of driving the app and asserting the DOM.
 *
 * Prints one row per track-rail lane and writes two screenshots. Useful on its
 * own after touching `session-tracks.ts`, `track-view.ts`, `TrackLane.tsx` or
 * the rail's CSS; useful as a template for any other screen.
 *
 * Read the screenshot as well as the table. They fail in different directions:
 * geometry needs getBoundingClientRect(), but it was the screenshot that caught
 * a DOM probe reporting an empty keyframes lane that plainly had 21 thumbnails.
 *
 * Usage:  node .claude/skills/run-app/scripts/rail-report.mjs [--out <dir>]
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, gotoScreen, waitForRail } from "./launch.mjs";

const argv = process.argv.slice(2);
// Temp dir by default: screenshots are scratch, and dropping PNGs into the repo
// root means someone eventually commits one.
const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : tmpdir();

const { app, page } = await launchApp();
try {
  await gotoScreen(page, "Library");
  await page.waitForSelector(".library, .empty", { timeout: 15_000 });
  await waitForRail(page);

  const report = await page.evaluate(() => {
    const lanes = [...document.querySelectorAll(".tracks__lane")].map((el) => {
      const labels = [...el.querySelectorAll(".tracks__span-label")];
      const spans = [...el.querySelectorAll(".tracks__span")];
      const hits = [...el.querySelectorAll(".tracks__span-hit")];
      const px = (els) => (els.length ? Math.min(...els.map((s) => s.getBoundingClientRect().width)) : null);
      return {
        // Lane ids are not in the DOM — TrackLane renders data-shape and the
        // title text, so the title is how a lane is identified.
        title: el.querySelector(".tracks__title")?.textContent?.trim() ?? "?",
        shape: el.getAttribute("data-shape"),
        spans: spans.length,
        labels: labels.length,
        // A label wider than its box is a truncated label. The rail's contract
        // is that nothing truncates: labelFits withholds one that would not fit.
        truncated: labels.filter((l) => l.scrollWidth > l.clientWidth + 1).length,
        labelTexts: labels.map((l) => l.textContent),
        marks: el.querySelectorAll(".tracks__mark").length,
        thumbs: el.querySelectorAll(".tracks__thumb").length,
        // These two are SUPPOSED to differ — the bar is the signal's true
        // extent, the hit rect is padded so a hair-thin bar stays clickable.
        minSpanPx: px(spans),
        minHitPx: px(hits),
        empty: el.querySelector(".tracks__empty")?.textContent?.trim() ?? null,
        warn: el.querySelector(".tracks__warn")?.getAttribute("title") ?? null,
      };
    });
    return {
      lanes,
      session: document.querySelector(".library__stage h2")?.textContent ?? null,
      // Nothing in the rail should be able to truncate any more.
      anyEllipsis: [...document.querySelectorAll(".tracks__span-label")].some(
        (l) => getComputedStyle(l).textOverflow === "ellipsis",
      ),
    };
  });

  const f = (v, d = 2) => (v === null ? "-" : v.toFixed(d));
  console.log(`session: ${report.session ?? "(none)"}\n`);
  console.log(
    ["lane".padEnd(12), "shape".padEnd(8), "spans".padStart(5), "lbl".padStart(4),
     "trunc".padStart(5), "thumb".padStart(5), "mark".padStart(5),
     "minSpan".padStart(8), "minHit".padStart(7), " notes"].join(" "),
  );
  for (const l of report.lanes) {
    const note = l.empty ? `EMPTY: ${l.empty.slice(0, 44)}`
      : l.warn ? `WARN: ${l.warn.slice(0, 44)}`
      : l.labelTexts.length ? `labels=${l.labelTexts.map((t) => t.slice(0, 16)).join(",")}`
      : "";
    console.log(
      [l.title.padEnd(12), String(l.shape).padEnd(8), String(l.spans).padStart(5),
       String(l.labels).padStart(4), String(l.truncated).padStart(5),
       String(l.thumbs).padStart(5), String(l.marks).padStart(5),
       f(l.minSpanPx).padStart(8), f(l.minHitPx, 1).padStart(7), ` ${note}`].join(" "),
    );
  }

  const truncated = report.lanes.reduce((n, l) => n + l.truncated, 0);
  console.log(`\nanyEllipsis: ${report.anyEllipsis}   truncated labels: ${truncated}`);
  if (report.anyEllipsis || truncated > 0) {
    console.log("^ the rail is truncating again — labelFits is not holding.");
  }

  await page.screenshot({ path: join(outDir, "rail-live.png") });
  const tracks = page.locator(".tracks");
  if (await tracks.count()) await tracks.screenshot({ path: join(outDir, "rail-only.png") });
  console.log(`\nscreenshots -> ${join(outDir, "rail-live.png")}  (LOOK at it)`);
} finally {
  await app.close();
}
