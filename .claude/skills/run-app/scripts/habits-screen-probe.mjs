/**
 * habits-screen-probe.mjs — C2's three readings, against the REAL store.
 *
 * READ-ONLY. It navigates, clicks the first habit row, and reads the DOM. It
 * never writes a habit, never re-indexes and never records, so it is safe
 * against the author's own library — which is the point: a fixture agrees with
 * whatever the code assumes, and every rule in this file's subject was derived
 * from what a six-day, one-habit store actually contains.
 *
 * It asserts three things `npm test` structurally cannot reach:
 *
 *   1. the portrait band places the WHOLE LIBRARY in the week — 168 cells full
 *      width, a hollow ring for a route walked once, and no score anywhere;
 *   2. the per-habit rhythm strip either draws 168 cells with a readable hour
 *      axis and a way into each walk, or STATES why it cannot;
 *   3. whatever the "Not walked lately" band does, it agrees with the rows;
 *   4. a kept habit's record is drawn as INSTRUMENTS, not dumped as markdown.
 *
 * BOTH GRIDS ARE `.rhythm__grid`, deliberately: they are one instrument at two
 * scopes, and a second copy of the geometry would be the `ax-dump`/`ax-exec`
 * drift hazard in a stylesheet — including the `display: block` trap below,
 * which measured 0x0. The consequence is that EVERY query here must be scoped:
 * a bare `.rhythm__cell` now matches 336 cells across two instruments, and a
 * probe counting them together would pass while measuring neither.
 *
 * (2) carries one check that exists because of a real defect and would catch
 * nothing without a running renderer: a painted cell must have a NON-ZERO box.
 * `.rhythm__cell` is a `<span>`, blockified for free while it is a direct grid
 * child; moved inside the hit button it became a plain inline span, where width
 * and height do not apply, and every painted cell collapsed to 0x0. The DOM
 * still reported 168 cells, the inline background was still set, and the
 * screenshot still looked plausible. Only `getBoundingClientRect()` said so.
 *
 * (3) is the interesting one. The spec PREDICTS the band is silent on this
 * store — quiet 72h against a 4-week floor — and a prediction nothing checks is
 * not a test. It is written as an agreement check rather than as "expect zero"
 * so that it keeps working, rather than starting to fail, once the library is
 * old enough for the band to speak.
 *
 * The rhythm half is written the same way, and it has already paid for itself:
 * the spec predicted a REFUSAL (3 walks, 2 days) and by the time the code
 * shipped the library had grown to 4 walks across 3 days, so the grid drew.
 * Both branches are checked; neither is skipped.
 */

import { launchApp, gotoScreen } from "../../../../scripts/lib/launch.js";

