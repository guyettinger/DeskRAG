/**
 * Structured event digest (view 3): a templated, deterministic text summary of a
 * segment's signals. This text is what gets embedded, so the exact prose matters
 * less than that it is STABLE and carries the signal — the embedding handles
 * fuzzy matching.
 *
 * WHAT A PERSON SEARCHES FOR COMES FIRST, tallies last. The digest used to be
 * tallies only ("42 clicks, heavy scrolling, 5 keystrokes"), written when an
 * `action` segment was a ~10s window. Since `action` stopped subdividing, a real
 * action segment averages **945ms** — and measured over 105 real segments, the
 * tallies alone produced `1 click.` ×33, `mouse movement.` ×16 and `idle
 * segment` ×15: **61% carrying no discriminative content at all**, as
 * byte-identical strings that embed to one identical vector whose ANN order is
 * then arbitrary.
 *
 * Four signals that were already on disk and reached no view now do:
 *  - the focused WINDOW TITLE (`focus_change.title`) — the highest-value text on
 *    a desktop, and it was being parsed and discarded,
 *  - the URL (`url_change`),
 *  - the TEXT ACTUALLY TYPED, resolved from the session's own keymap,
 *  - the LABEL of what was clicked, resolved from the regions of the keyframe
 *    that was on screen.
 *
 * Typing/clicking are attributed to whichever app was focused at the time, by
 * walking events in order and tracking the current app from focus_change events.
 */

import type { Keymap } from "../capture/env/types.js";

export interface DigestEvent {
  tMono: number;
  kind: string;
  x?: number | null;
  y?: number | null;
  data?: unknown;
}

/**
 * The world the digest resolves its richer signals against. Every member is
 * optional and absence is always the safe degradation — a digest built with no
 * context is exactly the tally-only digest, never a guess.
 */
export interface DigestContext {
  /**
   * The keyboard layout in effect at a t_mono. WITHOUT IT NO TYPED TEXT IS
   * RECOVERED — never a US-QWERTY fallback. uiohook reports a keycode, not a
   * character, so a static table would fabricate typed content; this is the
   * same rule `resolveKeys` follows at lift time and the replay executor's
   * `type` step follows in the other direction.
   */
  keymapAt?: (tMono: number) => Keymap | undefined;
  /**
   * The FULL text of every typing run overlapping a segment's window.
   *
   * Resolved at SESSION scope by the caller (`Representer` derives it from
   * `keymapAt`), never from the segment's own events — `action` cuts at every
   * visual state change and typing IS one, so grouping per segment shredded a
   * sentence into `typed "this is"` / `typed "a test"` / `typed "of the"` and
   * left the phrase in no segment at all.
   */
  typedTextAt?: (tMonoStart: number, tMonoEnd: number) => string[];
  /**
   * The focused app/window/URL as of a t_mono — LATEST AT-OR-BEFORE, like every
   * other environment fact in this pipeline.
   *
   * Without it a segment only knows the app if a `focus_change` landed INSIDE
   * it, and since `action` stopped subdividing the average segment is 945ms and
   * contains no such event. Measured on real recordings: seeding from the
   * preceding focus state is what carries the app name — and with it the
   * "typed in X" attribution — into the segments that merely continue working
   * in an app rather than switching to it.
   */
  focusAt?: (tMono: number) => { app?: string; title?: string; url?: string } | undefined;
  /**
   * The label of the UI element at a screen point, as of `tMono`. Injected
   * rather than read from the store so `represent/digest.ts` stays pure — the
   * caller resolves it from the regions of the keyframe that was on screen.
   */
  labelAt?: (point: { x: number; y: number }, tMono: number) => string | undefined;
  /**
   * Cap on typed text carried into the digest. One long typing run would
   * otherwise swamp the embedding of everything else in the segment.
   */
  maxTypedChars?: number;
}

export const DEFAULT_MAX_TYPED_CHARS = 280;

interface AppTally {
  clicks: number;
  keys: number;
  scrolls: number;
}

