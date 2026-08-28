/**
 * Does the Habits screen produce a usable HABIT.md against the REAL store?
 *
 * Read-only except for one deliberate write: it accepts the top proposal, which
 * is the only way to see what a kept habit actually renders to. It deletes
 * nothing, re-indexes nothing, and reports the habit it left behind.
 *
 * The check that matters and that NOTHING in the suite can see: the string the
 * Copy button puts on the clipboard and the string `get_habit` returns over a
 * real socket must be byte-identical. They are rendered once in main precisely
 * so they cannot drift, and this is the only place that claim is tested.
 *
 * It runs in whatever configuration the machine has, and PRINTS that
 * configuration before asserting anything — a default install (no summary
 * model) is the one most people have, and a probe that silently exercised only
 * the configured path would be measuring the setup least in need of checking.
 */

import "../lib/renderer-globals.js";
import { launchApp, gotoScreen } from "../lib/launch.js";
import { must, ok } from "../lib/report.js";
/** Polls from node, where `await` means what it says. */
import { until } from "../lib/wait.js";

const { app, page } = await launchApp();

try {
  // --- the configuration this run is measuring -----------------------------
  const settings = await page.evaluate(() => window.deskrag.settings.get());
  const mcp = await page.evaluate(() => window.deskrag.mcp.status());
  console.log("\nConfiguration");
  console.log(`  summaryProvider : ${settings.providers.summaryProvider}`);
  console.log(`  summary model   : ${settings.providers.ollamaSummaryModel}`);
  console.log(`  imageProvider   : ${settings.providers.imageProvider}`);
  console.log(`  mcp             : ${mcp.listening ? `http://127.0.0.1:${mcp.port}/mcp` : "not listening"}`);
  const defaultProse = settings.providers.summaryProvider === "none";
  console.log(`  prose path      : ${defaultProse ? "TEMPLATE (default install)" : "MODEL"}`);

  // --- the screen ----------------------------------------------------------
  await gotoScreen(page, "Habits");
  const loaded = await until(async () =>
    page.evaluate(
      () =>
        document.querySelector(".habits__stage") !== null ||
        document.querySelector(".habits .empty") !== null,
    ),
  );
  ok("Habits screen renders", loaded === true);

  let data = await page.evaluate(() => window.deskrag.habits.list());
  console.log("\nLibrary");
  console.log(`  graph present   : ${data.graphPresent}`);
  console.log(`  proposals       : ${data.proposals.length}`);
  console.log(`  kept            : ${data.habits.filter((s) => s.state !== "dismissed").length}`);
  console.log(`  prose available : ${data.prose.available}${data.prose.model ? ` (${data.prose.model})` : ""}`);

  if (!data.graphPresent || data.proposals.length + data.habits.length === 0) {
    console.log(
      "\nNo routes to build a habit from. That is a legitimate empty state, not a failure —\n" +
        "record a session twice and rebuild the trace graph, then run this again.",
    );
    await page.screenshot({ path: "/tmp/habits-empty.png" });
    console.log("screenshot: /tmp/habits-empty.png");
  } else {
    // --- keep one, if nothing is kept yet ----------------------------------
    let habit = data.habits.find((s) => s.state === "active");
    if (habit === undefined) {
      const top = must(data.proposals[0], "a proposal to accept");
      console.log(`\nAccepting top proposal: ${top.name ?? top.label} (x${top.count})`);
      data = await page.evaluate((k) => window.deskrag.habits.accept(k), top.routeKey);
      habit = data.habits.find((s) => s.state === "active");
    }
    ok("a habit exists after accepting", habit !== undefined);

    if (habit !== undefined) {
      console.log(`\nHabit ${habit.id}`);
      console.log(`  slug        : ${habit.slug}`);
      console.log(`  prose by    : ${habit.bodySource}${habit.bodyModel ? ` (${habit.bodyModel})` : ""}`);
      console.log(`  binding     : ${habit.binding.state}`);
      console.log(`  recordings  : ${habit.binding.recordings}`);
      console.log(`  markdown    : ${habit.markdown.length} bytes`);

      // A default install must produce a usable file with no model at all.
      if (defaultProse) {
        ok("default install writes a template body", habit.bodySource === "template");
      }

      const md = habit.markdown;
      ok("starts with frontmatter", md.startsWith("---\n"));
      ok("names the habit", /\nname: \S+/.test(md));
      ok("has a description", /\ndescription: /.test(md));
      ok("declares the steps are the template's", /\n  steps: template/.test(md));
      ok("carries the recorded steps", md.includes("## Recorded steps"));
      ok("says the steps are not model-written", /Not written by a model/.test(md));
      // WHAT THE FILE SAYS ABOUT ITS OWN KEYSTROKES, in whichever state it is
      // in — never "the default", which this cannot observe.
      //
      // `showSamples` is a STORED, per-habit choice: false at accept, and a
      // checkbox in the editor. This asserted `!habit.showSamples`, so a real
      // library where someone had turned it on failed a check about disclosure
      // by disclosing correctly — measured on the author's own store, whose one
      // kept habit carries `recorded_values: included`. It had a second hole in
      // the same line: a route where nothing was typed prints "Nothing was
      // typed on this route" and never the withheld sentence, so it would have
      // failed there too, with `showSamples` off and the file perfectly honest.
      //
      // The invariant is that the frontmatter and the body AGREE, and that
      // printing keystrokes carries its warning IN THE FILE — the file is the
      // thing that gets pasted somewhere else.
      const typed = !/Nothing was typed on this route/.test(md);
      console.log(`  values      : ${habit.showSamples ? "included" : "withheld"}${typed ? "" : " (nothing typed on this route)"}`);
      if (habit.showSamples) {
        // `!typed ||` for the same reason the withheld branch has it: the
        // warning lives inside the block that lists the slots, so a route where
        // nothing was typed carries neither values nor a warning about them.
        // Measured against a clone of the real store — the one kept habit is
        // all clicks, and this check failed on it while the file was correct.
        ok(
          "printing recorded values carries the warning in the file",
          !typed || (/Recorded values are printed below/i.test(md) && /including a password/i.test(md)),
        );
        ok("the frontmatter says so too", /\n  recorded_values: included/.test(md));
      } else {
        ok(
          "withheld values are declared withheld",
          !typed || /recorded values are not printed/i.test(md),
        );
        // The line is emitted ONLY when values are included, so its absence is
        // the frontmatter agreeing with the body.
        ok("the frontmatter claims no values", !/recorded_values:/.test(md));
        ok("and none are printed", !/^\s+- "/m.test(md));
      }
      ok("invents no confidence number", !/^\s*confidence:/m.test(md));
      // outcomes is {0,0} on every graph, so any success rate would be invented.
      ok("claims no success rate", !/\bsuccess(es)? ?\d|attempts=\d/.test(md));

      // --- THE check: clipboard vs get_habit, byte for byte -----------------
      const clip = await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
        return navigator.clipboard.readText();
      }, habit.markdown);
      ok("clipboard round-trips the markdown", clip === habit.markdown);

      if (mcp.listening) {
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const res = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              host: `127.0.0.1:${mcp.port}`,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          });
          const raw = await res.text();
          const line = raw.split("\n").find((l) => l.startsWith("data: ")) ?? raw;
          const json = JSON.parse(line.replace(/^data: /, ""));
          return json.result?.content?.[0]?.text ?? "";
        };

        const list = await call("list_habits");
        ok("list_habits names the kept habit", list.includes(habit.slug));
        ok("list_habits names its id", list.includes(habit.id));

        const got = await call("get_habit", { habitId: habit.id });
        ok("get_habit returns the file with NO preamble", got.startsWith("---"));
        // The one drift this whole design is arranged to prevent.
        ok("get_habit === clipboard, byte for byte", got === clip, `${got.length} vs ${clip.length}`);
      } else {
        console.log("  (MCP not listening — skipping the tool half)");
      }

      console.log("\n--- HABIT.md ---\n");
      console.log(habit.markdown);
    }

    await page.screenshot({ path: "/tmp/habits-screen.png" });
    console.log("screenshot: /tmp/habits-screen.png");
  }

  // --- a route is a PATH, not a union --------------------------------------
  //
  // `FlowRouteDTO.edgeIds` is the union of every recording's walk and exists for
  // the canvas highlight. Rendering it as a numbered procedure published a
  // 14-step list on this store that neither of its two recordings walked — they
  // walked 8 edges each and shared 2. Nothing in `npm test` can see this: the
  // suite's fixtures are hand-built, and a fixture agrees with whatever the code
  // assumes. Only a real graph has recordings that disagree.
  const routes = await page.evaluate(async () => {
    const flows = await window.deskrag.flows.graph();
    return (flows?.routes ?? []).map((r) => ({
      id: r.id,
      count: r.count,
      union: r.edgeIds.length,
      walks: (r.walks ?? []).map((w) => w.edgeIds.join("\u0000")),
    }));
  });

  console.log("\nRoutes — ways vs union");
  for (const r of routes) {
    const ways = [...new Set(r.walks)];
    const sizes = ways.map((w) => (w === "" ? 0 : w.split("\u0000").length));
    console.log(
      `  ${r.count}x  union ${String(r.union).padStart(3)}  ways ${ways.length} of ${sizes.join("/")}  ${r.id}`,
    );
    // Every recording contributes a walk, or a way was invented from nothing.
    ok(`walks cover every recording — ${r.id.slice(0, 40)}`, r.walks.length === r.count);
    // The union is exactly what the ways cover: no more (a highlight showing an
    // edge nobody walked) and no less (a walk missing from the highlight).
    const covered = new Set(ways.flatMap((w) => (w === "" ? [] : w.split("\u0000"))));
    ok(`the union is exactly the ways' edges — ${r.id.slice(0, 40)}`, covered.size === r.union,
       `${covered.size} vs ${r.union}`);
    // THE DEFECT: when the recordings disagreed, no way may be as long as the
    // union — a way that long IS the union, numbered.
    if (ways.length > 1) {
      ok(
        `no way is the whole union — ${r.id.slice(0, 40)}`,
        Math.max(...sizes) < r.union,
        `longest way ${Math.max(...sizes)}, union ${r.union}`,
      );
    }
  }

  // --- geometry, which a screenshot cannot answer --------------------------
  const geo = await page.evaluate(() => {
    const page_ = document.querySelector(".page.habits");
    const stage = document.querySelector(".habits__stage");
    const list = document.querySelector(".habits__list");
    const edit = document.querySelector(".habitedit");
    const titles = [...document.querySelectorAll(".habit__title")];
    return {
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      stageH: stage?.getBoundingClientRect().height ?? 0,
      listScrolls: list ? list.scrollHeight > list.clientHeight : false,
      editH: edit?.getBoundingClientRect().height ?? 0,
      truncated: titles.filter((t) => t.scrollWidth > t.clientWidth + 1).length,
      titles: titles.length,
      pageH: page_?.getBoundingClientRect().height ?? 0,
    };
  });
  console.log("\nGeometry");
  console.log(`  page height     : ${geo.pageH.toFixed(0)}px`);
  console.log(`  stage height    : ${geo.stageH.toFixed(0)}px`);
  console.log(`  editor height   : ${geo.editH.toFixed(0)}px`);
  console.log(`  titles          : ${geo.titles}`);
  // The panes scroll, not the page — one missing min-height:0 restores page
  // scroll silently, which is the trap .flows__stage documents.
  ok("the page does not scroll", !geo.pageScrolls);
  // NOTHING TRUNCATES: a label fits or is withheld.
  //
  // The title COUNT is part of the assertion. `.habit__title` is a bare selector
  // string, so a class rename empties `titles` and `truncated === 0` becomes
  // `0 === 0` — reporting "no title is truncated — 0 of 0" in a repo where the
  // selector, not the layout, was what broke. An empty set is a subset of every
  // observation; it is disclosed, never counted as a pass.
  ok(
    "no title is truncated",
    geo.truncated === 0 && geo.titles > 0,
    geo.titles === 0
      ? "NOTHING MEASURED — no .habit__title matched, so this proves nothing"
      : `${geo.truncated} of ${geo.titles}`,
  );
} finally {
  await app.close();
}
