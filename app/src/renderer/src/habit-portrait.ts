/**
 * What the band under `<h1>What you do repeatedly</h1>` says.
 *
 * The h1 has always asked a question and been answered by a file list. This is
 * the answer: WHERE your repeated work happens, and HOW MUCH of what you record
 * recurs at all — `post.md`'s second lesson, that routines are proof of who you
 * are, made into something a glance can read.
 *
 * A `.ts` module, never `.tsx`: the root `tsconfig.json` sets no `jsx`, so a
 * root test that reaches into a `.tsx` — even for a type — breaks
 * `npm run typecheck`. Main decides what a route MEANS; this decides how the
 * library reads as a whole.
 *
 * NO SCORE. There is no ratio, no percentage and no grade here. `share` is a
 * bar WIDTH against the top bar and is never printed; the counts are printed
 * only in words, through `placeLabel`, for the same reason a ledger mark
 * carries no timestamp on its face.
 *
 * There is deliberately no insufficiency state. The coverage line IS this
 * band's honesty: on a thin library it says something true and small, and its
 * smallness is the disclosure. That is what makes the portrait the one of C2's
 * three surfaces that can fire on a six-day store.
 */

import type { HabitDTO, HabitProposalDTO } from "@shared/types";

/** One application, and how much repeated work happens in it. */
export interface PortraitPlace {
  app: string;
  /** Recordings of recurring routes that pass through this application. */
  recordings: number;
  /** 0..1 against the TOP place — a bar width, never shown as a number. */
  share: number;
}

export interface Portrait {
  /** Heaviest first; ties on first appearance, so reloads do not reshuffle. */
  places: PortraitPlace[];
  /** One line: distinct recordings, routes, walked-again, written-down. */
  coverage: string;
  /** Nothing recurs, so the band draws nothing at all. */
  empty: boolean;
}

/** One recurring route, flattened so a habit and a proposal weigh the same. */
interface Source {
  apps: readonly string[];
  recordings: number;
  sessionIds: readonly string[];
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The recurring routes, from both halves of the screen.
 *
 * A KEPT habit is included at any recording count, because keeping it is a
 * human act asserting the recurrence and a deleted recording must not silently
 * retract it. An unkept proposal needs `count > 1` to be in the picture at all —
 * nobody has claimed it, so the only evidence it is a habit is that it recurred.
 */
function sourcesOf(data: {
  habits: readonly HabitDTO[];
  proposals: readonly HabitProposalDTO[];
}): Source[] {
  return [
    ...data.habits
      .filter((h) => h.state === "active")
      .map((h) => ({
        apps: h.apps,
        recordings: h.binding.recordings,
        sessionIds: h.binding.walks.map((w) => w.sessionId),
      })),
    ...data.proposals
      .filter((p) => p.count > 1)
      .map((p) => ({ apps: p.apps, recordings: p.count, sessionIds: p.sessionIds })),
  ];
}

export function portraitOf(data: {
  habits: readonly HabitDTO[];
  proposals: readonly HabitProposalDTO[];
}): Portrait {
  const sources = sourcesOf(data);

  const weight = new Map<string, number>();
  for (const s of sources) {
    for (const app of s.apps) weight.set(app, (weight.get(app) ?? 0) + s.recordings);
  }
  // `Array.prototype.sort` is stable, and a Map iterates in insertion order, so
  // a tie keeps first appearance without a second key.
  const ranked = [...weight].sort((a, b) => b[1] - a[1]);
  const peak = ranked[0]?.[1] ?? 0;

  // DISTINCT ids, never the sum of route counts: one recording can walk two
  // routes, and summing would report more recordings than the library holds.
  const ids = new Set<string>();
  for (const s of sources) for (const id of s.sessionIds) ids.add(id);

  // COMPUTED, not restated as the route count. The spec expected these to be
  // equal by construction; they are equal only while every kept habit still
  // holds two recordings, and `lostSessionIds` exists because that can end.
  const walkedAgain = sources.filter((s) => s.recordings > 1).length;
  const written = data.habits.filter((h) => h.state === "active").length;

  return {
    places: ranked.map(([app, recordings]) => ({
      app,
      recordings,
      share: peak <= 0 ? 0 : recordings / peak,
    })),
    coverage: [
      // WORDED as a count of recordings that walked a route, never as the
      // library total: some recordings walk nothing, and this band cannot see
      // them. Deriving it from the walks already on the wire also means it can
      // never disagree with the ledgers drawn below it.
      `${plural(ids.size, "recording")} walked a route`,
      plural(sources.length, "route"),
      `${walkedAgain} walked again`,
      `${written} written down`,
    ].join(" · "),
    empty: sources.length === 0,
  };
}

/** What one bar says when a reader asks it. Words, never a bare number. */
export function placeLabel(place: PortraitPlace): string {
  return `${place.app} · ${plural(place.recordings, "recording")} of repeated work`;
}
