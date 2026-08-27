/**
 * The record's blocks, as instruments rather than as a markdown dump.
 *
 * The Habits editor used to end in a `<pre>` holding the generated file from
 * `## What varies` down. Measured in the running app on the author's real
 * store, that well was 835x420 of monospace prose, and its largest section was
 * FIFTY-SIX consecutive lines of this shape:
 *
 *   - Lifting note on Way A step 5: key event at 40598.795916999996 has no
 *     resolved char (keycode 42); no text gesture emitted
 *
 * Fifty-three raw `t_mono` floats and macOS keycodes, under a heading a person
 * reads as "what this evidence does not say", burying the five sentences that
 * actually qualify the evidence. That is the reading this module exists to
 * restore.
 *
 * THE FILE IS NOT REDRAWN HERE. `HABIT.md` is rendered in main and handed out
 * verbatim — `Copy HABIT.md` and `get_habit` return the same string, and none
 * of it passes through this file. This is a SECOND RENDERER of the same facts,
 * the shape `WayForkView` already established: safe only because neither
 * parses the other's output, and both read one projection from main.
 *
 * A `.ts` module, never `.tsx`, so the root suite can reach it — the rule
 * `habit-portrait.ts`, `habit-rhythm.ts` and `way-fork-view.ts` state.
 *
 * NO SCORE. A `share` scales a bar and is never printed; a duration is printed
 * as a duration. Nothing here computes a rate, a percentage or a grade.
 */

import type { HabitTimingsDTO, HabitWayDTO } from "@shared/types";

/** "A", "A and B", "A, B and C" — no Oxford comma, matching the record's prose. */
function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export interface LiftingRollup {
  count: number;
  /** The disclosure's own label: what is behind it, without opening it. */
  summary: string;
  /** Every note, each saying where it came from. Oldest way first. */
  notes: string[];
}

/**
 * The lifting notes, counted and located — the disclosure's contents.
 *
 * NULL when there are none, so the healthy case draws nothing at all rather
 * than an empty toggle. This is the one place in the section where absence is
 * not a withheld reading: a route that lifted cleanly has nothing to disclose,
 * and a control saying "0 lifting notes" would be chrome.
 *
 * Rebuilt HERE from `HabitStepDTO.liftWarnings`, which the renderer already
 * holds, rather than carried on `HabitDTO.cautions` — putting them on the wire
 * would move the burial across the process boundary instead of undoing it.
 */
export function liftingRollup(ways: readonly HabitWayDTO[]): LiftingRollup | null {
  const notes: string[] = [];
  const lettered: string[] = [];
  // ONE way needs no letter. "Way A step 5" claims a distinction against ways
  // that are not being drawn, and the record's own `where` drops it too.
  const many = ways.length > 1;

  for (const way of ways) {
    let any = false;
    for (const step of way.steps) {
      for (const w of step.liftWarnings) {
        // Steps are numbered from ONE, matching the numbers printed beside them
        // — a note pointing at "step 4" that sits under a row labelled 5 is
        // worse than no note.
        const where = many ? `Way ${way.letter} step ${step.index + 1}` : `Step ${step.index + 1}`;
        notes.push(`${where}: ${w}`);
        any = true;
      }
    }
    // A way that lifted cleanly is not named: saying so would report something
    // went wrong there when nothing did.
    if (any) lettered.push(way.letter);
  }

  if (notes.length === 0) return null;

  const across =
    lettered.length > 1 ? `, across Ways ${joinWords(lettered)}` : "";
  return {
    count: notes.length,
    summary: `${plural(notes.length, "lifting note")}${across}`,
    notes,
  };
}


/* ------------------------------------------------------------------------- *
 * Applications, as tone slots
 * ------------------------------------------------------------------------- */

/** How many indexed data slots `styles.css` declares (`--data-0..7`). */
export const TONE_SLOTS = 8;

