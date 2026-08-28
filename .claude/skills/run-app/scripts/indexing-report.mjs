/**
 * Drive the real app and report on the INDEXING screen.
 *
 * `npm test` has no renderer and no Electron, so nothing in the suite can say
 * whether the stage ladder actually drew, whether the record button is really
 * live while a job runs, or whether the pause banner appears. This is where
 * those questions get answered.
 *
 * Read-only with respect to the library: it navigates and measures. It does not
 * record, enqueue, or delete anything.
 */
import { launchApp, gotoScreen } from "../../../../scripts/lib/launch.js";

const out = (label, value) => console.log(`${label.padEnd(38)} ${value}`);

const { app, page } = await launchApp();
try {
  await gotoScreen(page, "Indexing");

  // Wait for CONTENT, never a timer: the queue is hydrated over IPC after the
  // screen mounts, and sampling early reports a confident zero.
  await page.waitForFunction(
    () =>
      document.querySelector(".jobs__list .job") !== null ||
      document.querySelector(".jobs .empty") !== null,
    { timeout: 20_000 },
  );

  const queue = await page.evaluate(() => {
    const jobs = [...document.querySelectorAll(".job")].map((j) => ({
      kind: j.querySelector(".job__kind")?.textContent ?? null,
      state: j.querySelector(".job__state")?.textContent ?? null,
      title: j.querySelector(".job__title")?.textContent ?? null,
      meta: j.querySelector(".job__meta .mono")?.textContent ?? null,
      hasThumb: j.querySelector(".job__thumb") !== null,
    }));
    return {
      empty: document.querySelector(".jobs .empty") !== null,
      banner: document.querySelector(".jobs .banner")?.textContent?.trim() ?? null,
      jobs,
    };
  });

  out("empty state", queue.empty);
  out("banner", queue.banner ?? "(none)");
  out("jobs", queue.jobs.length);
  for (const j of queue.jobs) {
    console.log(`   · ${j.kind} / ${j.state} — ${j.title} [${j.meta}] thumb=${j.hasThumb}`);
  }

  // --- the ladder ---------------------------------------------------------
  // The WIRES ARE GONE. Twelve stages declared 21 `needs` edges, each routed
  // down its own 9px channel — ~110px of gray thicket, and reduction only
  // reaches 14 because nine of them fan out of `segment` and into `compose`.
  // The structure is carried by named BANDS now, so this measures bands, the
  // per-stage description, and the meters.
  const ladder = await page.evaluate(() => {
    const overflows = (el) => (el ? el.scrollWidth > el.clientWidth + 1 : false);
    const bands = [...document.querySelectorAll(".stageband")].map((b) => {
      const r = b.getBoundingClientRect();
      return {
        title: b.querySelector(".stageband__title")?.textContent ?? null,
        purpose: b.querySelector(".stageband__purpose")?.textContent ?? null,
        rows: b.querySelectorAll(".stagenode").length,
        y: Math.round(r.y),
      };
    });
    const nodes = [...document.querySelectorAll(".stagenode")].map((n) => {
      const r = n.getBoundingClientRect();
      const nameEl = n.querySelector(".stagenode__name");
      const detailEl = n.querySelector(".stagenode__detail");
      const descEl = n.querySelector(".stagerow__desc");
      const fill = n.querySelector(".stagemeter__fill");
      const meter = n.querySelector(".stagemeter");
      return {
        name: nameEl?.textContent ?? null,
        desc: descEl?.textContent ?? null,
        detail: detailEl?.textContent ?? null,
        time: n.querySelector(".stagenode__time")?.textContent ?? null,
        tone: n.getAttribute("data-tone"),
        cls: [...n.classList].find((c) => c.startsWith("stagenode--")) ?? null,
        meter: meter
          ? meter.classList.contains("stagemeter--indeterminate")
            ? "indeterminate"
            : "determinate"
          : null,
        meterCount: n.querySelector(".stagemeter__count")?.textContent ?? null,
        meterPct: fill ? fill.getBoundingClientRect().width : null,
        needs: [...n.querySelectorAll(".stageneeds__chip")].map((c) => c.textContent),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        // A label wider than its box is a TRUNCATED label. Nothing truncates.
        nameOverflows: overflows(nameEl),
        detailOverflows: overflows(detailEl),
        descOverflows: overflows(descEl),
      };
    });
    const roll = document.querySelector(".stagerollup");
    const segs = [...document.querySelectorAll(".stagerollup__seg")].map((s) =>
      Number(s.style.width.replace("%", "")),
    );
    // COMPUTED, not declared. `--data-signal` IS `--data-4`, so a default plus
    // an nth-child of the same token painted two blocks one colour while the
    // legend claimed two — invisible to every structural assertion, and only
    // the screenshot showed it.
    const segColors = [...document.querySelectorAll(".stagerollup__seg")].map(
      (s) => getComputedStyle(s).backgroundColor,
    );
    const keyColors = [...document.querySelectorAll(".stagerollup__swatch")].map(
      (s) => getComputedStyle(s).backgroundColor,
    );
    return {
      bands,
      nodes,
      rollup: roll
        ? {
            totals: roll.querySelector(".stagerollup__totals")?.textContent?.trim() ?? null,
            held: roll.querySelector(".stagerollup__held")?.textContent ?? null,
            segs,
            segColors,
            keyColors,
            keys: roll.querySelectorAll(".stagerollup__key").length,
          }
        : null,
      wiresLeft: document.querySelectorAll(".stagewire, .stagemap__wires").length,
    };
  });

  console.log("\n--- stage ladder ---");
  out("bands drawn", ladder.bands.length);
  out("nodes drawn", ladder.nodes.length);
  out("wire elements left (must be 0)", ladder.wiresLeft);
  out("truncated names", ladder.nodes.filter((n) => n.nameOverflows).length);
  out("truncated DESCRIPTIONS (must be 0)", ladder.nodes.filter((n) => n.descOverflows).length);
  out("truncated details", ladder.nodes.filter((n) => n.detailOverflows).length);
  out("stages with no description", ladder.nodes.filter((n) => !n.desc).length);
  out("nodes with no width", ladder.nodes.filter((n) => n.w <= 0).length);
  out(
    "skipped nodes with no reason",
    ladder.nodes.filter((n) => n.cls === "stagenode--skipped" && !n.detail).length,
  );
  out(
    "meters on non-running stages (must be 0)",
    ladder.nodes.filter((n) => n.meter && n.cls !== "stagenode--running").length,
  );

  // Row order must be strictly increasing in y: top-to-bottom IS the run order,
  // bands included — a band head sitting between two of another band's stages
  // would mean the phase table lost contiguity.
  const ys = ladder.nodes.map((n) => n.y);
  out("rows strictly increasing in y", ys.every((y, i) => i === 0 || y > ys[i - 1]));
  const bandYs = ladder.bands.map((b) => b.y);
  out("bands strictly increasing in y", bandYs.every((y, i) => i === 0 || y > bandYs[i - 1]));
  // Every row full width now — the indent was a second, weaker encoding of depth.
  out("distinct row x (should be 1)", new Set(ladder.nodes.map((n) => n.x)).size);

  console.log("\n--- bands ---");
  for (const b of ladder.bands) {
    console.log(`   ${String(b.rows).padStart(2)} rows  ${b.title} — ${b.purpose}`);
  }

  console.log("\n--- rollup ---");
  if (!ladder.rollup) {
    console.log("   (none — nothing has run yet)");
  } else {
    out("totals line", ladder.rollup.totals);
    out("held line", ladder.rollup.held ?? "(none)");
    out("blocks", ladder.rollup.segs.length);
    out("legend keys", ladder.rollup.keys);
    const sum = ladder.rollup.segs.reduce((a, b) => a + b, 0);
    out("block widths sum to ~100%", `${sum.toFixed(2)}%`);
    const sc = ladder.rollup.segColors;
    out("block colours all DISTINCT", new Set(sc).size === sc.length);
    out(
      "legend matches its blocks",
      JSON.stringify(sc) === JSON.stringify(ladder.rollup.keyColors),
    );
    sc.forEach((c, i) => console.log(`     block ${i + 1}  ${c}`));
  }

  console.log("\n   row  w     tone      state       meter          stage / detail");
  ladder.nodes.forEach((n, i) => {
    console.log(
      `   ${String(i).padStart(3)}  ${String(n.w).padStart(4)}  ${(n.tone ?? "-").padEnd(9)} ` +
        `${(n.cls ?? "-").replace("stagenode--", "").padEnd(11)} ${(n.meter ?? "-").padEnd(14)} ` +
        `${n.name}${n.time ? `  (${n.time})` : ""}`,
    );
    if (n.desc) console.log(`        ${n.desc}`);
    if (n.meterCount) console.log(`        [${n.meterCount}]`);
    if (n.detail) console.log(`        · ${n.detail}`);
    if (n.needs.length) console.log(`        needs ${n.needs.join(", ")}`);
  });

  // --- the page fills, and does not scroll horizontally --------------------
  const layout = await page.evaluate(() => {
    const pg = document.querySelector(".page");
    const content = document.querySelector(".content");
    const stage = document.querySelector(".jobs__stage");
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    return {
      page: r(pg) && { w: Math.round(r(pg).width), h: Math.round(r(pg).height) },
      contentScrolls: content ? content.scrollHeight > content.clientHeight : null,
      bodyHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      stage: r(stage) && { w: Math.round(r(stage).width), h: Math.round(r(stage).height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  console.log("\n--- layout ---");
  out("viewport", `${layout.viewport.w}x${layout.viewport.h}`);
  out("page", layout.page ? `${layout.page.w}x${layout.page.h}` : "(none)");
  out("jobs__stage", layout.stage ? `${layout.stage.w}x${layout.stage.h}` : "(none)");
  out("content scrolls vertically", layout.contentScrolls);
  out("page scrolls HORIZONTALLY (must be false)", layout.bodyHScroll);

  // --- the record button must NOT be disabled -----------------------------
  await gotoScreen(page, "Record");
  await page.waitForSelector(".recbtn", { timeout: 20_000 });
  const rec = await page.evaluate(() => {
    const btn = document.querySelector(".recbtn");
    const handoff = document.querySelector(".transport__handoff");
    return {
      disabled: btn?.hasAttribute("disabled") ?? null,
      hint: document.querySelector(".transport__hint")?.textContent ?? null,
      handoff: handoff?.textContent?.trim() ?? null,
      switchesDisabled: [...document.querySelectorAll(".switch")].filter((s) =>
        s.hasAttribute("disabled"),
      ).length,
      indexingCardPresent: document.querySelector(".indexing") !== null,
    };
  });
  console.log("\n--- record screen ---");
  out("record button disabled", rec.disabled);
  out("hint", rec.hint);
  out("handoff line", rec.handoff ?? "(missing)");
  out("signal switches disabled", rec.switchesDisabled);
  out("old .indexing card still present", rec.indexingCardPresent);

  await gotoScreen(page, "Indexing");
  await page.waitForSelector(".jobs", { timeout: 10_000 });
  await page.screenshot({ path: process.env["SHOT"] ?? "/tmp/indexing.png" });
  console.log(`\nscreenshot -> ${process.env["SHOT"] ?? "/tmp/indexing.png"}`);
} finally {
  await app.close();
}
