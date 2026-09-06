/**
 * Which observed payloads are ONE value, on the library that exists — and what
 * excluding the recorder costs each fact.
 *
 * The Knowledge layer's identities are projections declared per fact type, and
 * every declaration in `src/knowledge/identities.ts` carries a number from a
 * measurement. This is that measurement, so the numbers stay re-checkable
 * instead of being frozen in a doc comment: `display_change` folding 8 payloads
 * into 2 is the claim the whole cycle rests on.
 *
 * IT CALLS THE APP'S OWN GATHERER (`app/src/main/knowledge-view.ts`) rather than
 * keeping a copy of the reading. It used to hold its own — one `observations()`
 * per kind plus a special case for `url_change` storing `{url}` — and a probe
 * that re-implements the thing it measures is two readers of one rule, which is
 * the `ax-dump`/`ax-exec` drift hazard this repo names. What it still owns is
 * the RAW distinct count, which no DTO carries: an unidentified payload has no
 * value to be a variant of.
 *
 * THE EXCLUSION SECTION IS THE POINT OF THIS VERSION. Applying the recorder
 * exclusion to every fact is the obvious implementation and it is wrong: the
 * ambient facts are sampled at session start, while the recorder is still
 * frontmost. Measured, that costs 6 of 12 recordings their display and keymap
 * observations outright — and the two display configurations survived only
 * because the docked one, a SINGLE observation, fell in the surviving half.
 *
 * READ-ONLY: SQLite is opened `mode=ro`, the output is stdout, and nothing here
 * constructs a DualStore. HEADLESS, for probe:baseline's reason -- the app takes
 * no single-instance lock and WRITES on startup, so launching it would make a
 * second owner of SQLite.
 *
 * PRINTS THE CORPUS FIRST and refuses under two recordings, where
 * cross-recording identity is not a thing that can be measured and the table
 * would be an empty result wearing a verdict.
 */

import { DB_PATH, DATA_DIR, openReadOnly, readSettings } from "../lib/paths.js";
import { note, ok, padEnd, padStart, section, summary } from "../lib/report.js";
import {
  FACTS,
  sessionStream,
  type KnowledgeSession,
  type SessionStream,
} from "../../app/src/main/knowledge-view.js";
import { DEFAULT_HALF_LIFE_MS } from "../../app/src/main/walk-analysis.js";
import { excludedByName, type TraceEvent } from "../../src/index.js";
import type { KnowledgeFactDetailDTO } from "../../app/src/shared/types.js";

// No `refuseBarePositionals` here, deliberately: it is opt-in for a probe whose
// entire interface is flags, and this one takes none, so there is no flag npm
// could swallow.

interface SessionRow {
  id: string;
  started_at: number;
}

interface EventRow {
  t_mono: number;
  kind: string;
  data: string | null;
}

const db = openReadOnly(DB_PATH);

const sessionRows = db
  .prepare("SELECT id, started_at FROM session ORDER BY started_at")
  .all() as SessionRow[];
const span = db
  .prepare(
    "SELECT MIN(date(started_at/1000,'unixepoch')) AS lo, MAX(date(started_at/1000,'unixepoch')) AS hi FROM session",
  )
  .get() as { lo: string | null; hi: string | null };

const settings = readSettings();
const excludeApps = settings.flows?.excludeApps ?? [];

section("Corpus");
note("library", DB_PATH);
note(
  "recordings",
  `${sessionRows.length}${span.lo === null ? "" : ` (${span.lo} -> ${span.hi})`}`,
);
// The list the app is CONFIGURED with, printed before anything is measured
// against it: an empty list makes the whole exclusion section a no-op, and a
// reader has to be able to see that rather than infer it from zeroes.
note(
  "excluded apps",
  excludeApps.length === 0
    ? `none configured (${DATA_DIR}/settings.json) — the exclusion section below is a no-op`
    : excludeApps.join(", "),
);

if (sessionRows.length < 2) {
  console.log(
    "\nRefusing: cross-recording identity needs at least two recordings. " +
      "With one, every payload is from the same session and the table below would " +
      "be an empty result wearing a verdict.",
  );
  db.close();
  process.exit(1);
}

