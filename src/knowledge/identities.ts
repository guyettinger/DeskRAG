/**
 * The declared identities — which field decides sameness, per fact type.
 *
 * Data, not branches, on `src/embed/text-profiles.ts`'s precedent: a type's
 * quirks belong in a table because all of them fail silently when guessed. Each
 * declaration carries its projection, its exclusivity, and the measurement that
 * justifies it, because the measurement is what a later session needs before
 * changing one.
 *
 * A PROJECTION ENUMERATES WHAT IT KEEPS. A field a projection does not name is
 * dropped deliberately, so adding a field to `DisplayInfo` does not make it
 * discriminate — that is a decision, and it is made here.
 *
 * ## Environment or activity, and why the two axes are not independent
 *
 * On every declaration below `focused-app` implies `coexisting`, and that is not
 * a coincidence to be tidied away into one field. Two of these facts are the
 * ENVIRONMENT — a display topology and a keyboard layout are true of the desk
 * whether or not anyone is working, which is the paper's Knowledge, "what is
 * true". The other three are ACTIVITY distilled: which applications, which
 * windows, which sites. They are closer to the paper's Memory, "what happened",
 * and they can never supersede, because using Calculator today does not stop
 * TextEdit having been used.
 *
 * So an activity fact is structurally incapable of returning a current value,
 * and the honest reading of a screen full of refusals is that most of what a
 * desktop observes is history rather than truth. A LATER DECLARATION SHOULD ASK
 * WHICH OF THE TWO IT IS FIRST, and take its `attribution` and its `exclusivity`
 * from that answer rather than by analogy to whichever pair it resembles.
 *
 * All measurements below are from the author's real library on 2026-09-06: 13
 * recordings, 2026-08-17 -> 2026-09-06, 5851 events, SQLite opened read-only.
 * `npm run probe:identity` re-renders them, and it is the numbers that move —
 * the library grew by one recording between cycle 2 and cycle 3 and every count
 * here changed, which is why they are re-derived rather than quoted.
 */

import { coerceDisplays } from "../capture/env/parse.js";
import { urlPrefix } from "../trace/url.js";
import type { Exclusivity } from "./facts.js";
import type { Identity } from "./identity.js";

/**
 * Whether a fact is ABOUT the application that was frontmost when it was
 * sampled, and so inherits the recorder exclusion.
 *
 * A property of the fact TYPE, exactly like exclusivity, and declared here for
 * the same reason: it fails silently when guessed, and the failure is a screen
 * confidently stating something false.
 */
export type Attribution = "focused-app" | "ambient";

/** One declared identity: the fact it is for, whether its values coexist, and the projection. */
export interface IdentityDeclaration<Raw, Canon> {
  /**
   * What this fact IS, and the name a consumer addresses it by.
   *
   * SEPARATE FROM `kind`, because two declarations may read one event kind and
   * one of them now does. `FOCUSED_APP`'s own note promised this — "a consumer
   * that wants 28 wants a SECOND identity, not an edit to this one" — and a fact
   * identified by the event it reads could not keep that promise: two facts
   * would collide on one key, in the DTO, on the screen and in `get_fact`.
   *
   * `kind` stays, and stays disclosed: it says which recorded event a fact is
   * read FROM, which is a different question from what the fact is.
   */
  id: string;
  /** The `event.kind` this identity reads. */
  kind: string;
  exclusivity: Exclusivity;
  /**
   * Whether this fact is ABOUT the focused application, and so inherits the
   * recorder exclusion.
   *
   * MEASURED: applying the exclusion to the AMBIENT facts costs 6 of 13
   * recordings their display and keymap observations outright, because both are
   * sampled at session start while the recorder is still frontmost. The docked
   * configurations survived that by luck — each has a SINGLE observation and was
   * one coin flip from vanishing, which would have shown one setup where there
   * are three.
   *
   * `excludeFocusedApps` exists to drop WORK attributable to the recorder, and a
   * display configuration is not work: the display topology while the recorder
   * is frontmost is the same display topology.
   */
  attribution: Attribution;
  identity: Identity<Raw, Canon>;
}