/**
 * Each application's tone slot, assigned once from the route's own app order.
 *
 * ONE MAP FOR THE WHOLE SECTION. The masthead chain, the strip's segments and
 * the spine's markers all read this, so an application cannot be teal in one
 * instrument and clay in the next — which is the only reason a legend at the top
 * can be trusted by everything under it.
 *
 * `HabitDTO.apps` is the order reached, so slot 0 is where the work begins. It
 * wraps past eight rather than running out: a route through nine applications
 * repeats a colour, which the printed name beside it disambiguates. Colour is
 * never the only channel here — the rail's rule.
 */
export function appTones(apps: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const app of apps) {
    if (!out.has(app)) out.set(app, out.size % TONE_SLOTS);
  }
  return out;
}

/** `app-3`, or null for an application the route never named. */
export function toneOf(app: string | null, tones: Map<string, number>): number | null {
  if (app === null) return null;
  return tones.get(app) ?? null;
}

/* ------------------------------------------------------------------------- *
 * Durations, said as durations
 * ------------------------------------------------------------------------- */

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * "17.5s", or "41.2–47.8s" — the extremes, never a mean.
 *
 * Both endpoints are spans a recording actually produced. An average is a
 * number no recording produced, which is the rule `HabitWayDTO.totalsMs` is a
 * list for and the reason `cadenceOf` takes a median rather than a mean.
 */
export function rangeText(msList: readonly number[]): string | null {
  if (msList.length === 0) return null;
  const lo = Math.min(...msList);
  const hi = Math.max(...msList);
  // The unit rides the SECOND number only: "41.2s–47.8s" makes a reader parse
  // two quantities where there is one range.
  return secs(lo) === secs(hi) ? secs(lo) : `${(lo / 1000).toFixed(1)}–${secs(hi)}`;
}

/* ------------------------------------------------------------------------- *
 * Actions, summarized by kind
 * ------------------------------------------------------------------------- */

type StepAction = { action: string; target: string; slot?: { name: string } };

/**
 * The counted noun for each recorded verb.
 *
 * The VERBS ARE THE RECORD'S OWN — `graph-view.ts` writes `3× click`, `type`,
 * `press cmd+v`, `wait until app(TextEdit)` — so this table translates rather
 * than invents. An unlisted verb falls through to itself, which is why a new
 * action kind degrades to `2 scrolls` instead of disappearing from the tally.
 */
const ACTION_NOUNS: Record<string, [string, string]> = {
  click: ["click", "clicks"],
  press: ["key press", "key presses"],
  type: ["typed input", "typed inputs"],
  wait: ["wait", "waits"],
  scroll: ["scroll", "scrolls"],
  drag: ["drag", "drags"],
  move: ["move", "moves"],
};

/** The order a tally prints in, so two steps read comparably. */
const ACTION_ORDER = ["click", "press", "type", "scroll", "drag", "move", "wait"];

/**
 * `3× click` counts as THREE, because that is what it recorded.
 *
 * `graph-view.ts` collapses a repeat into a multiplier before this ever sees
 * it, so reading the string as one action would undercount every rapid sequence
 * — and the whole point of a tally is that density stops needing to be counted
 * by eye.
 */
