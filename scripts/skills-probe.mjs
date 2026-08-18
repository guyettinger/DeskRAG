/**
 * Does the Skills screen produce a usable SKILL.md against the REAL store?
 *
 * Read-only except for one deliberate write: it accepts the top proposal, which
 * is the only way to see what a kept skill actually renders to. It deletes
 * nothing, re-indexes nothing, and reports the skill it left behind.
 *
 * The check that matters and that NOTHING in the suite can see: the string the
 * Copy button puts on the clipboard and the string `get_skill` returns over a
 * real socket must be byte-identical. They are rendered once in main precisely
 * so they cannot drift, and this is the only place that claim is tested.
 *
 * It runs in whatever configuration the machine has, and PRINTS that
 * configuration before asserting anything — a default install (no summary
 * model) is the one most people have, and a probe that silently exercised only
 * the configured path would be measuring the setup least in need of checking.
 */

import { launchApp, gotoScreen } from "../.claude/skills/run-app/scripts/launch.mjs";

const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
  return cond;
};

/** Poll from node, where `await` means what it says. */
async function until(fn, { timeout = 20_000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

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
  await gotoScreen(page, "Skills");
  const loaded = await until(async () =>
    page.evaluate(
      () =>
        document.querySelector(".skills__stage") !== null ||
        document.querySelector(".skills .empty") !== null,
    ),
  );
  ok("Skills screen renders", loaded === true);

  let data = await page.evaluate(() => window.deskrag.skills.list());
  console.log("\nLibrary");
  console.log(`  graph present   : ${data.graphPresent}`);
  console.log(`  proposals       : ${data.proposals.length}`);
  console.log(`  kept            : ${data.skills.filter((s) => s.state !== "dismissed").length}`);
  console.log(`  prose available : ${data.prose.available}${data.prose.model ? ` (${data.prose.model})` : ""}`);

  if (!data.graphPresent || data.proposals.length + data.skills.length === 0) {
    console.log(
      "\nNo routes to build a skill from. That is a legitimate empty state, not a failure —\n" +
        "record a session twice and rebuild the trace graph, then run this again.",
    );
    await page.screenshot({ path: "/tmp/skills-empty.png" });
    console.log("screenshot: /tmp/skills-empty.png");
  } else {
    // --- keep one, if nothing is kept yet ----------------------------------
    let skill = data.skills.find((s) => s.state === "active");
    if (skill === undefined) {
      const top = data.proposals[0];
      console.log(`\nAccepting top proposal: ${top.name ?? top.label} (x${top.count})`);
      data = await page.evaluate((k) => window.deskrag.skills.accept(k), top.routeKey);
      skill = data.skills.find((s) => s.state === "active");
    }
    ok("a skill exists after accepting", skill !== undefined);

    if (skill !== undefined) {
      console.log(`\nSkill ${skill.id}`);
      console.log(`  slug        : ${skill.slug}`);
      console.log(`  prose by    : ${skill.bodySource}${skill.bodyModel ? ` (${skill.bodyModel})` : ""}`);
      console.log(`  binding     : ${skill.binding.state}`);
      console.log(`  recordings  : ${skill.binding.recordings}`);
      console.log(`  markdown    : ${skill.markdown.length} bytes`);

      // A default install must produce a usable file with no model at all.
      if (defaultProse) {
        ok("default install writes a template body", skill.bodySource === "template");
      }

      const md = skill.markdown;
      ok("starts with frontmatter", md.startsWith("---\n"));
      ok("names the skill", /\nname: \S+/.test(md));
      ok("has a description", /\ndescription: /.test(md));
      ok("declares the steps are the template's", /\n  steps: template/.test(md));
      ok("carries the recorded steps", md.includes("## Recorded steps"));
      ok("says the steps are not model-written", /Not written by a model/.test(md));
      ok(
        "withholds recorded values by default",
        !skill.showSamples && /recorded values are not printed/i.test(md),
      );
      ok("invents no confidence number", !/^\s*confidence:/m.test(md));
      // outcomes is {0,0} on every graph, so any success rate would be invented.
      ok("claims no success rate", !/\bsuccess(es)? ?\d|attempts=\d/.test(md));

      // --- THE check: clipboard vs get_skill, byte for byte -----------------
      const clip = await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
        return navigator.clipboard.readText();
      }, skill.markdown);
      ok("clipboard round-trips the markdown", clip === skill.markdown);

      if (mcp.listening) {
        const call = async (name, args = {}) => {
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

        const list = await call("list_skills");
        ok("list_skills names the kept skill", list.includes(skill.slug));
        ok("list_skills names its id", list.includes(skill.id));

        const got = await call("get_skill", { skillId: skill.id });
        ok("get_skill returns the file with NO preamble", got.startsWith("---"));
        // The one drift this whole design is arranged to prevent.
        ok("get_skill === clipboard, byte for byte", got === clip, `${got.length} vs ${clip.length}`);
      } else {
        console.log("  (MCP not listening — skipping the tool half)");
      }

      console.log("\n--- SKILL.md ---\n");
      console.log(skill.markdown);
    }

    await page.screenshot({ path: "/tmp/skills-screen.png" });
    console.log("screenshot: /tmp/skills-screen.png");
  }

  // --- geometry, which a screenshot cannot answer --------------------------
  const geo = await page.evaluate(() => {
    const page_ = document.querySelector(".page.skills");
    const stage = document.querySelector(".skills__stage");
    const list = document.querySelector(".skills__list");
    const edit = document.querySelector(".skilledit");
    const titles = [...document.querySelectorAll(".skill__title")];
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
  ok("no title is truncated", geo.truncated === 0, `${geo.truncated} of ${geo.titles}`);
} finally {
  await app.close();
}
