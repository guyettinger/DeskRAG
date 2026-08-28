/**
 * launch.ts — the DeskRAGApp launch dance, in ONE place.
 *
 * Every rule encoded here failed silently at least once before it was written
 * down; see `.claude/skills/run-app/SKILL.md` for what each one cost.
 *
 * It used to live in that skill directory, which made six npm-invoked probes
 * depend on agent tooling, and `scripts/gen/shots.ts` re-derived the launch by
 * hand anyway — its own header said "both want the edit", which is how a
 * contract drifts. There is now one copy and every caller imports it: the six
 * probes, the screenshot generator, and the skill's workbench scripts (which
 * run under `npx tsx` for that reason).
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

/**
 * The root tsconfig has no `dom` lib — this project is Node, and adding it
 * repo-wide would let renderer globals typecheck inside `src/`, which they must
 * never do. The two predicates below are SERIALIZED and run in the page, so
 * only the names have to resolve here. Declared as narrowly as they are used.
 */
declare const document: {
  querySelectorAll(selector: string): Iterable<{ querySelector(s: string): unknown }>;
};

/** Repo root: this file lives at <root>/scripts/lib/. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The five rail screens, by the LABEL each button actually renders. */
export const SCREENS = ["Record", "Library", "Flows", "Search", "Settings"] as const;

/**
 * Launch the built app and return its window.
 *
 * Throws rather than limping if the build is missing: driving a stale `app/out`
 * silently exercises the PREVIOUS version of whatever you are checking, which
 * looks like success.
 */
export interface LaunchOptions {
  width?: number;
  height?: number;
  /** Moves <userData> wholesale — see the note on `args` below. */
  userDataDir?: string | null;
}

export async function launchApp({
  width = 1400,
  height = 1000,
  userDataDir = null,
}: LaunchOptions = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const out = join(ROOT, "app", "out", "main", "index.js");
  if (!existsSync(out)) {
    throw new Error(
      `app/out is missing — run:  npm run build && npm --prefix app run build\n` +
        `(the app imports dist/, and electron-vite builds to app/out/)`,
    );
  }

  // The app's OWN Electron, not a Playwright-managed browser: it is the binary
  // whose ABI matches app/node_modules/better-sqlite3.
  const appRequire = createRequire(join(ROOT, "app", "package.json"));

  const app = await electron.launch({
    // Launch the DIRECTORY. Electron derives app.getName() — and so <userData>
    // — from the package.json beside the entry point; pointing at
    // app/out/main/index.js finds none, the app becomes "Electron", and it
    // opens an EMPTY ~/Library/Application Support/Electron instead of the real
    // DeskRAG data dir. No error, just a working app with no recordings.
    executablePath: appRequire("electron"),
    // `--user-data-dir` moves <userData> wholesale, which is the ONLY way to
    // drive a check that writes without writing the user's own library. The
    // app still resolves its data dir as <userData>/DeskRAG, so a probe using
    // this must place the copied app.db and lance/ inside that subdirectory.
    // Omitted by default: a read-only check wants the REAL store, because a
    // fixture agrees with whatever the code assumes.
    args: [...(userDataDir === null ? [] : [`--user-data-dir=${userDataDir}`]), join(ROOT, "app")],
    cwd: join(ROOT, "app"),
  });

  const page = await app.firstWindow();
  // The window is created with `show: false`, and firstWindow() resolves before
  // ready-to-show — so size and show it here rather than trusting a default.
  await app.evaluate(({ BrowserWindow }, [w, h]: [number, number]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(w, h);
    win?.show();
  }, [width, height] as [number, number]);

  await page.waitForSelector(".rail__nav .rail__item", { timeout: 30_000 });
  return { app, page };
}

/**
 * Click a rail button by LABEL.
 *
 * Never by index: inserting a screen shifts every index below it, and the shot
 * that meant "Search" then drives a different screen and waits out its timeout
 * on a selector that will never appear. An anchored regex also stops a future
 * "Recordings" from matching "Record" — `hasText` is a substring test.
 */
export async function gotoScreen(page: Page, label: string): Promise<void> {
  const tab = page.locator(".rail__nav .rail__item", { hasText: new RegExp(`^${label}$`) });
  const n = await tab.count();
  if (n !== 1) {
    throw new Error(`expected exactly one rail button labelled "${label}", found ${n}`);
  }
  await tab.click();
}

/**
 * Wait until a selector has actually been POPULATED, not merely mounted.
 *
 * The screens hydrate over IPC after they mount, so an elapsed-time wait gives
 * a confident wrong answer: the Library rail read as "zero keyframes" 2.5s in,
 * while the screenshot taken moments later showed 21. Wait on the content.
 *
 * @param container selector for the thing that must exist
 * @param content   selector that must appear INSIDE it for the data to be here
 */
export async function waitForContent(
  page: Page,
  container: string,
  content: string,
  timeout = 20_000,
): Promise<void> {
  await page.waitForSelector(container, { timeout });
  await page.waitForFunction(
    ([c, inner]: [string, string]) =>
      [...document.querySelectorAll(c)].some((el) => el.querySelector(inner)),
    [container, content] as [string, string],
    { timeout },
  );
}

/** The Library's rail is populated once any lane has drawn something. */
export async function waitForRail(page: Page, timeout = 20_000): Promise<void> {
  await waitForContent(page, ".tracks__lane", ".tracks__span, .tracks__thumb, .tracks__mark", timeout);
}