function actionCount(action: string): number {
  const m = /^(\d+)\s*×/.exec(action);
  if (m === null) return 1;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The bare verb: `3× click` → `click`, `press cmd+v` → `press`. */
function actionKind(action: string): string {
  return action.replace(/^\d+\s*×\s*/, "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * "12 clicks · 1 key press · types {note}" — the step's density, read rather
 * than counted.
 *
 * A step can carry fourteen action lines, and fourteen lines of monospace is a
 * wall that says nothing at a glance about whether this step is the big one.
 * The verbatim list is not lost; it goes behind the disclosure the caller draws.
 *
 * SLOT NAMES SURVIVE THE SUMMARY, and they are the reason a typed step is worth
 * distinguishing at all: `types {note}` says where the variation is. Names only
 * — a DTO carries no values, so this cannot print one.
 *
 * Empty string when there is nothing recorded, so the caller draws its own
 * "(no actions recorded on this edge)" rather than a tally of zero.
 */
export function actionSummary(actions: readonly StepAction[]): string {
  if (actions.length === 0) return "";

  const counts = new Map<string, number>();
  const slots: string[] = [];
  for (const a of actions) {
    const kind = actionKind(a.action);
    counts.set(kind, (counts.get(kind) ?? 0) + actionCount(a.action));
    const name = a.slot?.name;
    if (name !== undefined && !slots.includes(name)) slots.push(name);
  }

  const kinds = [...counts.keys()].sort((a, b) => {
    const ia = ACTION_ORDER.indexOf(a);
    const ib = ACTION_ORDER.indexOf(b);
    // An unlisted verb sorts after every listed one, then alphabetically, so the
    // order is total and a tally cannot reshuffle between two renders.
    if (ia !== ib) return (ia < 0 ? ACTION_ORDER.length : ia) - (ib < 0 ? ACTION_ORDER.length : ib);
    return a.localeCompare(b);
  });

  const parts = kinds.map((kind) => {
    const n = counts.get(kind) ?? 0;
    const pair = ACTION_NOUNS[kind];
    const noun = pair === undefined ? `${kind}${n === 1 ? "" : "s"}` : pair[n === 1 ? 0 : 1];
    // The slot rides the verb that produced it. `types {note}` beats
    // `1 typed input` because the NAME is the fact worth carrying up.
    if (kind === "type" && slots.length > 0) {
      return `types ${slots.map((s) => `{${s}}`).join(", ")}`;
    }
    return `${n} ${noun}`;
  });

  return parts.join(" · ");
}

/* ------------------------------------------------------------------------- *
 * The spine: sequence, cost and trust in one row
 * ------------------------------------------------------------------------- */

/** One recording's span on one step. `share` scales a bar and is never shown. */
export interface SpineRun {
  sessionId: string;
  ms: number;
  /** 0..1 against the longest span anywhere in the Way. NEVER printed. */
  share: number;
  /** "17.5s" — the fact, beside the bar that is the reading. */
  text: string;
}

export interface SpineRow {
  /** 1-based, from `HabitStepDTO.index` — never this row's position. */
  n: number;
  edgeId: string;
  missing: boolean;
  /** The place this step ARRIVES in, printed once. */
  place: string;
  /**
   * The origin, and ONLY where the chain breaks.
   *
   * Null is the healthy case: step *i*'s `from` is step *i-1*'s `to`, so
   * printing both doubles every label. Non-null means the two disagree — a
   * `missing` step, or an index defect — and then the row prints `from → to`
   * and stops pretending the chain is continuous.
   */
  brokenFrom: string | null;
  /** `--data-N`'s N, or null for a step whose destination named no app. */
  toneSlot: number | null;
  /** "12 clicks · 1 key press · types {note}". Empty when none were recorded. */
  summary: string;
  actions: readonly StepAction[];
  runs: SpineRun[];
  /** The pause AFTER this step, as a range. Null when none was measured. */
  idleText: string | null;
  observations: number;
  everyRecording: boolean;
  liftWarnings: readonly string[];
  firstAt: { sessionId: string; startedAt: number; atSec: number } | null;
}

export interface SpineView {
  /**
   * Where the route starts — the first step's `from`, drawn as its own node.
   *
   * The spine draws a step as the place it lands in, so without this the
   * opening place would never be named at all. Null when the Way has no steps.
   */
  origin: string | null;
  rows: SpineRow[];
}

/**
 * The steps, their cost and their agreement, as ONE list.
 *
 * This merges what used to be two: a step list numbered by `step.index + 1`,
 * and a separate timings list numbered by its own position. They could disagree
 * — `habitTimings` DROPS steps with no recorded duration, so one unmeasured
 * step shifted every number below it and the two lists silently pointed at
 * different steps. Joining on `HabitStepTimingDTO.stepIndex` makes that
 * unrepresentable, and merging the rows removes the join from the reader.
 *
 * `timings` may be null (fewer than two recordings), and then every row simply
 * carries no runs. The sequence is still the sequence.
 */
export function spineRows(
  way: HabitWayDTO,
  timings: HabitTimingsDTO | null,
  tones: Map<string, number>,
): SpineView {
  const byStep = new Map((timings?.steps ?? []).map((s) => [s.stepIndex, s]));

  // The peak is taken over the WHOLE Way, so a long step dwarfs a short one on
  // the page exactly as it did on the clock. Per-row scaling would draw every
  // step the same size and say nothing — the ledger's shared-domain rule.
  const peak = Math.max(
    0,
    ...[...byStep.values()].flatMap((s) => s.runs.map((r) => r.ms)),
  );

  const rows = way.steps.map((step, i): SpineRow => {
    const prev = i === 0 ? null : (way.steps[i - 1] ?? null);
    const timing = byStep.get(step.index);
    const gaps = timing?.gapsAfterMs.map((g) => g.ms) ?? [];
    return {
      n: step.index + 1,
      edgeId: step.edgeId,
      missing: step.missing,
      place: step.to,
      // THE FIRST STEP IS NEVER BROKEN: its origin is drawn as its own node
      // above the list (`SpineView.origin`), so repeating it on row one would
      // print the opening place twice — the doubling this whole shape undoes.
      brokenFrom: prev === null || prev.to === step.from ? null : step.from,
      toneSlot: toneOf(step.app, tones),
      summary: actionSummary(step.actions),
      actions: step.actions,
      runs: (timing?.runs ?? []).map((r) => ({
        sessionId: r.sessionId,
        ms: r.ms,
        // A FLOOR, so a span that rounds to 0.0s is still a mark rather than
        // nothing: an invisible bar reads as "not measured" where the number
        // beside it says "instant". `peak` is 0 only when every span is 0.
        share: peak <= 0 ? MIN_SHARE : Math.max(r.ms / peak, MIN_SHARE),
        text: secs(r.ms),
      })),
      idleText: rangeText(gaps),
      observations: step.observations,
      everyRecording: step.everyRecording,
      liftWarnings: step.liftWarnings,
      firstAt: step.firstAt,
    };
  });

  return { origin: way.steps[0]?.from ?? null, rows };
}

/** The smallest bar that is still a bar. See `spineRows`. */
export const MIN_SHARE = 0.02;

/* ------------------------------------------------------------------------- *
 * The strip: the shape of each run
 * ------------------------------------------------------------------------- */

export interface StripSegment {
  kind: "step" | "idle";
  /** Null on an idle segment, which is between steps and is not one. */
  stepIndex: number | null;
  /** The place a step lands in — the segment's own name in the hover title. */
  place: string;
  toneSlot: number | null;
  ms: number;
  leftPct: number;
  widthPct: number;
  /** "17.5s", for the title. Bars carry no printed number. */
  text: string;
}

export interface StripLane {
  sessionId: string;
  /** Wall clock of the recording's start, for the label. Null when unknown. */
  at: number | null;
  /** Where inside the recording to open, in lane seconds. Null when unplaceable. */
  atSec: number | null;
  /** The sum of what is DRAWN — see `stripLanes`. */
  totalMs: number;
  totalText: string;
  segments: StripSegment[];
}

export interface StripView {
  lanes: StripLane[];
  /** The longest lane. Every lane is a share of this one, never of itself. */
  domainMs: number;
  legend: { app: string; toneSlot: number }[];
  /**
   * Recordings of this route that walked a DIFFERENT Way, counted.
   *
   * Never silently dropped: the strip draws the baseline Way's recordings, and
   * a reader counting three marks on the ledger against two lanes here is owed
   * the reason. The fork instrument is where those recordings are drawn.
   */
  elsewhere: number;
}

/** A recording's placement, injected so this module stays free of the DTO's shape. */
export interface StripWalk {
  sessionId: string;
  at: number;
  atSec: number | null;
}

/**
 * One lane per recording, segmented by step, on ONE shared domain.
 *
 * THE LANE'S EXTENT IS THE SUM OF WHAT IS DRAWN — its step spans plus the idle
 * between them — and never the recording's whole-walk duration. The two are
 * close but not equal, and drawing segments that stop short of a lane's stated
 * end would assert an unmeasured remainder. The whole-walk range is printed in
 * the masthead, where it is a fact rather than an axis.
 *
 * NO WIDTH FLOOR HERE, deliberately, unlike the spine's bars: segments TILE a
 * lane, so a floor on one steals width from its neighbours and the lane stops
 * summing to itself. A sub-pixel step is kept visible by `min-width: 1px` in
 * the sheet — the rail's own rule, applied where it belongs.
 *
 * NULL when there is nothing to draw: no timings (fewer than two recordings, or
 * no baseline) or no attributed span. The caller then states the reason — a
 * strip that merely never appeared would be indistinguishable from one nobody
 * implemented.
 */
export function stripLanes(
  way: HabitWayDTO,
  timings: HabitTimingsDTO | null,
  walks: readonly StripWalk[],
  tones: Map<string, number>,
  totalRecordings: number,
): StripView | null {
  if (timings === null) return null;

  const placeOf = new Map(way.steps.map((s) => [s.index, s.to]));
  const appOf = new Map(way.steps.map((s) => [s.index, s.app]));
  const ordered = [...timings.steps].sort((a, b) => a.stepIndex - b.stepIndex);

  // Gather each recording's own run of segments, in step order.
  const raw = new Map<string, { kind: "step" | "idle"; stepIndex: number | null; ms: number }[]>();
  const push = (sessionId: string, seg: { kind: "step" | "idle"; stepIndex: number | null; ms: number }): void => {
    const list = raw.get(sessionId);
    if (list === undefined) raw.set(sessionId, [seg]);
    else list.push(seg);
  };
  for (const step of ordered) {
    for (const r of step.runs) push(r.sessionId, { kind: "step", stepIndex: step.stepIndex, ms: r.ms });
    for (const g of step.gapsAfterMs) push(g.sessionId, { kind: "idle", stepIndex: null, ms: g.ms });
  }
  if (raw.size === 0) return null;

  const totals = new Map(
    [...raw].map(([id, segs]) => [id, segs.reduce((n, s) => n + s.ms, 0)] as const),
  );
  const domainMs = Math.max(...totals.values());
  if (domainMs <= 0) return null;

  const walkOf = new Map(walks.map((w) => [w.sessionId, w]));
  // OLDEST FIRST, matching the ledger and the walks list. `way.sessionIds` is
  // ordered by the route, so a lane's position never depends on which step
  // happened to be timed first.
  const order = way.sessionIds.filter((id) => raw.has(id));
  for (const id of raw.keys()) if (!order.includes(id)) order.push(id);

  const lanes = order.map((sessionId): StripLane => {
    const segs = raw.get(sessionId) ?? [];
    const totalMs = totals.get(sessionId) ?? 0;
    let atPct = 0;
    const segments = segs.map((s): StripSegment => {
      const widthPct = (s.ms / domainMs) * 100;
      const leftPct = atPct;
      atPct += widthPct;
      const app = s.stepIndex === null ? null : appOf.get(s.stepIndex) ?? null;
      return {
        kind: s.kind,
        stepIndex: s.stepIndex,
        place: s.stepIndex === null ? "" : placeOf.get(s.stepIndex) ?? "",
        toneSlot: toneOf(app, tones),
        ms: s.ms,
        leftPct,
        widthPct,
        text: secs(s.ms),
      };
    });
    const walk = walkOf.get(sessionId);
    return {
      sessionId,
      at: walk?.at ?? null,
      atSec: walk?.atSec ?? null,
      totalMs,
      totalText: secs(totalMs),
      segments,
    };
  });

  // The legend names only what the strip actually PAINTS, in the order it is
  // first reached — a swatch for an application no lane contains would send a
  // reader looking for a colour that is not there.
  const legend: { app: string; toneSlot: number }[] = [];
  for (const step of ordered) {
    const app = appOf.get(step.stepIndex) ?? null;
    const slot = toneOf(app, tones);
    if (app !== null && slot !== null && !legend.some((l) => l.app === app)) {
      legend.push({ app, toneSlot: slot });
    }
  }

  return {
    lanes,
    domainMs,
    legend,
    elsewhere: Math.max(0, totalRecordings - lanes.length),
  };
}