const problems = [];
const check = (ok, message) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${message}`);
  if (!ok) problems.push(message);
};

const { app, page } = await launchApp();
try {
  await gotoScreen(page, "Habits");
  await page.waitForSelector(".habits__stage, .empty", { timeout: 20_000 });

  const staged = await page.locator(".habits__stage").count();
  if (staged === 0) {
    console.log("The store holds no habits and no proposals — nothing to read.");
    console.log("Record and index a session, then run this again.");
    await app.close();
    process.exit(0);
  }

  // ---- the corpus FIRST, before any assertion, so a number below is read
  // against the library that produced it. probe:routes' rule.
  const corpus = await page.evaluate(() => ({
    bands: [...document.querySelectorAll(".habits__bandhead .eyebrow")].map((e) => e.textContent),
    rows: document.querySelectorAll(".habits__items .habit").length,
  }));
  console.log(`\nCorpus: ${corpus.rows} rows across bands [${corpus.bands.join(", ")}]\n`);

  // ---- 1. the portrait band: the whole library, placed in the week
  const portrait = await page.evaluate(() => {
    const band = document.querySelector(".portrait");
    const grid = document.querySelector(".portrait__week");
    const painted = [...document.querySelectorAll(".portrait__week .rhythm__cell")].filter(
      (c) => c.hasAttribute("style") || c.classList.contains("is-lone"),
    );
    return {
      present: band !== null,
      gridDrawn: grid !== null,
      reason: document.querySelector(".portrait__note")?.textContent ?? "",
      cells: document.querySelectorAll(".portrait__week .rhythm__cell").length,
      // A cell holding a walk of a RECURRING route is filled; one holding only
      // routes walked once is a hollow ring. The ring carries no inline
      // background at all, so the class IS the contract.
      filled: painted.filter((c) => !c.classList.contains("is-lone")).length,
      lone: painted.filter((c) => c.classList.contains("is-lone")).length,
      // ...and a painted cell must have a BOX. See the header.
      collapsed: painted.filter((c) => {
        const b = c.getBoundingClientRect();
        return b.width < 1 || b.height < 1;
      }).length,
      hits: document.querySelectorAll(".portrait__week .rhythm__hit").length,
      ticks: [...document.querySelectorAll(".portrait__week .rhythm__tick")].map(
        (t) => t.textContent,
      ),
      labelled: [...document.querySelectorAll(".portrait__week .rhythm__hit")].every((h) =>
        /\d\d:00 — /.test(h.getAttribute("aria-label") ?? ""),
      ),
      coverage: document.querySelector(".portrait__coverage")?.textContent ?? "",
      // The bars this band replaced. On the real store all three drew at FULL
      // width and always would have — one habit through three applications
      // weighs each of them equally — so the picture could not differentiate
      // on the library it was drawn for.
      bars: document.querySelectorAll(".portrait__bar, .portrait__fill").length,
      width: grid === null ? null : {
        grid: +grid.getBoundingClientRect().width.toFixed(1),
        band: +(band?.getBoundingClientRect().width ?? 0).toFixed(1),
      },
    };
  });

  console.log("Portrait:");
  console.log(`  ${portrait.gridDrawn ? `${portrait.filled} filled · ${portrait.lone} seen once` : "withheld"}`);
  console.log(`  ${portrait.reason}`);
  console.log(`  ${portrait.coverage}\n`);

  check(portrait.present, "the portrait band is on the screen");
  check(portrait.bars === 0, `the equal-width bars are gone — ${portrait.bars} remain`);
  check(
    /^\d+ recordings? walked a route · /.test(portrait.coverage),
    "the coverage line says what its number is a count OF",
  );
  check(
    !/%|score|streak/i.test(`${portrait.coverage} ${portrait.reason}`),
    "the band prints no score",
  );

  // EITHER BRANCH, never a skip. On a young library the band withholds the grid
  // and says what it has; the check is that it does one or the other, so this
  // keeps working rather than starting to fail as the store grows.
  if (portrait.gridDrawn) {
    check(portrait.cells === 168, `the week is 7x24 — ${portrait.cells} cells`);
    check(portrait.ticks.length === 8, `the hour axis is labelled — ${portrait.ticks.join(" ")}`);
    check(
      portrait.collapsed === 0,
      `every painted cell has a box — ${portrait.collapsed} collapsed to 0x0`,
    );
    check(portrait.hits > 0, "an hour holding a recording is a control");
    check(portrait.labelled, "every hour says its day and time for a screen reader");
    check(
      portrait.width !== null && portrait.width.grid >= portrait.width.band - 1,
      `the week fills the band — ${portrait.width?.grid} of ${portrait.width?.band}px`,
    );
  } else {
    check(portrait.reason.length > 0, "it says WHY it drew no week");
    check(
      /too few to place in the week/.test(portrait.reason),
      `the reason names the condition — "${portrait.reason}"`,
    );
  }

  // ---- 2. the rhythm strip
  await page.locator(".habits__items .habit").first().click();
  await page.waitForSelector(".habitedit__evidence", { timeout: 20_000 });

  const rhythm = await page.evaluate(() => {
    const box = (el) => (el ? el.getBoundingClientRect() : null);
    const grid = document.querySelector(".rhythm .rhythm__grid");
    const painted = [...document.querySelectorAll(".rhythm .rhythm__cell")].filter((c) =>
      c.hasAttribute("style"),
    );
    return {
      present: document.querySelector(".rhythm") !== null,
      gridDrawn: grid !== null,
      cells: document.querySelectorAll(".rhythm .rhythm__cell").length,
      // The component sets an inline background ONLY on a cell holding a walk,
      // so the attribute IS the contract. Comparing computed colours instead
      // would compare an `rgb()` against a raw `--sunken` hex and never match.
      filled: painted.length,
      // ...and a painted cell must have a BOX. See the header.
      collapsed: painted.filter((c) => {
        const b = c.getBoundingClientRect();
        return b.width < 1 || b.height < 1;
      }).length,
      hits: document.querySelectorAll(".rhythm .rhythm__hit").length,
      liveHits: [...document.querySelectorAll(".rhythm .rhythm__hit")].filter((b) => !b.disabled).length,
      ticks: [...document.querySelectorAll(".rhythm .rhythm__tick")].map((t) => t.textContent),
      note: document.querySelector(".rhythm .rhythm__note")?.textContent ?? "",
      label: grid?.getAttribute("aria-label") ?? null,
      // FULL WIDTH of the pane it sits in. It used to live inside
      // `.habitedit__evidence`, capped at 420px, where 24 columns gave 15px
      // cells with no room for an hour label — which is why it shipped with no
      // hour axis and so could never say a habit happens at 9am.
      gridWidth: +(box(grid)?.width ?? 0).toFixed(1),
      paneWidth: +(box(document.querySelector(".habitedit__masthead"))?.width ?? 0).toFixed(1),
    };
  });

  console.log(`\nRhythm: ${rhythm.gridDrawn ? `grid drawn, ${rhythm.filled} cells hold a walk` : "below the floor"}`);
  console.log(`  ${rhythm.note}\n`);

  check(rhythm.present, "the rhythm strip is on the screen");
  check(rhythm.note !== "", "it says something in words, whichever state it is in");
  if (rhythm.gridDrawn) {
    check(rhythm.cells === 168, `the grid is 7x24 — found ${rhythm.cells} cells`);
    check(rhythm.label !== null, "the picture has an accessible name");
    // A drawn grid with nothing in it would mean the walks vanished between
    // the floor check and the fill — the two read the same array.
    check(rhythm.filled > 0, `a drawn grid holds at least one walk — ${rhythm.filled}`);
    check(
      rhythm.collapsed === 0,
      `every painted cell has a box — ${rhythm.collapsed} of ${rhythm.filled} collapsed to 0x0`,
    );
    check(
      rhythm.gridWidth >= rhythm.paneWidth - 1,
      `the grid fills the pane — ${rhythm.gridWidth} of ${rhythm.paneWidth}px`,
    );
    // THE HOUR AXIS, which the grid shipped without. Without it the strip could
    // say a habit repeats somewhere mid-week and never that it is at 9am.
    check(
      rhythm.ticks.join(",") === "00,03,06,09,12,15,18,21",
      `the hour axis ticks every third hour — got [${rhythm.ticks.join(", ")}]`,
    );
    // A cell holding a walk is a WAY IN. An empty cell is not a control: 164 of
    // 168 are empty on a real store, and making each one focusable would put
    // 168 tab stops in front of the four that lead somewhere.
    check(
      rhythm.hits === rhythm.filled,
      `exactly the cells holding a walk are controls — ${rhythm.hits} hits, ${rhythm.filled} filled`,
    );

    if (rhythm.liveHits > 0) {
      await page.locator(".rhythm .rhythm__hit:not([disabled])").first().hover();
      await page.waitForSelector(".ledger__tip", { timeout: 5000 });
      const tip = await page.evaluate(() => {
        const t = document.querySelector(".ledger__tip");
        const b = t.getBoundingClientRect();
        return {
          text: t.textContent ?? "",
          // Measured and clamped through the shared `clampTip`, exactly as the
          // ledger's card is — a card sized by a guess ran off the window there.
          inWindow:
            b.top >= 0 && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
        };
      });
      console.log(`  hover: ${tip.text.slice(0, 60)}…`);
      check(
        /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d\d:00 — \d+ recording/.test(tip.text),
        "a cell's card names the day and hour it reports",
      );
      check(tip.inWindow, "the card is clamped inside the window");
      check(!/%|score|streak/i.test(tip.text), "the card prints no score");
    }
  } else {
    check(rhythm.cells === 0, "below the floor it draws no cells at all");
    check(
      /too few to place in the week\.$/.test(rhythm.note),
      "below the floor it states its reason, with the numbers it has",
    );
  }

  // ---- 3. the band and the rows agree
  const quiet = await page.evaluate(() => {
    const heads = [...document.querySelectorAll(".habits__band")];
    const band = heads.find(
      (b) => b.querySelector(".habits__bandhead .eyebrow")?.textContent === "Not walked lately",
    );
    return {
      bandPresent: band !== undefined,
      bandRows: band ? band.querySelectorAll(".habit").length : 0,
      // The fade line renders in HabitRow, so it must appear on exactly the
      // rows that are in the band and on no others.
      rowsWithLine: [...document.querySelectorAll(".habits__items .habit")].filter((r) =>
        /last walked .* ago/.test(r.textContent ?? ""),
      ).length,
    };
  });

  console.log(
    `\nNot walked lately: ${quiet.bandPresent ? `${quiet.bandRows} rows` : "band absent"}\n`,
  );
  check(
    quiet.rowsWithLine === quiet.bandRows,
    `the fade line appears on exactly the banded rows — ${quiet.rowsWithLine} lines, ${quiet.bandRows} rows`,
  );
  if (!quiet.bandPresent) {
    console.log(
      "  (The spec predicts this on a library younger than the four-week floor.\n" +
        "   Its absence here is the prediction holding, not a missing feature.)",
    );
  }

  // ---- 4. the record: one lede, one strip, one spine, three qualifiers
  //
  // This half used to be a `<pre>` of the generated markdown from
  // `## What varies` down: 835x420 of monospace prose whose largest section was
  // fifty-six lines of raw `t_mono` floats and macOS keycodes. It then became
  // four instrument blocks, and it STILL drew the sequence twice — a step list
  // numbered by `step.index + 1`, and a `Where the time goes` block numbered by
  // its own position, which could disagree because `habitTimings` drops steps
  // carrying no duration. The spine merges them and joins on `stepIndex`.
  //
  // The FILE is unchanged throughout — `Copy HABIT.md` still copies
  // `habit.markdown` — so this checks the SCREEN and never the document.
  const record = await page.evaluate(() => ({
    present: document.querySelector(".hrecord") !== null,
    lede: document.querySelector(".hlede__facts")?.textContent ?? null,
    chain: [...document.querySelectorAll(".hlede__app")].map((e) => e.textContent.trim()),
    blocks: [...document.querySelectorAll(".hrecord__block > .eyebrow")].map(
      (e) => e.textContent,
    ),
    // The proposal preview keeps its `<pre>`; a KEPT habit must not have one.
    dumped: document.querySelectorAll(".habitedit__body .habitedit__record").length,
    // ONE step renderer. The spine and the fork are alternatives, never both:
    // drawing them together would put the sequence on the page twice, which is
    // the defect this section exists to undo.
    stepRenderers: document.querySelectorAll(".hspine, .wlat").length,
    // RETIRED. `.habitsteps` and the `Where the time goes` block are the two
    // halves the spine replaced; either reappearing means the merge came apart.
    retired: document.querySelectorAll(".habitsteps, .hrecord__time, .hrecord__walk").length,
    stripLanes: document.querySelectorAll(".hstrip__lane").length,
    // EVERY RECORDING GETS A LANE. The strip read `HabitTimingsDTO`, which
    // costs the BASELINE Way alone — measured, two lanes of six recordings,
    // one of them a 1.0s sliver of a recording that walked a different Way and
    // merely shared one edge. `HabitRunDTO` is per session per Way.
    stripWays: [...document.querySelectorAll(".hstrip__way")].map((w) => w.textContent.trim()),
    // The apology that counted what the axis left out. Gone with the omission.
    apology: /took another way, so it is not drawn/.test(document.body.textContent ?? ""),
    // THE LEGEND NAMES WHAT IS PAINTED, across every lane now — which is how
    // an application reached only by a non-baseline Way finally appears.
    stripLegend: [...document.querySelectorAll(".hstrip__key")].map((k) => k.textContent.trim()),
    // ONE SHARED DOMAIN. Per-lane grids size their `max-content` columns
    // independently — measured at 444.6px and 451.1px on two lanes of one strip
    // — and a shared domain drawn on two axes is not a shared domain.
    trackWidths: [...new Set(
      [...document.querySelectorAll(".hstrip__track")].map(
        (t) => +t.getBoundingClientRect().width.toFixed(1),
      ),
    )],
    // `display: block` on a nested cell is load-bearing, and its absence
    // measured 0x0 with the DOM and the screenshot both looking fine.
    zeroBoxSegs: [...document.querySelectorAll(".hstrip__seg")].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width === 0 || b.height === 0;
    }).length,
    spineSteps: document.querySelectorAll(".hspine__step").length,
    // A PLACE IS PRINTED ONCE while the chain holds. A row printing `A → B` is
    // a declared BREAK, not the default — it used to be every row.
    spineBroken: [...document.querySelectorAll(".hspine__step .hspine__place")].filter(
      (e) => (e.textContent ?? "").includes(" → "),
    ).length,
    // A bar carries no printed number ON it — the portrait band's rule.
    barsPrint: [...document.querySelectorAll(".hspine__bar")].some(
      (b) => (b.textContent ?? "").trim() !== "",
    ),
    // Density is READ, not counted: every step says what it did in one line.
    summaries: [...document.querySelectorAll(".hspine__detail summary")].map((e) => e.textContent),
    // The lattice. A node is a PILL with a tone rail; the rail is an inset
    // shadow and NOT `border-left`, because `.is-lit` sets `border-color` on
    // all four sides and erased the application colour of every lit pill —
    // visible only in a screenshot, with the DOM correct throughout.
    latNodes: document.querySelectorAll(".wlat__node").length,
    latWires: document.querySelectorAll(".wlat__wire").length,
    latChips: document.querySelectorAll(".wlat__chip").length,
    latZeroBox: [...document.querySelectorAll(".wlat__node")].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width === 0 || b.height === 0;
    }).length,
    latRails: [...document.querySelectorAll(".wlat__node")].filter(
      (n) => getComputedStyle(n).boxShadow.includes("inset"),
    ).length,
    // The prose list the graph replaced: `Way A: nothing here` and its twelve
    // siblings, half of which said that nothing happened.
    latRetired: document.querySelectorAll(".wayfork, .wayfork__run, .wayfork__spine").length,
    liftingSummary: document.querySelector(".hrecord__lifting summary")?.textContent ?? null,
    liftingHidden: document.querySelector(".hrecord__lifting")?.open === false,
    liftingNotes: document.querySelectorAll(".hrecord__lifting li").length,
    // DIRECT child of the block, so this counts the cautions and not the 56
    // lifting notes nested inside the <details> beside them — which is the
    // whole distinction this section exists to draw.
    cautions: document.querySelectorAll(".hrecord__block > .hrecord__cautions > li").length,
    truncated: [...document.querySelectorAll(".hrecord *, .hlede *, .hstrip *, .hspine *")].filter(
      (el) => el.scrollWidth > el.clientWidth + 1,
    ).length,
  }));

  console.log(`\nRecord: ${record.lede ?? "no lede"}`);
  console.log(`  ${record.chain.join(" → ")}`);
  console.log(
    `  ${record.stripLanes} strip lanes · ${record.spineSteps} spine steps · blocks [${record.blocks.join(" · ")}]`,
  );
  console.log(`  ${record.liftingSummary ?? "no lifting notes"}\n`);

  check(record.present, "the record is drawn as instruments");
  check(record.lede !== null, "the lede answers what this is before anything is read");
  check(
    record.dumped === 0,
    `a kept habit dumps no generated markdown — found ${record.dumped} <pre>`,
  );
  check(
    record.blocks.join(",") ===
      "What changes each time,What this can’t tell you,Where this came from",
    `the three qualifier blocks are drawn in order — got [${record.blocks.join(", ")}]`,
  );
  check(
    record.stepRenderers === 1,
    `the sequence is drawn once, not twice — ${record.stepRenderers} step renderers`,
  );
  check(
    record.retired === 0,
    `the two halves the spine replaced are gone — ${record.retired} retired nodes on screen`,
  );
  check(!record.barsPrint, "no duration bar prints a number on its face");
  check(record.truncated === 0, `nothing in the record truncates — ${record.truncated} did`);
  check(record.zeroBoxSegs === 0, `every painted strip segment has a box — ${record.zeroBoxSegs} at 0`);
  if (record.stripLanes > 0) {
    check(
      record.trackWidths.length === 1,
      `every lane shares one axis — widths ${record.trackWidths.join(", ")}`,
    );
    check(
      !record.apology,
      "no recording is counted and set aside — the axis draws them all",
    );
    // AGREEMENT, not a fixed number, so this keeps working as the library
    // grows: a way letter per lane, or none at all on a single-Way route.
    check(
      record.stripWays.length === 0 || record.stripWays.length === record.stripLanes,
      `every lane says which way it took — ${record.stripWays.length} letters on ${record.stripLanes} lanes`,
    );
  }

  if (record.latNodes > 0) {
    console.log(
      `\nLattice: ${record.latNodes} pills · ${record.latWires} wires · ${record.latChips} ways\n`,
    );
    check(record.latRetired === 0, `the prose fork list is gone — ${record.latRetired} nodes remain`);
    check(record.latWires > 0, "the pills are joined by wires");
    check(
      record.latZeroBox === 0,
      `every pill has a box — ${record.latZeroBox} collapsed to 0x0`,
    );
    check(
      record.latRails === record.latNodes,
      `every pill carries its application rail — ${record.latRails} of ${record.latNodes}`,
    );

    // TRACING IS THE POINT. Picking a way must light its own path and dim the
    // rest, in the graph AND on the strip — one selection, every instrument.
    await page.locator(".wlat__chip").first().click();
    const traced = await page.evaluate(() => ({
      lit: document.querySelectorAll(".wlat__node.is-lit").length,
      dim: document.querySelectorAll(".wlat__node.is-dim").length,
      litWires: document.querySelectorAll(".wlat__wire.is-lit").length,
      litLanes: document.querySelectorAll(".hstrip__lane.is-lit").length,
      dimLanes: document.querySelectorAll(".hstrip__lane.is-dim").length,
      // A LIT PILL KEEPS ITS RAIL. See the note above.
      litKeepsRail: [...document.querySelectorAll(".wlat__node.is-lit")].every((n) =>
        getComputedStyle(n).boxShadow.includes("inset"),
      ),
    }));
    check(traced.lit > 0, `picking a way lights its path — ${traced.lit} pills`);
    check(
      traced.lit + traced.dim === record.latNodes,
      `every pill is either on the path or off it — ${traced.lit}+${traced.dim} of ${record.latNodes}`,
    );
    check(traced.litWires > 0, `the wires along it light too — ${traced.litWires}`);
    check(traced.litKeepsRail, "a lit pill keeps its application colour");
    check(
      traced.litLanes === 1 && traced.dimLanes === record.stripLanes - 1,
      `the same pick lights that way's lane on the axis — ${traced.litLanes} lit, ${traced.dimLanes} dim`,
    );
    await page.locator(".wlat__chip").first().click();
  }
  if (record.spineSteps > 0) {
    check(
      record.spineBroken === 0,
      `a place is printed once while the chain holds — ${record.spineBroken} rows printed both`,
    );
    check(
      record.summaries.every((t) => /\d|types \{/.test(t ?? "")),
      `every action tally counts something — [${record.summaries.slice(0, 3).join(" | ")}]`,
    );
  }
  if (record.liftingSummary !== null) {
    // ROLLED UP, never dropped. Every note is still one disclosure away, and
    // still every one of them in the file.
    check(
      record.liftingHidden,
      "the lifting notes start collapsed, so they cannot bury the cautions",
    );
    check(
      /^\d+ lifting notes?/.test(record.liftingSummary),
      `the disclosure says what is behind it — "${record.liftingSummary}"`,
    );
    check(
      record.liftingNotes > 0,
      "opening it would show every note, not a summary of them",
    );
    check(
      record.cautions >= 1,
      `the cautions are readable beside it — ${record.cautions} bullets`,
    );
  }

  await page.screenshot({ path: "/tmp/habits-screen-probe.png" });
  console.log("\nScreenshot: /tmp/habits-screen-probe.png — READ IT.");
} finally {
  await app.close();
}

if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
