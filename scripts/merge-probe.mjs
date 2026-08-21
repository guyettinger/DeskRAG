/**
 * The skill WRITE paths, driven in the real app — versioning, duplicate
 * disclosure, and a merge.
 *
 * Nothing in `npm test` can reach any of this. `deskrag-service.ts` imports
 * `electron`, so the root suite cannot construct it; the pure halves
 * (`bumpVersion`, `duplicateSkills`, `mergedBody`) are unit-tested and the
 * WIRING between them is not testable anywhere else. That wiring is exactly
 * where a bump was computed and then not written — caught by reading the file,
 * which is not a method.
 *
 * IT WRITES, so it writes to a COPY. The real `<userData>/DeskRAG` is cloned
 * into a temp directory and the app is launched with `--user-data-dir` pointing
 * at it; the user's own library is opened read-only exactly once, by `cp`. A
 * probe that staged two duplicate skills in the real store and archived one of
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

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, gotoScreen } from "../.claude/skills/run-app/scripts/launch.mjs";

const REAL = join(
  homedir(),
  "Library",
  "Application Support",
  "deskrag-app",
  "DeskRAG",
);

const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
  return cond;
};

if (!existsSync(join(REAL, "app.db"))) {
  console.log(`No library at ${REAL}. Record and index something first.`);
  process.exit(0);
}

/** Clone a directory, preferring APFS copy-on-write so `lance/` costs nothing. */
function clone(src, dst) {
  try {
    execFileSync("cp", ["-Rc", src, dst]);
  } catch {
    execFileSync("cp", ["-R", src, dst]);
  }
}

const root = mkdtempSync(join(tmpdir(), "deskrag-merge-probe-"));
const data = join(root, "DeskRAG");
clone(REAL, data);
console.log(`Copied the library to ${data}`);
console.log("The real store is opened once, by cp, and never by the app.\n");

const { app, page } = await launchApp({ userDataDir: root });

try {
  const settings = await page.evaluate(() => window.deskrag.settings.get());
  console.log("Configuration");
  console.log(`  summaryProvider : ${settings.providers.summaryProvider}`);
  console.log(`  prose path      : ${settings.providers.summaryProvider === "none" ? "TEMPLATE (default install)" : "MODEL"}`);

  await gotoScreen(page, "Skills");
  await page.waitForSelector(".skills__stage, .skills .empty", { timeout: 30_000 });

  let data0 = await page.evaluate(() => window.deskrag.skills.list());
  console.log(`\nLibrary\n  proposals : ${data0.proposals.length}\n  kept      : ${data0.skills.length}`);

  // Two skills on ONE route is the whole subject, so it needs two things to
  // keep. A store with fewer is a legitimate empty state, not a failure.
  const keepable = data0.skills.filter((s) => s.state === "active").length + data0.proposals.length;
  if (keepable < 2) {
    console.log("\nFewer than two routes to keep. Record a second flow and index it, then run this again.");
    await app.close();
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  }

  const accept = async (routeKey) =>
    page.evaluate((k) => window.deskrag.skills.accept(k), routeKey);
  const update = async (id, patch) =>
    page.evaluate(([i, p]) => window.deskrag.skills.update(i, p), [id, patch]);

  let a = data0.skills.find((s) => s.state === "active");
  if (a === undefined) {
    data0 = await accept(data0.proposals[0].routeKey);
    a = data0.skills.find((s) => s.state === "active");
  }
  const startVersion = a.version;
  console.log(`\nKeeper ${a.id} (${a.slug}) at v${startVersion}`);

  ok("the file carries its version", a.markdown.includes(`\n  version: ${a.version}\n`));
  ok("a lone skill discloses no duplicate", a.duplicates.length === 0);

  // --- what moves the version, and what deliberately does not --------------
  const bumped = (from) => {
    const [maj, min, patch] = from.split(".").map(Number);
    return `${maj}.${min}.${patch + 1}`;
  };

  let after = await update(a.id, { description: `${a.description} ` });
  a = after.skills.find((s) => s.id === a.id);
  ok("an edit bumps the patch", a.version === bumped(startVersion), `${startVersion} -> ${a.version}`);
  ok("the frontmatter moved with it", a.markdown.includes(`\n  version: ${a.version}\n`));
  ok("the history says what moved it", a.history.at(-1)?.what === "edited by hand");

  const held = a.version;
  after = await update(a.id, { pinned: !a.pinned });
  a = after.skills.find((s) => s.id === a.id);
  // Pinning changes how the app LISTS a skill and not one byte of the file. A
  // version that moved here would stop meaning "this artifact moved".
  ok("pinning does NOT bump", a.version === held, a.version);
  await update(a.id, { pinned: !a.pinned });

  // --- stage the duplicate, the way one really arises ----------------------
  after = await page.evaluate(() => window.deskrag.skills.list());
  const spare = after.proposals[0];
  if (spare === undefined) {
    console.log("\nOnly one route is unclaimed — cannot stage a duplicate. Stopping here.");
  } else {
    after = await accept(spare.routeKey);
    let b = after.skills.find((s) => s.binding.routeKey === spare.routeKey);
    const bStart = b.version;
    after = await page.evaluate(([i, k]) => window.deskrag.skills.rebind(i, k), [
      b.id,
      a.binding.liveRouteKey,
    ]);
    a = after.skills.find((s) => s.id === a.id);
    b = after.skills.find((s) => s.id === b.id);

    ok("a confirmed re-bind bumps the version", b.version === bumped(bStart), `${bStart} -> ${b.version}`);
    ok("both now answer to one live route", a.binding.liveRouteKey === b.binding.liveRouteKey);
    ok("EACH discloses the other", a.duplicates.includes(b.id) && b.duplicates.includes(a.id));

    // The screen, not just the DTO.
    await page.reload();
    await page.waitForSelector(".rail__nav .rail__item");
    await gotoScreen(page, "Skills");
    await page.waitForSelector(".skills__stage");
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll(".skill__bind")].map((e) => e.textContent),
    );
    ok("the list chips BOTH `duplicated`", chips.filter((c) => c === "duplicated").length === 2, JSON.stringify(chips));

    await page.locator(".skills__items .skill", { hasText: a.title }).first().click();
    await page.waitForSelector(".skilledit__body");
    const dom = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".skilledit__bind .btn")].find((x) =>
        x.textContent.trim().startsWith("Merge in"),
      );
      const p = document.querySelector(".skilledit__bind p");
      const page_ = document.querySelector(".page.skills");
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
    // NOTHING TRUNCATES — and the button carries a user-supplied skill TITLE,
    // which is the longest string this screen ever puts inside a control.
    ok("the Merge button does not truncate the title", dom.btnScroll <= dom.btnClient + 1, `${dom.btnScroll} vs ${dom.btnClient}`);
    ok("the banner does not truncate", dom.pScroll <= dom.pClient + 1, `${dom.pScroll} vs ${dom.pClient}`);
    ok("the page does not scroll sideways", dom.pageW <= dom.pageC + 1, `${dom.pageW} vs ${dom.pageC}`);
    ok("the page does not scroll", !dom.pageScrolls);
    await page.screenshot({ path: "/tmp/merge-probe-banner.png" });

    // --- the merge itself --------------------------------------------------
    const before = { keep: a.body, other: b.body, keepV: a.version, otherV: b.version };
    after = await page.evaluate(([k, m]) => window.deskrag.skills.merge(k, m), [a.id, b.id]);
    const keeper = after.skills.find((s) => s.id === a.id);
    const loser = after.skills.find((s) => s.id === b.id);

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
  rmSync(root, { recursive: true, force: true });
  console.log("Removed the copy.");
}
