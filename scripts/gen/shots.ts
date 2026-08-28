/**
 * shots.mjs — regenerate the README screenshots in docs/images/.
 *
 * Drives the *built* app (app/out) with Playwright's Electron driver, using the
 * app's own Electron binary — so there is no browser download and no second
 * runtime. Screenshots are of the renderer contents, which is what we want for
 * a README: no OS title bar, no desktop behind it.
 *
 * Prerequisites:
 *   - `npm run app:install` has been run once.
 *   - **Quit any running dev instance first.** This launches a second app that
 *     opens the same DualStore / LanceDB data dir, and LanceDB will not share it.
 *   - Real recorded sessions in the data dir, or the Library/Flows/Search shots
 *     will capture empty states (the script warns rather than failing). Flows
 *     additionally needs a session that reached the Trace stage, since the graph
 *     is what it draws — and a graph REBUILT since provenance was added, or the
 *     routes column is empty and the screen shows its rebuild banner instead.
 *   - **A CAPTION PROVIDER AND AN IMAGE MODEL MUST BE CONFIGURED, and the shots
 *     degrade SILENTLY without them — no warning fires, because the screens
 *     render perfectly well with the data missing.** `captionProvider: "none"`
 *     costs Detail its CAPTION block and the Library chapter title its label
 *     (`keyframeLabel` falls back digest -> timecode); `imageProvider: "none"`
 *     writes no region rows, so Search's per-hit highlight badge is 0 and never
 *     renders. Measured: a data dir with both set to "none" produced a Detail
 *     shot reading "no caption"/"no transcript" and a Search shot reading "No
 *     matches" — both captured cleanly, both useless as README assets.
 *   - **The query below only matches content that was actually recorded.** It is
 *     a fixed demo string, not a search for whatever happens to be there, so a
 *     data dir re-recorded with different content returns 0 frames and the
 *     contact sheet the README describes never appears.
 *
 * Both of the above are reasons the shots are worth LOOKING at after a run, not
 * just checking for the ✓ — the script cannot tell a thin store from a rich one.
 *
 * Nothing here spawns `ax-exec`. The Flows screen reads the stored graph and
 * never observes the live desktop, so unlike the Replay screen it replaced,
 * this run cannot ask for Accessibility permission.
 *
 * Usage: npm run gen:shots     (builds the library + app, then runs this)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Page } from "playwright-core";
import "../lib/renderer-globals.js";
// THE SAME launch as every probe, not a second copy of it. This file used to
// re-derive `executablePath`, launch-the-directory and the show-the-window
// dance by hand, and `launch.ts`'s own header said "both want the edit" — which
// is a drift hazard written down rather than fixed.
import { ROOT, gotoScreen, launchApp } from "../lib/launch.js";

const OUT_DIR = join(ROOT, "docs", "images");

/** Renderer width the PNGs are downscaled to. Matches the app's default window. */
const WIDTH = 1180;
const HEIGHT = 800;

/** How long to wait for a screen to settle before capturing it anyway. */
const SETTLE_MS = 8000;

/**
 * Optional id filter: `node scripts/shots.mjs mcp-pane settings`.
 *
 * Every shot is taken from the LIVE data dir, so a full run rewrites all of them
 * whenever the recordings change — which buries a one-image update in a diff
 * nobody asked for. Naming ids regenerates only those.
 */
const ONLY = new Set(process.argv.slice(2));

/**
 * One capture per screen. `nav` is the rail button's LABEL, never its index:
 * inserting Replay between Library and Search shifted every index below it, so
 * the "search" shot silently drove the Replay screen and waited 8s for a
 * `.searchbar` that was never going to appear. A label is what the shot means.
 *
 * `settle` is a selector that means "this screen has content"; `ready` is an
 * optional extra wait that may legitimately never arrive (no data, no provider
 * configured), in which case we capture the empty state and warn; `pick` is an
 * optional click made before the capture, to put the screen in the state the
 * screenshot is meant to show.
 */
interface DetailShot {
  id: string;
  /** What to click to open the detail view. */
  open: string;
  settle: string;
  /** Optional selection made inside the detail view before capturing. */
  select?: string;
  close: string;
}

/** One screenshot. Every field but `id`, `nav` and `settle` is best-effort. */
interface Shot {
  id: string;
  nav: string;
  settle: string;
  ready?: string;
  pick?: string;
  query?: string;
  scrollTo?: string;
  mcpWarmup?: readonly string[];
  detail?: DetailShot;
}