function stringField(data: unknown, field: string): string | undefined {
  if (data && typeof data === "object" && field in data) {
    const v = (data as Record<string, unknown>)[field];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

const appOf = (data: unknown): string | undefined => stringField(data, "app");

/**
 * `https://github.com/guyettinger/DeskRAG/pull/39` -> the URL plus a bare
 * `github.com`, so a query naming just the site matches. Kept whole as well:
 * the path segments are often the most distinctive tokens in a whole session.
 */
function urlTerms(url: string): string[] {
  const terms = [url];
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1];
  if (host !== undefined) {
    const bare = host.replace(/^www\./i, "").replace(/:\d+$/, "");
    if (bare.length > 0 && bare !== url) terms.push(bare);
  }
  return terms;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** The segment this digest describes. Per-call, unlike the per-session context. */
export interface DigestWindow {
  tMonoStart: number;
  tMonoEnd: number;
}

export function buildDigest(
  events: readonly DigestEvent[],
  ctx: DigestContext = {},
  window?: DigestWindow,
): string {
  const ordered = [...events].sort((a, b) => a.tMono - b.tMono);

  let clicks = 0;
  let keys = 0;
  let scrolls = 0;
  let moves = 0;
  const appSeq: string[] = [];
  const titles: string[] = [];
  const urls: string[] = [];
  const clicked: string[] = [];
  const perApp = new Map<string, AppTally>();
  let currentApp: string | undefined;

  const push = (list: string[], value: string | undefined) => {
    if (value !== undefined && !list.includes(value)) list.push(value);
  };

  const tally = (fn: (t: AppTally) => void) => {
    if (currentApp === undefined) return;
    const t = perApp.get(currentApp) ?? { clicks: 0, keys: 0, scrolls: 0 };
    fn(t);
    perApp.set(currentApp, t);
  };

  // Seed from the focus state the segment INHERITED. A segment that merely
  // continues working in an app contains no focus_change of its own, so without
  // this it would name no app at all — and, since attribution keys on
  // `currentApp`, would drop its "typed in X" phrase too.
  const inherited = ctx.focusAt?.(window?.tMonoStart ?? ordered[0]?.tMono ?? 0);
  if (inherited !== undefined) {
    if (inherited.app !== undefined && inherited.app.length > 0) {
      currentApp = inherited.app;
      appSeq.push(inherited.app);
    }
    push(titles, inherited.title);
    for (const t of urlTerms(inherited.url ?? "")) if (t) push(urls, t);
  }

  for (const ev of ordered) {
    switch (ev.kind) {
      case "focus_change": {
        const app = appOf(ev.data);
        if (app !== undefined) {
          currentApp = app;
          if (appSeq[appSeq.length - 1] !== app) appSeq.push(app);
        }
        // A title is worth carrying even when the app name is missing — it is
        // the more specific of the two ("PR #39 · DeskRAG" vs "Google Chrome").
        push(titles, stringField(ev.data, "title"));
        for (const t of urlTerms(stringField(ev.data, "url") ?? "")) if (t) push(urls, t);
        break;
      }
      case "url_change": {
        for (const t of urlTerms(stringField(ev.data, "url") ?? "")) if (t) push(urls, t);
        break;
      }
      case "mouse_down":
        clicks++;
        tally((t) => t.clicks++);
        if (ctx.labelAt && typeof ev.x === "number" && typeof ev.y === "number") {
          push(clicked, ctx.labelAt({ x: ev.x, y: ev.y }, ev.tMono));
        }
        break;
      case "key_down":
        keys++;
        tally((t) => t.keys++);
        break;
      case "scroll":
        scrolls++;
        tally((t) => t.scrolls++);
        break;
      case "mouse_move":
        moves++;
        break;
    }
  }

  // Session-scope runs, resolved by the caller. A run spanning several segments
  // is carried WHOLE into each of them: every one of those moments is part of
  // composing that text, so each is a legitimate answer to a query for the
  // phrase, while the fragment inside the window is an answer to nothing.
  const typed =
    window !== undefined ? (ctx.typedTextAt?.(window.tMonoStart, window.tMonoEnd) ?? []) : [];

  const parts: string[] = [];

  // Identity first: the app and the window it was showing.
  if (appSeq.length > 0 || titles.length > 0) {
    const where =
      appSeq.length > 0 && titles.length > 0
        ? `${appSeq.join(" → ")} — ${titles.join(", ")}`
        : appSeq.length > 0
          ? appSeq.join(" → ")
          : titles.join(", ");
    parts.push(appSeq.length > 1 ? `app focus: ${where}` : where);
  }
  if (urls.length > 0) parts.push(urls.join(" "));

  // Then content: what was typed, and what was clicked by name.
  if (typed.length > 0) {
    const max = ctx.maxTypedChars ?? DEFAULT_MAX_TYPED_CHARS;
    let text = typed.join(" ");
    if (text.length > max) text = `${text.slice(0, max).trimEnd()}…`;
    parts.push(`typed "${text}"`);
  }
  if (clicked.length > 0) {
    parts.push(clicked.map((l) => `clicked "${l}"`).join(", "));
  }

  // Then the tallies, unchanged.
  const activity: string[] = [];
  if (clicks > 0) activity.push(plural(clicks, "click"));
  if (scrolls > 0) activity.push(scrolls <= 5 ? "light scrolling" : "heavy scrolling");
  if (keys > 0) activity.push(plural(keys, "keystroke"));
  if (activity.length === 0 && moves > 0) activity.push("mouse movement");
  if (activity.length > 0) parts.push(activity.join(", "));

  const appPhrases: string[] = [];
  for (const [app, t] of perApp) {
    if (t.keys > 0) appPhrases.push(`typed in ${app}`);
    else if (t.clicks > 0) appPhrases.push(`clicked in ${app}`);
    else if (t.scrolls > 0) appPhrases.push(`scrolled in ${app}`);
  }
  if (appPhrases.length > 0) parts.push(appPhrases.join(", "));

  if (parts.length === 0) return "idle segment";
  return `${parts.join(". ")}.`;
}
