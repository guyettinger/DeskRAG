/**
 * The habit WRITE paths, driven in the real app — versioning, duplicate
 * disclosure, and a merge.
 *
 * Nothing in `npm test` can reach any of this. `deskrag-service.ts` imports
 * `electron`, so the root suite cannot construct it; the pure halves
 * (`bumpVersion`, `duplicateHabits`, `mergedBody`) are unit-tested and the
 * WIRING between them is not testable anywhere else. That wiring is exactly
 * where a bump was computed and then not written — caught by reading the file,
 * which is not a method.
 *
 * IT WRITES, so it writes to a COPY. The real `<userData>/DeskRAG` is cloned
 * into a temp directory and the app is launched with `--user-data-dir` pointing
 * at it; the user's own library is opened read-only exactly once, by `cp`. A
 * probe that staged two duplicate habits in the real store and archived one of
 * them would be doing to a person's authored prose precisely what
 * `AUTHORED_TABLES` exists to prevent.
 *
 * The duplicate is staged the way one really arises: a disclosed re-bind, which
 * is one of the three ordinary paths (the others are a re-index re-keying a
 * route and near-miss clustering merging two).
 *
 * Read-only against the real store. Everything it writes, it writes to the copy,
 * and it deletes the copy when it is done.
 */

import "../lib/renderer-globals.js";
import { launchApp, gotoScreen } from "../lib/launch.js";
import { cloneLibrary } from "../lib/library-clone.js";
import { must, ok, summary } from "../lib/report.js";

const copy = cloneLibrary("deskrag-merge-probe");
if (copy === null) process.exit(0);

const { app, page } = await launchApp({ userDataDir: copy.root });

