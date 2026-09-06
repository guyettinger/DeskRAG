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

const occurrencesOf = (fact: KnowledgeFactDetailDTO): number =>
  fact.values.reduce((n, v) => n + v.observations, 0) + fact.unidentified;

interface Row {
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
  const before = f.read(unexcluded, startedAt);
  return {
    kind: f.kind,
    attribution: f.attribution,
    occurrences: occurrencesOf(before),
    raw: f.rawVariants(unexcluded),
    folded: before.values.length,
    unidentified: before.unidentified,
    after: f.read(excluded, startedAt),
  };
});

section("What identity collapses (before any exclusion)");
console.log(
  `  ${padEnd("kind", 16)}${padStart("occurrences", 12)}${padStart("raw", 6)}${padStart("folded", 8)}${padStart("unidentified", 14)}`,
);
for (const r of rows) {
  console.log(
    `  ${padEnd(r.kind, 16)}${padStart(r.occurrences, 12)}${padStart(r.raw, 6)}${padStart(r.folded, 8)}${padStart(r.unidentified, 14)}`,
  );
}

section("What the recorder exclusion costs, per fact");
console.log(
  `  ${padEnd("kind", 16)}${padEnd("attribution", 14)}${padStart("occurrences", 14)}${padStart("folded", 12)}`,
);
for (const r of rows) {
  const kept = occurrencesOf(r.after);
  console.log(
    `  ${padEnd(r.kind, 16)}${padEnd(r.attribution, 14)}` +
      `${padStart(`${r.occurrences} -> ${kept}`, 14)}${padStart(`${r.folded} -> ${r.after.values.length}`, 12)}`,
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
    r.kind,
    `${lost} of ${of} recordings would lose their only observation — ` +
      `the exclusion is deliberately NOT applied to this fact`,
  );
}

section("Checks");
for (const r of rows) {
  ok(
    `${r.kind} folds`,
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
    `${r.kind} keeps every observation`,
    occurrencesOf(r.after) === r.occurrences,
    `${r.occurrences} kept`,
    "an ambient fact must not inherit the recorder exclusion — see IdentityDeclaration.attribution",
  );
}
// The reason `keymap_change` has an identity at all is not the fold count, which
// is 1 either way: it is that the raw payload carries ~70 keycode mappings, and a
// projection makes them structurally unable to reach a screen or a tool response.
const keymap = rows.find((r) => r.kind === "keymap_change");
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