const eventsOf = db.prepare(
  "SELECT t_mono, kind, data FROM event WHERE session_id = ? ORDER BY t_mono",
);

/** Every recording, in the shape the app's own projection takes. */
const sessions: KnowledgeSession[] = sessionRows.map((s) => ({
  sessionId: s.id,
  startedAt: s.started_at,
  events: (eventsOf.all(s.id) as EventRow[]).map(
    (e): TraceEvent => ({
      tMono: e.t_mono,
      kind: e.kind,
      x: null,
      y: null,
      data: e.data === null ? null : JSON.parse(e.data),
    }),
  ),
}));

const eventCount = sessions.reduce((n, s) => n + s.events.length, 0);
note("events", String(eventCount));

/**
 * TWO SPLITS OF THE SAME RECORDINGS, and the first is not a hypothetical: it is
 * what every number quoted in `identities.ts` was measured against, so the table
 * below stays comparable to the declarations it justifies.
 */
const unexcluded = sessions.map((s) => sessionStream(s, () => false));
const excluded = sessions.map((s) => sessionStream(s, excludedByName(excludeApps)));

const startedAt = (id: string): number | undefined =>
  sessions.find((s) => s.sessionId === id)?.startedAt;

/**
 * Every observation the fact rests on, unidentified ones included.
 *
 * READ OFF THE FACT-LEVEL COUNT, never summed over `values`: the DTO caps its
 * list at `MAX_FACT_VALUES`, so summing what is listed would understate exactly
 * the facts big enough for the cap to bite.
 */
const occurrencesOf = (fact: KnowledgeFactDetailDTO): number =>
  fact.observations + fact.unidentified;

/** Distinct values, listed or not — the number the fold actually produced. */
const foldedOf = (fact: KnowledgeFactDetailDTO): number =>
  fact.values.length + fact.unlisted;

// The half-life the app ships with, and the moment the sweep measures from. Read
// ONCE, here, so every row of every table below is scored against one instant.
const NOW = Date.now();
const recency = { now: NOW, halfLifeMs: DEFAULT_HALF_LIFE_MS };

interface Row {
  id: string;
  kind: string;
  attribution: string;
  occurrences: number;
  raw: number;
  folded: number;
  unidentified: number;
  /** The same fact read from the streams the app actually uses. */
  after: KnowledgeFactDetailDTO;
}

const rows: Row[] = FACTS.map((f) => {
  const before = f.read(unexcluded, startedAt, recency);
  return {
    id: f.id,
    kind: f.kind,
    attribution: f.attribution,
    occurrences: occurrencesOf(before),
    raw: f.rawVariants(unexcluded),
    folded: foldedOf(before),
    unidentified: before.unidentified,
    after: f.read(excluded, startedAt, recency),
  };
});

section("What identity collapses (before any exclusion)");
console.log(
  `  ${padEnd("fact", 18)}${padEnd("from", 16)}${padStart("occurrences", 12)}${padStart("raw", 6)}${padStart("folded", 8)}${padStart("unidentified", 14)}`,
);
for (const r of rows) {
  console.log(
    `  ${padEnd(r.id, 18)}${padEnd(r.kind, 16)}${padStart(r.occurrences, 12)}${padStart(r.raw, 6)}${padStart(r.folded, 8)}${padStart(r.unidentified, 14)}`,
  );
}

section("What the recorder exclusion costs, per fact");
console.log(
  `  ${padEnd("fact", 18)}${padEnd("attribution", 14)}${padStart("occurrences", 14)}${padStart("folded", 12)}`,
);
for (const r of rows) {
  const kept = occurrencesOf(r.after);
  console.log(
    `  ${padEnd(r.id, 18)}${padEnd(r.attribution, 14)}` +
      `${padStart(`${r.occurrences} -> ${kept}`, 14)}${padStart(`${r.folded} -> ${foldedOf(r.after)}`, 12)}`,
  );
}
const dropped = excluded.reduce((n, s) => n + s.dropped, 0);
const blind = excluded.filter((s) => s.unattributable).length;
note(
  "events dropped",
  `${dropped} of ${eventCount}` +
    (blind === 0
      ? ""
      : ` — ${blind} recording(s) carried no focus_change at all, where the exclusion is a NO-OP`),
);