const SHOTS: Shot[] = [
  { id: "record", nav: "Record", settle: ".transport" },
  {
    id: "library",
    nav: "Library",
    settle: ".library, .empty",
    ready: ".player, .empty",
  },
  {
    id: "flows",
    nav: "Flows",
    // `.flows` is the screen either way; without a trace graph it renders one
    // line of prose instead of a stage, which is a legitimate empty state.
    settle: ".flows",
    ready: ".gcanvas, .flows .muted",
    // Select a node so the drawer is open — the graph alone doesn't show what
    // the screen is FOR, which is getting from a state back to its recordings.
    // Two filters, both about having something to show: `.is-unlocatable` marks
    // a node whose identity is only `app` or empty, so a locatable one is what
    // carries predicates; and a node with a keyframe fills the drawer's
    // thumbnail, which `--none` nodes leave blank.
    pick: ".gnode:not(.is-unlocatable):has(.gnode__shot:not(.gnode__shot--none))",
  },
  {
    id: "habits",
    nav: "Habits",
    // `.habits` is the screen either way; with no routes it renders the empty
    // state, which is legitimate rather than a failure.
    settle: ".habits",
    ready: ".habits__stage, .habits .empty",
    // Select the first row so the editor is populated. The list alone does not
    // show what the screen is FOR, which is the file it produces — and the
    // editor is where the prose sits above the record it cannot edit.
    pick: ".habit",
  },
  {
    id: "search",
    nav: "Search",
    settle: ".searchbar",
    // Chosen against the data, not invented. Three constraints, all measured
    // over four candidate queries on the current data dir:
    //   - it must match content that was ACTUALLY RECORDED (see the header
    //     note). The previous string described a pull-request review that
    //     appears in no recording;
    //   - it must produce region HIGHLIGHTS, since that is what the README says
    //     a hit carries. The previous string produced them for 0 of the 8 hits a
    //     1180x800 shot shows; this one, for 8 of 8. They now surface as the
    //     `on-screen label` lane in each row's evidence rather than as a badge
    //     over the thumbnail, so the constraint holds and what it looks like
    //     changed;
    //   - the results must be VARIED. Eight rows saying the same thing
    //     undersells the screen. The variety measurement below was taken when a
    //     row was labelled by its segment DIGEST; rows now lead with the VLM
    //     caption where one exists, which varies at least as much, so the
    //     ranking of these candidates is unchanged. Distinct digests over 30
    //     hits: "formatting text in TextEdit" 4, "the underline button in the
    //     text editor" 5, this one 14.
    query: "stop the recording",
    // The detail view is captured from SEARCH, and it used to be captured from
    // the Library for a reason that the 2026-08-16 rebuild removed.
    //
    // The old reason: a search hit's highlights include patch-map boxes, which
    // scattered across the frame as small unlabelled yellow rectangles and read
    // as noise, so the shot was taken where `highlights` is empty and selected an
    // AX row to draw one blue locator box instead. Every box on the frame is now
    // named in the panel's `Matched regions` list, so the same rectangles read as
    // an annotated result rather than as noise — and the two things this view
    // exists to answer, "why did this come back" and "what matched, where", only
    // exist on this path. Opened from the Library both sections are correctly
    // ABSENT, so that shot could not show them at all.
    //
    // It also fixes a shot that had been quietly degrading: the keyframe the
    // Library path landed on has AX elements 0, so the locator box it selected
    // for was never drawn and the warning had been firing for two regenerations.
    //
    // No `select`. The amber boxes arrive with the query, and clicking a matched
    // region would zoom the stage to that one control — worth doing by hand, but
    // a close-up of a button is not the image that shows what the screen is.
    detail: {
      id: "detail",
      open: ".result__open",
      settle: ".detail",
      close: ".detail__close",
    },
  },
  { id: "settings", nav: "Settings", settle: ".card" },
  {
    // Settings again, scrolled: the MCP pane is the fifth card down, so the
    // `settings` shot above cannot show it and app/README.md needs it by name.
    id: "mcp-pane",
    nav: "Settings",
    // `.mcp-log` rather than `.card`: it is the last thing in the pane to
    // render, so waiting on it means the whole card is there.
    settle: ".mcp-log",
    scrollTo: "Agent access",
    // The pane's whole point is the activity log, and a freshly launched app has
    // an empty one — a screenshot of "Nothing yet." documents the opposite of
    // what the feature is for. So the shot asks the endpoint a couple of real
    // questions first, the same way the Search shot runs a real query.
    mcpWarmup: ["list_recordings", "list_flows"],
  },
];

/**
 * Call a few MCP tools so the activity log has something in it.
 *
 * Read-only, like every tool it names. The URL is read from the pane rather than
 * assumed, so this follows the port wherever settings put it — and if the
 * endpoint failed to bind there is nothing to read and the shot proceeds without
 * it, which is the honest capture of that state.
 */