try {
  const settings = await page.evaluate(() => window.deskrag.settings.get());
  console.log("Configuration");
  console.log(`  summaryProvider : ${settings.providers.summaryProvider}`);
  console.log(`  prose path      : ${settings.providers.summaryProvider === "none" ? "TEMPLATE (default install)" : "MODEL"}`);

  await gotoScreen(page, "Habits");
  await page.waitForSelector(".habits__stage, .habits .empty", { timeout: 30_000 });

  let data0 = await page.evaluate(() => window.deskrag.habits.list());
  console.log(`\nLibrary\n  proposals : ${data0.proposals.length}\n  kept      : ${data0.habits.length}`);

  // Two habits on ONE route is the whole subject, so it needs two things to
  // keep. A store with fewer is a legitimate empty state, not a failure.
  const keepable = data0.habits.filter((s) => s.state === "active").length + data0.proposals.length;
  if (keepable < 2) {
    console.log("\nFewer than two routes to keep. Record a second flow and index it, then run this again.");
    await app.close();
    copy.dispose();
    process.exit(0);
  }

  const accept = async (routeKey: string) =>
    page.evaluate((k) => window.deskrag.habits.accept(k), routeKey);
  const update = async (id: string, patch: Parameters<typeof window.deskrag.habits.update>[1]) =>
    page.evaluate(([i, p]) => window.deskrag.habits.update(i, p), [id, patch] as const);

  const activeHabit = () => must(data0.habits.find((s) => s.state === "active"), "an active habit");
  if (data0.habits.every((s) => s.state !== "active")) {
    data0 = await accept(must(data0.proposals[0], "a proposal to accept").routeKey);
  }
  let a = activeHabit();
  const startVersion = a.version;
  console.log(`\nKeeper ${a.id} (${a.slug}) at v${startVersion}`);

  ok("the file carries its version", a.markdown.includes(`\n  version: ${a.version}\n`));
  ok("a lone habit discloses no duplicate", a.duplicates.length === 0);

  // --- what moves the version, and what deliberately does not --------------
  const bumped = (from: string): string => {
    const [maj, min, patch] = from.split(".").map(Number);
    return `${maj}.${min}.${(patch ?? 0) + 1}`;
  };

  let after = await update(a.id, { description: `${a.description} ` });
  a = must(after.habits.find((s) => s.id === a.id), "the keeper");
  ok("an edit bumps the patch", a.version === bumped(startVersion), `${startVersion} -> ${a.version}`);
  ok("the frontmatter moved with it", a.markdown.includes(`\n  version: ${a.version}\n`));
  ok("the history says what moved it", a.history.at(-1)?.what === "edited by hand");

  const held = a.version;
  after = await update(a.id, { pinned: !a.pinned });
  a = must(after.habits.find((s) => s.id === a.id), "the keeper");
  // Pinning changes how the app LISTS a habit and not one byte of the file. A
  // version that moved here would stop meaning "this artifact moved".
  ok("pinning does NOT bump", a.version === held, a.version);
  await update(a.id, { pinned: !a.pinned });

  // --- stage the duplicate, the way one really arises ----------------------
  after = await page.evaluate(() => window.deskrag.habits.list());
  const spare = after.proposals[0];
  if (spare === undefined) {
    console.log("\nOnly one route is unclaimed — cannot stage a duplicate. Stopping here.");
  } else {
    after = await accept(spare.routeKey);
    let b = must(
      after.habits.find((s) => s.binding.routeKey === spare.routeKey),
      "the freshly accepted habit",
    );
    const bStart = b.version;
    after = await page.evaluate(([i, k]) => window.deskrag.habits.rebind(i, k), [
      b.id,
      must(a.binding.liveRouteKey, "the keeper's LIVE route key"),
    ] as const);
    a = must(after.habits.find((s) => s.id === a.id), "the keeper");
    b = must(after.habits.find((s) => s.id === b.id), "the duplicate");

    ok("a confirmed re-bind bumps the version", b.version === bumped(bStart), `${bStart} -> ${b.version}`);
    ok("both now answer to one live route", a.binding.liveRouteKey === b.binding.liveRouteKey);
    ok("EACH discloses the other", a.duplicates.includes(b.id) && b.duplicates.includes(a.id));

    // The screen, not just the DTO.
    await page.reload();
    await page.waitForSelector(".rail__nav .rail__item");
    await gotoScreen(page, "Habits");
    await page.waitForSelector(".habits__stage");
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll(".habit__bind")].map((e) => e.textContent),
    );
    ok("the list chips BOTH `duplicated`", chips.filter((c) => c === "duplicated").length === 2, JSON.stringify(chips));

    await page.locator(".habits__items .habit", { hasText: a.title }).first().click();
    await page.waitForSelector(".habitedit__body");
    const dom = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".habitedit__bind .btn")].find((x) =>
        (x.textContent ?? "").trim().startsWith("Merge in"),
      );
      const p = document.querySelector(".habitedit__bind p");
      const page_ = document.querySelector(".page.habits");
      return {
        offered: btn !== undefined,
        btnScroll: btn?.scrollWidth ?? 0,
        btnClient: btn?.clientWidth ?? 0,
        pScroll: p?.scrollWidth ?? 0,
        pClient: p?.clientWidth ?? 0,
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
        pageW: page_?.scrollWidth ?? 0,
        pageC: page_?.clientWidth ?? 0,
      };
    });
    ok("the editor OFFERS a merge", dom.offered);
    // NOTHING TRUNCATES — and the button carries a user-supplied habit TITLE,
    // which is the longest string this screen ever puts inside a control.
    ok("the Merge button does not truncate the title", dom.btnScroll <= dom.btnClient + 1, `${dom.btnScroll} vs ${dom.btnClient}`);
    ok("the banner does not truncate", dom.pScroll <= dom.pClient + 1, `${dom.pScroll} vs ${dom.pClient}`);
    ok("the page does not scroll sideways", dom.pageW <= dom.pageC + 1, `${dom.pageW} vs ${dom.pageC}`);
    ok("the page does not scroll", !dom.pageScrolls);
    await page.screenshot({ path: "/tmp/merge-probe-banner.png" });

    // --- the merge itself --------------------------------------------------
    const before = { keep: a.body, other: b.body, keepV: a.version, otherV: b.version };
    after = await page.evaluate(([k, m]) => window.deskrag.habits.merge(k, m), [
      a.id,
      b.id,
    ] as const);
    const keeper = must(after.habits.find((s) => s.id === a.id), "the keeper after the merge");
    const loser = must(after.habits.find((s) => s.id === b.id), "the loser after the merge");

    ok("the keeper survives, active", keeper?.state === "active", keeper?.state);
    // TWO independent guarantees that a merge destroys no writing.
    ok("the loser is ARCHIVED, never deleted", loser?.state === "archived", loser?.state);
    ok("the loser's own prose is untouched", loser?.body === before.other);
    ok(
      "the keeper carries BOTH proses",
      keeper.body.includes(before.keep.trim()) && keeper.body.includes(before.other.trim()),
    );
    ok(
      "under a heading naming where it came from",
      keeper.body.includes("## Also written for this route") && keeper.body.includes(b.title),
    );
    ok("both versions moved", keeper.version === bumped(before.keepV) && loser.version === bumped(before.otherV),
       `${keeper.version} / ${loser.version}`);
    ok("the disclosure is gone once it is resolved", keeper.duplicates.length === 0 && loser.duplicates.length === 0);
    // The merged prose is still PROSE: the record is rendered below it, from
    // the live route, and a body containing its own heading cannot displace it.
    ok(
      "the record is still the LAST thing in the file",
      keeper.markdown.lastIndexOf("## Recorded steps") >
        keeper.markdown.indexOf("## Also written for this route"),
    );

    console.log(`\nscreenshot: /tmp/merge-probe-banner.png`);
  }
} finally {
  await app.close();
  copy.dispose();
  console.log("Removed the copy.");
  summary("");
}
