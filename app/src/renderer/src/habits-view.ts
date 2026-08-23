/**
 * How the Habits screen orders and labels what it is given.
 *
 * A `.ts` module, never `.tsx`: the root `tsconfig.json` sets no `jsx`, so a
 * root test that reaches into a `.tsx` — even for a type — breaks
 * `npm run typecheck`. Main decides what a row MEANS; this decides how it reads.
 */

import type {
  HabitBindState,
  HabitDTO,
  HabitProposalDTO,
  WalkFitDTO,
  WalkMarkDTO,
} from "@shared/types";

/**
 * Which band a habit is drawn in.
 *
 * "Needs attention" leads, because a habit whose evidence moved is the only
 * thing on this screen that can be silently wrong, and a band that sorts below
 * the ones that are fine would hide exactly that.
 */
export type HabitBand = "attention" | "mine" | "archived";

const NEEDS_ATTENTION: readonly HabitBindState[] = ["rebound", "ambiguous", "orphaned"];

export function bandOf(habit: HabitDTO): HabitBand {
  if (habit.state === "archived") return "archived";
  // A duplicate needs attention for the same reason a re-bind does: something
  // about this habit is unresolved and only a person can resolve it. It is not
  // a binding STATE — the binding is exact and correct on both halves — so it
  // is checked separately rather than folded into `HabitBindState`.
  if (habit.duplicates.length > 0) return "attention";
  return NEEDS_ATTENTION.includes(habit.binding.state) ? "attention" : "mine";
}

/**
 * Pinned first, then newest-touched.
 *
 * `updatedAt` rather than `createdAt`, so editing a habit moves it to the top of
 * its band — the thing just worked on is the thing being looked for.
 */
export function orderHabits(habits: readonly HabitDTO[]): HabitDTO[] {
  return [...habits].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
  );
}

export interface HabitBands {
  attention: HabitDTO[];
  mine: HabitDTO[];
  archived: HabitDTO[];
}

/** Active and archived split, dismissals dropped — they are not habits. */
export function bandHabits(habits: readonly HabitDTO[]): HabitBands {
  const out: HabitBands = { attention: [], mine: [], archived: [] };
  for (const s of orderHabits(habits)) {
    if (s.state === "dismissed") continue;
    out[bandOf(s)].push(s);
  }
  return out;
}

/**
 * The chip on a row, or null when nothing moved.
 *
 * An `exact` binding that lost a recording still gets one: a route can keep its
 * key and lose evidence, and reading as intact would overstate what is there.
 */
export function bindingChip(habit: HabitDTO): string | null {
  const b = habit.binding;
  // Said FIRST: a duplicate is the one thing here that another habit also
  // claims, and a row reading "re-bound" while two files describe one route
  // points at the smaller of the two problems.
  if (habit.duplicates.length > 0) return "duplicated";
  switch (b.state) {
    case "rebound":
      return "re-bound";
    case "ambiguous":
      return "split";
    case "orphaned":
      return "orphaned";
    case "exact":
      return b.lostSessionIds.length > 0 ? "evidence changed" : null;
  }
}

/**
 * The recording count, said in a way that cannot claim more than it has.
 *
 * The live count and the bind-time count are both printed when they differ,
 * because their disagreement is the fact this screen exists to show — the
 * `observations` vs `sources` rule, one level up.
 */
export function evidenceLine(habit: HabitDTO): string {
  const b = habit.binding;
  const bound = b.boundSessionIds.length;
  const times = (n: number): string => `${n} recording${n === 1 ? "" : "s"}`;

  if (b.state === "orphaned" || b.state === "ambiguous") {
    return `written from ${times(bound)}, none of which are in a current route`;
  }
  if (b.lostSessionIds.length > 0) {
    return `${times(b.recordings)} — was ${bound} when this was kept`;
  }
  if (b.gainedSessionIds.length > 0) {
    return `${times(b.recordings)} — ${b.gainedSessionIds.length} recorded since`;
  }
  return times(b.recordings);
}

/**
 * What the count MEANS, in words.
 *
 * There was a `×N` glyph here too, in muted mono in the row's gutter. It is
 * gone: recurrence is now drawn as one mark per recording and said in this
 * sentence, and a third statement of the same fact was the only one of the
 * three that could be read as nothing but a number.
 *
 * Worded from `RouteList`'s own `title`, which states the same fact about the
 * same routes on the Flows screen; the two surfaces must not describe one route
 * differently. Here rather than in the .tsx because a projection is what the
 * root suite can reach — `.tsx` is not.
 */
export function proposalEvidence(p: HabitProposalDTO): string {
  if (p.count === 1) return "recorded once";
  return `${p.count} recordings walked this`;
}