/** One display's geometry, with the OS-minted `id` gone. */
export type DisplayGeometry = readonly [
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  primary: boolean,
];

/**
 * The `display_change` payload, as `ActiveWindowProducer` emits it.
 *
 * `displays` is `unknown` because this identity is fed rows READ BACK FROM DISK,
 * where nothing has re-checked the shape the producer wrote. Declaring
 * `DisplayInfo[]` here would move the check to a cast at whatever consumer
 * happened to build the payload, which is exactly where it was and exactly the
 * duplication this avoids.
 */
export interface DisplayTopologyPayload {
  displays: unknown;
}

/** Lexicographic over the tuple, so the OS's report order cannot mint a second value. */
function compareGeometry(a: DisplayGeometry, b: DisplayGeometry): number {
  for (let i = 0; i < 5; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return Number(a[5]) - Number(b[5]);
}

/**
 * `display_change` -> the sorted geometry of every display, `id` dropped.
 *
 * MEASURED: 13 occurrences, 9 distinct payloads, **3** configurations. Eleven of
 * the thirteen are the same 1920x1080@2 primary under a different `id` each
 * session — SEVEN ids for one screen (180, 185, 206, 219, 247, 296, 297) — macOS
 * re-mints the identifier, so `id` is a decoy and geometry is the discriminator.
 * Keying a Knowledge fact on it would have minted 9 facts where there are 3, on
 * the first data it ever saw.
 *
 * THE OTHER TWO ARE THE SAME DOCKED PAIR NUDGED 91px VERTICALLY: a 3840x2160
 * external at y = -797 in one recording and y = -706 in another, beside an
 * unmoved 1728x1117 primary. That pair is why `x` and `y` are KEPT — the panels
 * are identical and only the arrangement differs, so a projection dropping the
 * origin would report two desk setups as one. It is also what falsified the
 * CONSUMER's label: `displayLabel` rendered four of these six fields and printed
 * both configurations as one string, on this library, until it was measured.
 *
 * COEXISTING: the three real configurations do not supersede one another. A
 * laptop is docked some days and not others, so "newer wins" would delete one
 * that is still true.
 *
 * IT COERCES WITH THE FUNCTION THAT WROTE THE ROW. `coerceDisplays` is what
 * `ActiveWindowProducer` emitted through, and it requires a non-empty `id` and
 * finite `x/y/w/h/scale`; running it again here is not belt-and-braces, it is the
 * only thing standing between a malformed row and a NON-DETERMINISTIC canonical
 * form — `compareGeometry` subtracts, so one missing field makes the comparator
 * return `NaN` and the sort order, and therefore the identity, implementation-
 * defined. A consumer that hand-rolled the check instead would be the second
 * reader of one rule, which is the drift this file exists to prevent.
 *
 * An EMPTY list is `null`, not a configuration. `coerceDisplays` yields `[]` when
 * the display source fails, and a failed query is not a desktop with no screens —
 * so it is DISCLOSED as unidentified rather than folded into a value.
 */
export const DISPLAY_TOPOLOGY: IdentityDeclaration<
  DisplayTopologyPayload,
  readonly DisplayGeometry[]
> = {
  id: "display_topology",
  kind: "display_change",
  exclusivity: "coexisting",
  attribution: "ambient",
  identity: (payload) => {
    const displays = coerceDisplays(payload.displays);
    if (displays.length === 0) return null;
    const geometry = displays.map(
      (d): DisplayGeometry => [d.x, d.y, d.w, d.h, d.scale, d.primary],
    );
    return geometry.sort(compareGeometry);
  },
};

/** The fields of a `focus_change` payload this identity reads. */
export interface FocusPayload {
  app?: string;
  bundleId?: string;
}

/**
 * An EMPTY string is ABSENT. Both Swift sidecars already treat `AXTitle: ""`
 * that way, and the one place they disagreed cost a whole node its verification.
 */
const nonEmpty = (s: string | undefined): string | null =>
  s !== undefined && s.length > 0 ? s : null;

/**
 * `focus_change` -> the application's bundle id.
 *
 * DROPS `windowId`, `pid`, `bounds`, `title` and `url`. There are three decoys
 * here, not one: `windowId` and `pid` are re-minted per launch, and `bounds`
 * DRIFTS — the Calculator's main window was observed at (150, 231), (133, 242)
 * and (118, 253) across three recordings of the same work.
 *
 * MEASURED: 102 occurrences, 71 distinct payloads, **7** bundle ids. THE TARGET
 * NUMBER IS QUESTION-DEPENDENT and that is why the question is declared here
 * rather than inferred: by `(bundleId, title)` the answer is 29, by `windowId`
 * it is different again, and each is a correct answer to a different question. A
 * consumer that wants the window count wants a SECOND identity, not an edit to
 * this one — and that second identity is `FOCUSED_WINDOW`, immediately below.
 * This one still answers "which applications", and answering it did not change.
 *
 * COEXISTING: seven applications are used, and no one of them is *the* app.
 */
export const FOCUSED_APP: IdentityDeclaration<FocusPayload, string> = {
  id: "focused_app",
  kind: "focus_change",
  exclusivity: "coexisting",
  attribution: "focused-app",
  identity: (payload) => nonEmpty(payload.bundleId) ?? nonEmpty(payload.app),
};

/** The fields of a `focus_change` payload the WINDOW identity reads. */
export interface WindowPayload extends FocusPayload {
  title?: string;
}

/** One focused window: the application it belongs to, and its title. */
export type WindowIdentity = readonly [app: string, title: string];

/**
 * `focus_change` -> the application, and the title of the window inside it.
 *
 * THE SECOND IDENTITY OVER ONE EVENT KIND, and the reason `IdentityDeclaration`
 * carries an `id`. `FOCUSED_APP` reduces 71 distinct payloads to 7 applications;
 * this reduces the same 71 to **29** windows. Those are answers to different
 * questions — *which applications are used* and *which windows are worked in* —
 * and the way to have both is two declarations, not a widened projection.
 *
 * MEASURED: 102 occurrences, 71 distinct payloads, **29** windows, and **19
 * unidentified** — nearly a fifth of all focus events carry no title at all.
 * That number is why a missing title is DISCLOSED rather than dropped:
 * `active-win` does not always report one, and a fact that quietly ignored those
 * would rest on 83 observations while claiming 102.
 *
 * STILL DROPS `windowId`, `pid` and `bounds`, for the reasons `FOCUSED_APP`
 * names: the first two are re-minted per launch and the third DRIFTS, observed
 * at (150, 231), (133, 242) and (118, 253) across three recordings of one task.
 * A title is the only field of a `focus_change` that names what the window is
 * FOR rather than where the window happens to be.
 *
 * A TITLE IS NOT A DOCUMENT, and this deliberately stops short of pretending it
 * is. `docs/research/persistence-layers.md` §6 lists "that `Untitled — Edited`
 * and `report.md — Edited` are one document" as a Knowledge candidate; that is a
 * rename observed over TIME and no projection can see it, because the two titles
 * share nothing to project onto. Linking them needs a temporal rule, which is a
 * different mechanism and is not this one.
 *
 * The application comes FIRST in the tuple, and a consumer's label should keep
 * that order: an application name carries no separator a title might also carry,
 * so `app · title` stays unambiguous where `title · app` would not.
 *
 * COEXISTING and FOCUSED-APP, on `FOCUSED_APP`'s reasoning exactly — a window
 * worked in last week is not stopped from having been worked in by this week's,
 * and the recorder's own window is not work.
 */
export const FOCUSED_WINDOW: IdentityDeclaration<WindowPayload, WindowIdentity> = {
  id: "focused_window",
  kind: "focus_change",
  exclusivity: "coexisting",
  attribution: "focused-app",
  identity: (payload) => {
    const app = nonEmpty(payload.bundleId) ?? nonEmpty(payload.app);
    const title = nonEmpty(payload.title);
    // BOTH or nothing. A window with no title names nothing, and an untitled
    // window under an app that already has one would fold two different windows
    // together — `null` discloses it as unidentified instead.
    return app === null || title === null ? null : [app, title];
  },
};

/**
 * `url_change` -> `urlPrefix`, CALLED, NOT REIMPLEMENTED.
 *
 * A hand-written normalizer — lowercase, strip tracking parameters, drop the
 * trailing slash — was measured first and merged exactly one pair in nineteen.
 * `urlPrefix` merges the SAME pair. Equal results, so the tie goes to the rule
 * that already ships, and to the note `src/index.ts` carries: it is exported so
 * anything reading a recorded URL reads it the way node identity does, "rather
 * than growing a second, quietly different prefix rule." Writing one here would
 * have been that rule, and it would have looked correct.
 *
 * MEASURED: 50 occurrences, 23 distinct payloads, **21** identified plus **3**
 * unidentified. The three are `chrome://new-tab-page/`, which names no site —
 * `urlPrefix` already returns `undefined` for `file:`, `chrome:` and `about:`,
 * and passing that through as `null` discloses them instead of inventing an
 * eighteenth site.
 *
 * The grain is the SITE: `urlPrefix` caps at three path segments and drops query
 * and fragment, so two pages of one site stay apart while a scroll anchor does
 * not mint a value. Adopting it means the Knowledge layer and the trace graph
 * cannot drift on what a URL IS.
 */
export const VISITED_PAGE: IdentityDeclaration<string, string> = {
  id: "visited_page",
  kind: "url_change",
  exclusivity: "coexisting",
  attribution: "focused-app",
  identity: (url) => urlPrefix(url) ?? null,
};

/** The fields of a `keymap_change` payload this identity reads. */
export interface KeymapPayload {
  layoutId?: string;
}

/**
 * `keymap_change` -> the keyboard layout's identifier.
 *
 * DECLARED BY THE CONSUMER, AND ONLY A CONSUMER COULD HAVE DECLARED IT. This
 * file used to record `keymap_change` as having no identity, on a measurement
 * that is still exactly right: 13 occurrences, ONE distinct payload, so a
 * projection buys zero VALUES. The note said so and said not to add one for
 * symmetry.
 *
 * What the fold count cannot see is that a projection also decides what a
 * consumer SEES, and the raw payload is `{ layoutId, entries: { …70 keycode
 * mappings… } }`. Seventy entries is not a value that goes on a screen or into
 * a tool response; `layoutId` is. That is `DISPLAY_TOPOLOGY`'s own argument —
 * a projection makes the decoy structurally unable to reach a consumer —
 * applied to bulk rather than to a decoy.
 *
 * EXCLUSIVE, and that half is load-bearing. It makes this the one declared fact
 * that RETURNS a value: `currentValue` refuses every `coexisting` fact, so a
 * screen built on the other three could only ever show DeskRAG declining, three
 * times, which teaches that refusing is the only thing the layer does. It
 * resolves to `"com.apple.keylayout.US"` with the reason "The only value
 * observed for keymap_change."
 *
 * A keyboard layout supersedes: switching to Dvorak means US is no longer the
 * layout, where docking a laptop does not stop the undocked geometry being real.
 *
 * AMBIENT: sampled at session start, while the recorder is still frontmost. See
 * `IdentityDeclaration.attribution` — measured, excluding it costs 6 of 13
 * recordings their keymap observation entirely.
 */
export const KEYBOARD_LAYOUT: IdentityDeclaration<KeymapPayload, string> = {
  id: "keyboard_layout",
  kind: "keymap_change",
  exclusivity: "exclusive",
  attribution: "ambient",
  identity: (payload) => nonEmpty(payload.layoutId),
};