/**
 * What applying the exclusion to an AMBIENT fact WOULD have cost.
 *
 * The counterfactual, and the reason `attribution` exists: an ambient fact read
 * from the excluded stream loses whole recordings, because the display and the
 * keyboard are sampled while the recorder is still frontmost.
 */
function wouldVanish(kind: string): { lost: number; of: number } {
  let lost = 0;
  let of = 0;
  const has = (stream: SessionStream, which: "all" | "kept"): boolean =>
    stream[which].some((e) => e.kind === kind);
  for (let i = 0; i < unexcluded.length; i += 1) {
    if (!has(unexcluded[i]!, "all")) continue;
    of += 1;
    if (!has(excluded[i]!, "kept")) lost += 1;
  }
  return { lost, of };
}

section("What excluding the AMBIENT facts would have cost");
for (const r of rows.filter((x) => x.attribution === "ambient")) {
  const { lost, of } = wouldVanish(r.kind);
  note(
    r.id,
    `${lost} of ${of} recordings would lose their only observation — ` +
      `the exclusion is deliberately NOT applied to this fact`,
  );
}

/**
 * WHAT RANKING BY RECENCY ACTUALLY MOVES, and the control it is quoted beside.
 *
 * `docs/research/persistence-layers.md` §4 names the defect this ordering
 * repairs — a ranking over a RAW LIFETIME TALLY, where a value seen ten times
 * last spring and abandoned outranks one seen three times last week, forever.
 * The correction shipped ON rather than as a sweep first, against this repo's
 * usual order, so the sweep runs HERE and the constant stays re-checkable.
 *
 * THE CONTROL IS THE RULE THAT WAS REMOVED: distinct recordings, then
 * observations, then the key — `byEvidence` as it stood, re-implemented here on
 * purpose. A probe re-implementing what it measures is normally the drift hazard
 * this repo names; a probe re-implementing what a change DELETED is the only way
 * to have a counterfactual at all, and it is inert code that nothing ships.
 *
 * A sweep where nothing moves is a result, and it is the likely one: the
 * library's dated span is under a fortnight, so at a 14-day half-life every
 * weight is within a factor of two of every other.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIVES_DAYS = [7, 14, 30, 90];

/**
 * THE COLUMNS SPLIT TIEBREAKS FROM REAL OVERRIDES, AND THAT WAS PAID FOR ONCE
 * ALREADY. `probe:baseline`'s first run printed "1 of 1 paths changed" at every
 * half-life including 90d on an 11.5-day library, because both candidates had
 * identical evidence and recency was breaking a TIE — a real improvement, and
 * not the effect under test. This probe's first run did exactly the same thing:
 * "3 of 5 facts reordered" at 90d over a 20-day span.
 *
 * A REAL OVERRIDE is a pair recency inverted where the lifetime rule had a
 * STRICT preference — a value with less lifetime evidence placed above one with
 * more, which is the whole claim §4 makes. A TIEBREAK is a pair the lifetime
 * rule could only separate by key.
 */
interface Ranked {
  key: string;
  sessions: number;
  observations: number;
}

// THE STREAMS THE APP ACTUALLY RENDERS FROM, not the unexcluded ones the fold
// table above uses for comparability with the declarations. `read` applies each
// fact's own attribution, so this is the shipped ordering — sweeping the other
// split would measure an ordering nothing displays. It matters: on the real
// library `focused_app` leads with Chrome (5 recordings, seen today) over
// TextEdit and Calculator (6 each, last seen a fortnight ago), and that override
// only exists once the recorder's stretches are gone.
const rankedUnder = (halfLifeMs: number): Map<string, Ranked[]> =>
  new Map(
    FACTS.map((f) => [
      f.id,
      f
        .read(excluded, startedAt, { now: NOW, halfLifeMs })
        .values.map((v) => ({
          key: v.key,
          sessions: v.stability.sessions,
          observations: v.observations,
        })),
    ]),
  );