/**
 * The same fact for a tooltip, with the agreement clause `RouteList` discloses.
 *
 * Agreement is REPORTED, never smoothed over: recordings that share a shape can
 * disagree about what they were for.
 */
export function proposalTitle(p: HabitProposalDTO): string {
  const base = `${p.count} recording${p.count === 1 ? "" : "s"} took this path`;
  return p.name !== null && p.nameObservations < p.count
    ? `${base} · ${p.nameObservations} of them called it \u201C${p.name}\u201D`
    : base;
}

/**
 * Proposals in `frequentRoutes`' own order — count first, then length.
 *
 * The order is preserved rather than recomputed: main already sorted them, and a
 * second sort here would be a second opinion about what "most walked" means.
 */
export function orderProposals(proposals: readonly HabitProposalDTO[]): HabitProposalDTO[] {
  return [...proposals];
}

/**
 * Why "Generate with model" is unavailable, in words.
 *
 * A greyed control with no reason is the thing `StageSpec.skipReason` exists to
 * prevent one screen over: a stage that merely never appears is
 * indistinguishable from one nobody implemented.
 */
export function generateDisabledReason(prose: {
  available: boolean;
  model: string | null;
}): string | null {
  return prose.available
    ? null
    : "No summary model is configured, so the template writes this. Settings → Providers.";
}

/**
 * Proposals split by whether anything has actually recurred.
 *
 * The screen's whole argument is that doing a thing once and doing it
 * repeatedly are different in kind — an act versus a habit — and until this
 * split they were drawn as one list distinguished by an `×1` in muted mono in a
 * gutter. Measured on the real store: four proposals, every one of them `×1`,
 * presented exactly as a route walked five times would be.
 *
 * A partition of `orderProposals`' order, never a re-sort: main already decided
 * what "most walked" means, and a second opinion here would contradict it.
 */
export interface ProposalBands {
  repeated: HabitProposalDTO[];
  once: HabitProposalDTO[];
}

export function bandProposals(proposals: readonly HabitProposalDTO[]): ProposalBands {
  const out: ProposalBands = { repeated: [], once: [] };
  for (const p of orderProposals(proposals)) {
    (p.count > 1 ? out.repeated : out.once).push(p);
  }
  return out;
}

/** One walk, placed along the screen's shared axis. `x` is a 0..1 fraction. */
export interface LedgerMark {
  sessionId: string;
  x: number;
  gained: boolean;
  /**
   * The walk this mark stands for, carried rather than left to be re-joined by
   * index. The renderer asks it what to say on hover, and pairing two arrays
   * positionally is a coupling that survives exactly until one of them is
   * filtered — which `walkMarks` already does, for a recording whose row is
   * gone.
   */
  walk: WalkMarkDTO;
}

/**
 * Walks placed on the SHARED domain, oldest at 0 and newest at 1.
 *
 * Shared is the whole point: every row is drawn against the same span, so a
 * route walked three times last week and a route walked three times in March
 * read differently at a glance. Scaling each row to its own extent would draw
 * them identically, which is the thing a count already does.
 *
 * A domain of zero width places every mark at the CENTRE rather than at an end.
 * It happens when the library holds a single moment, and there the axis carries
 * no information at all — putting the marks hard right would assert recency the
 * data cannot support.
 */
export function ledgerMarks(
  walks: readonly WalkMarkDTO[],
  domain: { from: number; to: number } | null,
): LedgerMark[] {
  if (domain === null) return [];
  const width = domain.to - domain.from;
  return walks.map((w) => ({
    sessionId: w.sessionId,
    x: width <= 0 ? 0.5 : (w.at - domain.from) / width,
    gained: w.gained,
    walk: w,
  }));
}

/**
 * What a mark says about itself, per row.
 *
 * `lone` and conformance are MUTUALLY EXCLUSIVE BY CONSTRUCTION: the ring means
 * exactly one recording, and a standard needs two walks to exist at all. That is
 * the only reason a third channel fits on a seven-pixel dot — the ring is free
 * wherever conformance is possible.
 *
 * Takes the ROW, not one mark, because `lone` is a property of the row and a
 * per-mark signature could not see it.
 *
 * NULL IS NOT CANONICAL. Null means no standard existed; canonical means one
 * existed and this walk matched it. Drawing them alike would claim a habit
 * recorded once passed a check that was never run.
 */
export type MarkState = "lone" | "canonical" | "deviated" | "short" | null;

