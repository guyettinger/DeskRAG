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
 *   - Real recorded sessions in the data dir, or the Library/Search shots will
 *     capture empty states (the script warns rather than failing).
 *
 * Usage: npm run gen:shots     (builds the library + app, then runs this)
 */

import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { _electron as electron } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs", "images");

/** Renderer width the PNGs are downscaled to. Matches the app's default window. */
const WIDTH = 1180;
const HEIGHT = 800;

/** How long to wait for a screen to settle before capturing it anyway. */
const SETTLE_MS = 8000;

/**
 * One capture per screen. `nav` is the index of the rail button (DOM order in
 * App.tsx); `settle` is a selector that means "this screen has content"; `ready`
 * is an optional extra wait that may legitimately never arrive (no data, no
 * provider configured), in which case we capture the empty state and warn.
 */
const SHOTS = [
  { id: "record", nav: 0, settle: ".transport" },
  {
    id: "library",
    nav: 1,
    settle: ".library, .empty",
    ready: ".player, .empty",
    // The detail view is captured from the Library, not from Search, on purpose.
    // DetailView draws detail.highlights unconditionally, and a search hit carries
    // them — under ColSmol those are patch-argmax boxes, which scatter across the
    // frame as small yellow rectangles with no labels and read as noise. Opened
    // from the Library there is no query, so highlights is empty and the AX
    // locator (below) is the only thing drawn.
    detail: {
      id: "detail",
      open: '[aria-label="Inspect keyframe"]',
      settle: ".detail",
      // Select a labelled, on-frame AX node so the blue locator box + its label
      // land on the keyframe — the point of the panel. Rows marked --off are
      // outside the captured frame and would draw nothing.
      select: ".axtree__row:not(.axtree__row--off):has(.axtree__label)",
      close: ".detail__close",
    },
  },
  { id: "search", nav: 2, settle: ".searchbar", query: "reviewing the pull request in the editor" },
  { id: "settings", nav: 3, settle: ".card" },
];

async function capture(page, id) {
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
async function soften(page, selector, id, what, act) {
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

  // The app's own Electron, not a Playwright-managed browser.
  const appRequire = createRequire(join(ROOT, "app", "package.json"));
  const executablePath = appRequire("electron");

  // Launch the app DIRECTORY, not out/main/index.js. Electron derives app.getName()
  // — and therefore <userData> — from the package.json next to the entry point.
  // Pointing at the built file finds no package.json, so the app silently becomes
  // "Electron" and opens an empty ~/Library/Application Support/Electron instead of
  // the real DeskRAG data dir. app/package.json's "main" resolves the entry for us.
  const app = await electron.launch({
    executablePath,
    args: [join(ROOT, "app")],
    cwd: join(ROOT, "app"),
  });

  const page = await app.firstWindow();
  // The window is created with `show: false`; firstWindow() resolves before
  // ready-to-show, so pin the size ourselves rather than trusting the default.
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(w, h);
    win?.show();
  }, [WIDTH, HEIGHT]);
  await page.waitForSelector(".rail__nav .rail__item", { timeout: 30_000 });

  try {
    for (const shot of SHOTS) {
      console.log(`→ ${shot.id}`);
      await page.locator(".rail__nav .rail__item").nth(shot.nav).click();
      await soften(page, shot.settle, shot.id, "screen root");

      if (shot.query) {
        await page.locator(".searchbar input:not([type=file])").fill(shot.query);
        await page.locator(".searchbar .btn:not(.ghost)").click();
        await soften(page, ".sheet .frame, .empty, .banner", shot.id, "results");
      }
      await soften(page, shot.ready, shot.id, "content");

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
