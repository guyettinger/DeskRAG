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
 * All measurements below are from the author's real library on 2026-09-06: 12
 * recordings, 2026-08-17 -> 2026-08-29, SQLite opened read-only. `npm run
 * probe:identity` re-renders them.
 */

import type { DisplayInfo } from "../capture/env/types.js";
import { urlPrefix } from "../trace/url.js";
import type { Exclusivity } from "./facts.js";
import type { Identity } from "./identity.js";

/** One declared identity: the fact it is for, whether its values coexist, and the projection. */
export interface IdentityDeclaration<Raw, Canon> {
  /** The `event.kind` this identity reads. */
  kind: string;
  exclusivity: Exclusivity;
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

/** The `display_change` payload, as `ActiveWindowProducer` emits it. */
export interface DisplayTopologyPayload {
  displays: readonly DisplayInfo[];
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
 * MEASURED: 12 occurrences, 8 distinct payloads, **2** configurations. Seven of
 * the eight are the same 1920x1080@2 primary under a different `id` each session
 * (180, 185, 206, 219, 247, 296, 297) — macOS re-mints the identifier, so `id`
 * is a decoy and geometry is the discriminator. Keying a Knowledge fact on it
 * would have minted 8 facts where there are 2, on the first data it ever saw.
 *
 * COEXISTING: the two real configurations do not supersede one another. A laptop
 * is docked some days and not others, so "newer wins" would delete one that is
 * still true.
 *
 * An EMPTY list is `null`, not a configuration. `coerceDisplays` yields `[]` when
 * the display source fails, and a failed query is not a desktop with no screens.
 */
export const DISPLAY_TOPOLOGY: IdentityDeclaration<
  DisplayTopologyPayload,
  readonly DisplayGeometry[]
> = {
  kind: "display_change",
  exclusivity: "coexisting",
  identity: (payload) => {
    if (payload.displays.length === 0) return null;
    const geometry = payload.displays.map(
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
 * MEASURED: 92 occurrences, 63 distinct payloads, **7** bundle ids. THE TARGET
 * NUMBER IS QUESTION-DEPENDENT and that is why the question is declared here
 * rather than inferred: by `(bundleId, title)` the answer is 28, by `windowId`
 * it is 40, and all three are correct answers to different questions. A consumer
 * that wants 28 wants a SECOND identity, not an edit to this one.
 *
 * COEXISTING: seven applications are used, and no one of them is *the* app.
 */
export const FOCUSED_APP: IdentityDeclaration<FocusPayload, string> = {
  kind: "focus_change",
  exclusivity: "coexisting",
  identity: (payload) => nonEmpty(payload.bundleId) ?? nonEmpty(payload.app),
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
 * MEASURED: 44 occurrences, 19 distinct payloads, **17** identified plus **3**
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
  kind: "url_change",
  exclusivity: "coexisting",
  identity: (url) => urlPrefix(url) ?? null,
};

/**
 * `keymap_change` has NO identity, and that is a finding rather than an omission:
 * 12 occurrences and ONE distinct payload on the real library, so a projection
 * would buy zero. Recorded here so it is not added for symmetry.
 */