export function markStates(marks: readonly LedgerMark[]): MarkState[] {
  if (marks.length === 1) return ["lone"];
  return marks.map((m) => {
    const fit = m.walk.fit;
    if (fit === null) return null;
    // SHORT OUTRANKS DEVIATED. A walk that stopped will almost always also show
    // skipped steps, and reporting it as merely deviated buries the reason.
    if (!fit.reachedEnd) return "short";
    return fit.inserted + fit.skipped + fit.reordered > 0 ? "deviated" : "canonical";
  });
}

const DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/**
 * When this was walked, in words — the half a count cannot say.
 *
 * A count answers "how often" and stops there, so a habit abandoned in March
 * and one practised all week print the same `3 recordings`. post.md's third
 * lesson is that habits are what you change, which is unanswerable without a
 * date. Null when there is nothing to say rather than "unknown": an absent line
 * is quieter than a line admitting it knows nothing.
 */
export function walkSpan(walks: readonly WalkMarkDTO[]): string | null {
  if (walks.length === 0) return null;
  const first = DAY_MONTH.format(new Date(walks[0]!.at));
  const last = DAY_MONTH.format(new Date(walks[walks.length - 1]!.at));
  return first === last ? first : `${first} – ${last}`;
}

/**
 * What one mark on the ledger says when a reader asks it.
 *
 * The ledger is the screen's signature and was, until now, a picture with no
 * way in: a mark IS a recording, and the reader could neither name it nor go
 * and watch it. This is the sentence the hover card and the mark's own
 * accessible name are both built from, so a pointer and a screen reader are
 * told the same thing — position is a metaphor, and the words are the fact.
 *
 * Formatters are INJECTED because `api.ts` reads `window.deskrag` at module
 * scope and a root test cannot import it; this module is `.ts` precisely so the
 * root suite can reach it. Same rule as `readoutAt(…, { label })` one screen
 * over. They are `wallClock` and `timecode` from `api.ts` at every call site,
 * so the ledger names a moment exactly as the Flows drawer's recordings list
 * does — two evidence surfaces, one voice.
 */
export interface MarkReadout {
  /** Wall clock: WHEN in a person's life this happened. */
  when: string;
  /** Where inside the recording, and how far it ran. Null with no walk. */
  at: string | null;
  /** THIS recording's own path, never the route's union. Null with no walk. */
  steps: string | null;
  /**
   * How this recording compared to the standard. Null when none exists.
   *
   * Worded from `differBlock`'s own sentences, so the file and the screen cannot
   * describe one recording differently — the same rule that made `differBlock`
   * carry `Baseline.reason` verbatim.
   */
  fit: string | null;
  /** Recorded since the habit was kept, or why there is nothing to open. */
  note: string | null;
  /** The affordance, in words. Null when there is nothing to open. */
  action: string | null;
}

/** The fit in words, or null. COUNTS, never a grade — a deviation is not a failure. */
function fitClause(fit: WalkFitDTO | null): string | null {
  if (fit === null) return null;
  const bits: string[] = [];
  if (fit.inserted > 0) {
    bits.push(`${fit.inserted} step${fit.inserted === 1 ? "" : "s"} not in the standard`);
  }
  if (fit.skipped > 0) bits.push(`${fit.skipped} of the standard's steps not taken`);
  if (fit.reordered > 0) {
    bits.push(`${fit.reordered} step${fit.reordered === 1 ? "" : "s"} taken in a different order`);
  }
  const head = bits.length === 0 ? "Followed the standard" : bits.join(", ");
  return fit.reachedEnd ? `${head}.` : `${head}. Stopped before the end.`;
}

export function markReadout(
  mark: WalkMarkDTO,
  fmt: { wallClock: (ms: number) => string; timecode: (ms: number) => string },
): MarkReadout {
  const walk = mark.walk;
  return {
    when: fmt.wallClock(mark.at),
    at:
      walk === null
        ? null
        : `${fmt.timecode(walk.atSec * 1000)} – ${fmt.timecode(walk.throughSec * 1000)}`,
    steps: walk === null ? null : `${walk.steps} step${walk.steps === 1 ? "" : "s"}`,
    fit: fitClause(mark.fit),
    // A dead link is worse than none, so a mark that cannot be followed SAYS
    // why rather than going quietly grey — the `StageSpec.skipReason` rule one
    // screen over. It happens to an orphaned or ambiguous habit, whose marks
    // come from the ids it was kept with because there is no live route left.
    note:
      walk === null
        ? "Not in a current route, so there is no moment to open"
        : mark.gained
          ? "Recorded since you kept this"
          : null,
    action: walk === null ? null : "Open this recording",
  };
}

/** The same readout as one line — a mark's accessible name and its tooltip. */
export function markLabel(readout: MarkReadout): string {
  return [readout.when, readout.at, readout.steps, readout.fit, readout.note]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
