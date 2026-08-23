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
 *   1. the portrait band draws, nothing truncates, and no bar prints a number;
 *   2. the rhythm strip either draws 168 cells or STATES why it cannot;
 *   3. whatever the "Not walked lately" band does, it agrees with the rows.
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

import { launchApp, gotoScreen } from "./launch.mjs";

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

  // ---- 1. the portrait
  const portrait = await page.evaluate(() => {
    const places = [...document.querySelectorAll(".portrait__place")];
    return {
      present: document.querySelector(".portrait") !== null,
      places: places.map((li) => ({
        label: li.getAttribute("aria-label"),
        app: li.querySelector(".portrait__app")?.textContent ?? "",
        // A bar must never PRINT its count — the ×N rule.
        printed: (li.textContent ?? "")
          .replace(li.querySelector(".portrait__app")?.textContent ?? "", "")
          .trim(),
        share:
          li.querySelector(".portrait__fill").getBoundingClientRect().width /
          li.querySelector(".portrait__bar").getBoundingClientRect().width,
      })),
      coverage: document.querySelector(".portrait__coverage")?.textContent ?? "",
      truncated: [...document.querySelectorAll(".portrait__app")].filter(
        (el) => el.scrollWidth > el.clientWidth + 1,
      ).length,
    };
  });

  console.log("Portrait:");
  for (const p of portrait.places) {
    console.log(`  ${p.app.padEnd(18)} ${"█".repeat(Math.max(1, Math.round(p.share * 24)))}`);
  }
  console.log(`  ${portrait.coverage}\n`);

  check(portrait.present, "the portrait band is on the screen");
  check(portrait.places.length > 0, "it names at least one place");
  check(portrait.truncated === 0, `no place name is truncated — ${portrait.truncated} were`);
  check(
    portrait.places.every((p) => p.printed === ""),
    "no bar prints a number on its face",
  );
  check(
    portrait.places.every((p) => /· \d+ recordings? of repeated work$/.test(p.label ?? "")),
    "every bar says its count in words, for a screen reader",
  );
  check(
    /^\d+ recordings? walked a route · /.test(portrait.coverage),
    "the coverage line says what its number is a count OF",
  );
  check(!/%|score|streak/i.test(portrait.coverage), "the coverage line prints no score");
  // Descending, which is what makes the picture readable at a glance.
  const shares = portrait.places.map((p) => p.share);
  check(
    shares.every((s, i) => i === 0 || s <= shares[i - 1] + 0.001),
    "the bars descend",
  );

  // ---- 2. the rhythm strip
  await page.locator(".habits__items .habit").first().click();
  await page.waitForSelector(".habitedit__evidence", { timeout: 20_000 });

  const rhythm = await page.evaluate(() => ({
    present: document.querySelector(".rhythm") !== null,
    gridDrawn: document.querySelector(".rhythm__grid") !== null,
    cells: document.querySelectorAll(".rhythm__cell").length,
    // The component sets an inline background ONLY on a cell holding a walk,
    // so the attribute IS the contract. Comparing computed colours instead
    // would compare an `rgb()` against a raw `--sunken` hex and never match.
    filled: [...document.querySelectorAll(".rhythm__cell")].filter((c) =>
      c.hasAttribute("style"),
    ).length,
    note: document.querySelector(".rhythm__note")?.textContent ?? "",
    label: document.querySelector(".rhythm__grid")?.getAttribute("aria-label") ?? null,
    fitsEvidence:
      (document.querySelector(".rhythm")?.getBoundingClientRect().right ?? 0) <=
      (document.querySelector(".habitedit__evidence")?.getBoundingClientRect().right ?? 0) + 1,
  }));

  console.log(`\nRhythm: ${rhythm.gridDrawn ? `grid drawn, ${rhythm.filled} cells hold a walk` : "below the floor"}`);
  console.log(`  ${rhythm.note}\n`);

  check(rhythm.present, "the rhythm strip is on the screen");
  check(rhythm.note !== "", "it says something in words, whichever state it is in");
  check(rhythm.fitsEvidence, "it does not overflow the evidence column");
  if (rhythm.gridDrawn) {
    check(rhythm.cells === 168, `the grid is 7x24 — found ${rhythm.cells} cells`);
    check(rhythm.label !== null, "the picture has an accessible name");
    // A drawn grid with nothing in it would mean the walks vanished between
    // the floor check and the fill — the two read the same array.
    check(rhythm.filled > 0, `a drawn grid holds at least one walk — ${rhythm.filled}`);
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
