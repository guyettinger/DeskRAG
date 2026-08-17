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
import { launchApp, gotoScreen } from "./launch.mjs";

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
  const ladder = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".stagenode")].map((n) => {
      const r = n.getBoundingClientRect();
      const nameEl = n.querySelector(".stagenode__name");
      const detailEl = n.querySelector(".stagenode__detail");
      return {
        name: nameEl?.textContent ?? null,
        detail: detailEl?.textContent ?? null,
        time: n.querySelector(".stagenode__time")?.textContent ?? null,
        tone: n.getAttribute("data-tone"),
        cls: [...n.classList].find((c) => c.startsWith("stagenode--")) ?? null,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        // A label wider than its box is a TRUNCATED label. Nothing truncates.
        nameOverflows: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : false,
        detailOverflows: detailEl ? detailEl.scrollWidth > detailEl.clientWidth + 1 : false,
      };
    });
    const wires = [...document.querySelectorAll(".stagewire")].map((w) => ({
      d: w.getAttribute("d"),
      distant: w.classList.contains("is-distant"),
    }));
    const svg = document.querySelector(".stagemap__wires")?.getBoundingClientRect() ?? null;
    return { nodes, wires, svg: svg && { w: Math.round(svg.width), h: Math.round(svg.height) } };
  });

  console.log("\n--- stage ladder ---");
  out("nodes drawn", ladder.nodes.length);
  out("wires drawn", ladder.wires.length);
  out("  of which distant (dashed)", ladder.wires.filter((w) => w.distant).length);
  out("svg box", ladder.svg ? `${ladder.svg.w}x${ladder.svg.h}` : "(none)");
  out("NaN in any wire path", ladder.wires.some((w) => (w.d ?? "").includes("NaN")));
  out("truncated names", ladder.nodes.filter((n) => n.nameOverflows).length);
  out("truncated details", ladder.nodes.filter((n) => n.detailOverflows).length);
  out("nodes with no width", ladder.nodes.filter((n) => n.w <= 0).length);
  out("skipped nodes with no reason", ladder.nodes.filter((n) => n.cls === "stagenode--skipped" && !n.detail).length);

  // Row order must be strictly increasing in y: top-to-bottom IS the run order.
  const ys = ladder.nodes.map((n) => n.y);
  out("rows strictly increasing in y", ys.every((y, i) => i === 0 || y > ys[i - 1]));
  out("distinct indent columns", new Set(ladder.nodes.map((n) => n.x)).size);

  console.log("\n   row  x    w    tone      state              stage / detail");
  ladder.nodes.forEach((n, i) => {
    console.log(
      `   ${String(i).padStart(3)}  ${String(n.x).padStart(3)}  ${String(n.w).padStart(4)}  ` +
        `${(n.tone ?? "-").padEnd(9)} ${(n.cls ?? "-").replace("stagenode--", "").padEnd(18)} ` +
        `${n.name}${n.detail ? ` — ${n.detail}` : ""}${n.time ? `  (${n.time})` : ""}`,
    );
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