/** Strictly better by the rule this cycle removed: recordings, then observations. */
const outranks = (a: Ranked, b: Ranked): boolean =>
  a.sessions !== b.sessions ? a.sessions > b.sessions : a.observations > b.observations;

section("What recency does to the order (control: the lifetime tally it replaced)");
console.log(
  `  ${padEnd("half-life", 16)}${padStart("real overrides", 16)}${padStart("tiebreaks", 12)}` +
    `${padStart("top vs shipped", 16)}${padStart("top vs lifetime", 17)}`,
);
const base = rankedUnder(DEFAULT_HALF_LIFE_MS);

/** What the removed rule would have put first, per fact. */
const lifetimeTop = new Map(
  [...base].map(([id, values]) => [
    id,
    [...values].sort((a, b) =>
      outranks(a, b) ? -1 : outranks(b, a) ? 1 : a.key < b.key ? -1 : 1,
    )[0]?.key,
  ]),
);
for (const days of HALF_LIVES_DAYS) {
  const under = rankedUnder(days * DAY_MS);
  let overrides = 0;
  let ties = 0;
  let topMoved = 0;
  for (const values of under.values()) {
    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        // `values[j]` is BELOW `values[i]` under recency. Did the lifetime rule
        // strictly prefer it?
        if (outranks(values[j]!, values[i]!)) overrides += 1;
        else if (!outranks(values[i]!, values[j]!)) ties += 1;
      }
    }
  }
  let topVsLifetime = 0;
  for (const [id, values] of under) {
    if (values[0]?.key !== base.get(id)?.[0]?.key) topMoved += 1;
    if (values[0]?.key !== lifetimeTop.get(id)) topVsLifetime += 1;
  }
  const label = days === DEFAULT_HALF_LIFE_MS / DAY_MS ? `${days}d (shipped)` : `${days}d`;
  console.log(
    `  ${padEnd(label, 16)}${padStart(overrides, 16)}${padStart(ties, 12)}` +
      `${padStart(`${topMoved} of ${FACTS.length}`, 16)}` +
      `${padStart(`${topVsLifetime} of ${FACTS.length}`, 17)}`,
  );
}
note(
  "reading",
  "a real override is a value with LESS lifetime evidence ranked above one with more — " +
    "§4's claim. A tiebreak is a pair the lifetime rule could only separate by key, and " +
    "recency separating those is an improvement but not the effect under test. " +
    "'top vs shipped' asks whether the CONSTANT matters and is 0 at the shipped value by " +
    "construction; 'top vs lifetime' asks whether this cycle changed what a reader sees " +
    "first, which is the number that justifies the change.",
);
note(
  "span",
  span.lo === null
    ? "no dated recordings"
    : `${span.lo} -> ${span.hi} — a sweep is only a measurement where the span exceeds the shortest half-life`,
);

section("Checks");
for (const r of rows) {
  ok(
    `${r.id} folds`,
    r.folded <= r.raw,
    `${r.raw} raw -> ${r.folded} folded`,
    "a fold can never produce more values than it was given",
  );
}
ok(
  "every observation is accounted for",
  rows.every((r) => r.folded > 0 || r.occurrences === r.unidentified),
  "",
  "a kind with observations but no values and no unidentified count has lost data",
);
for (const r of rows.filter((x) => x.attribution === "ambient")) {
  ok(
    `${r.id} keeps every observation`,
    occurrencesOf(r.after) === r.occurrences,
    `${r.occurrences} kept`,
    "an ambient fact must not inherit the recorder exclusion — see IdentityDeclaration.attribution",
  );
}
// The reason `keymap_change` has an identity at all is not the fold count, which
// is 1 either way: it is that the raw payload carries ~70 keycode mappings, and a
// projection makes them structurally unable to reach a screen or a tool response.
const keymap = rows.find((r) => r.id === "keyboard_layout");
if (keymap !== undefined) {
  ok(
    "keymap_change carries no keycode table into a consumer",
    !keymap.after.values.some((v) => v.variants.some((raw) => raw.includes("entries"))),
    `${keymap.after.values.length} value(s)`,
    "the identity projects to layoutId; a payload reaching a consumer with `entries` means it did not",
  );
}

db.close();
process.exit(summary("\n"));