async function warmUpMcp(page: Page, tools: readonly string[]): Promise<void> {
  const url = await page.evaluate(() => {
    const cmd = [...document.querySelectorAll(".card .mono")]
      .map((e) => (e.textContent ?? "").trim())
      .find((t) => t.startsWith("claude mcp add"));
    return cmd ? cmd.split(" ").pop() : null;
  });
  if (!url) {
    console.warn("  ! mcp-pane: endpoint is not listening — capturing the log as-is");
    return;
  }
  let id = 0;
  const post = (body: unknown): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
  for (const name of tools) {
    await post({
      jsonrpc: "2.0",
      id: ++id,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gen:shots", version: "0" } },
    });
    await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: {} } });
  }
  await page.waitForTimeout(300);
}

async function capture(page: Page, id: string): Promise<void> {
  const png = await page.screenshot({ type: "png" });
  const out = join(OUT_DIR, `${id}.png`);
  await writeFile(out, await sharp(png).resize({ width: WIDTH }).png({ compressionLevel: 9 }).toBuffer());
  console.log(`  ✓ docs/images/${id}.png`);
}

/**
 * Wait for a selector, treating a timeout as "capture what's there" + a warning
 * rather than a failure — Library and Search depend on indexed data and a
 * configured provider, and a missing one should still yield an empty-state shot.
 * `act` (optional) runs first, inside the try, so a click that fails is softened too.
 */
async function soften(
  page: Page,
  selector: string | undefined,
  id: string,
  what: string,
  act?: () => Promise<unknown>,
): Promise<boolean> {
  if (!selector) return true;
  try {
    await act?.();
    await page.waitForSelector(selector, { timeout: SETTLE_MS, state: "visible" });
    return true;
  } catch {
    console.warn(`  ! ${id}: ${what} (${selector}) never appeared — capturing as-is`);
    return false;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const { app, page } = await launchApp({ width: WIDTH, height: HEIGHT });

  try {
    for (const shot of SHOTS) {
      if (ONLY.size > 0 && !ONLY.has(shot.id)) continue;
      console.log(`→ ${shot.id}`);
      // Anchored, never by index — `gotoScreen` throws unless exactly one rail
      // button matches, which is the rule this file learned the hard way.
      await gotoScreen(page, shot.nav);
      await soften(page, shot.settle, shot.id, "screen root");

      if (shot.query) {
        await page.locator(".searchbar input:not([type=file])").fill(shot.query);
        await page.locator(".searchbar .btn:not(.ghost)").click();
        await soften(page, ".results .result, .empty, .banner", shot.id, "results");
      }
      await soften(page, shot.ready, shot.id, "content");

      // Best effort, like the detail sub-shot: the state it selects may not
      // exist (an empty graph has no nodes), and an empty screen is still a
      // truthful screenshot.
      if (shot.pick) {
        await page
          .locator(shot.pick)
          .first()
          .click({ timeout: SETTLE_MS })
          .catch(() => console.warn(`  ! ${shot.id}: nothing to select (${shot.pick}) — capturing as-is`));
      }

      if (shot.mcpWarmup) await warmUpMcp(page, shot.mcpWarmup);

      // Bring a card below the fold into view, by its HEADING rather than by a
      // pixel offset — the cards above it change height whenever a setting is
      // added, and an offset would silently drift off the subject.
      if (shot.scrollTo) {
        await page.evaluate((heading) => {
          [...document.querySelectorAll(".card")]
            .find((c) => (c.querySelector("h2")?.textContent ?? "").includes(heading))
            ?.scrollIntoView({ block: "center" });
        }, shot.scrollTo);
        await page.waitForTimeout(400);
      }

      // Let images decode and the Lottie/spinner state settle. The Library video
      // stays paused on purpose — a playing <video> can composite as black.
      await page.waitForTimeout(1200);
      await capture(page, shot.id);

      // Best effort: only reachable when the screen above produced something to open.
      if (shot.detail) {
        const { id, open, settle, select, close } = shot.detail;
        console.log(`→ ${id}`);
        const target = page.locator(open).first();
        if ((await target.count()) && (await soften(page, settle, id, "detail view", () => target.click()))) {
          // The panel renders before its AX payload arrives, so `.detail` being
          // visible does not mean there are rows yet. locator.click() auto-waits;
          // a plain count() here would snapshot 0 and silently skip the selection.
          if (select) {
            await page
              .locator(select)
              .first()
              .click({ timeout: SETTLE_MS })
              .catch(() => console.warn(`  ! ${id}: no locatable AX row (${select}) — no locator box drawn`));
          }
          await page.waitForTimeout(1500);
          await capture(page, id);
          await page.locator(close).click();
        } else {
          console.warn(`  ! ${id}: nothing to open (${open}) — skipped`);
        }
      }
    }
  } finally {
    // Not page.close(): closing the window hides the app to the tray and hangs.
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}

await main();
