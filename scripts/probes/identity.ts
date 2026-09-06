/**
 * Which observed payloads are ONE value, on the library that exists.
 *
 * The Knowledge layer's identities are projections declared per fact type, and
 * every declaration in `src/knowledge/identities.ts` carries a number from a
 * measurement. This is that measurement, so the numbers stay re-checkable
 * instead of being frozen in a doc comment: `display_change` folding 8 payloads
 * into 2 is the claim the whole cycle rests on.
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

import { DB_PATH, openReadOnly } from "../lib/paths.js";
import { note, ok, padEnd, padStart, section, summary } from "../lib/report.js";
import { foldByIdentity, type Observation } from "../../src/knowledge/identity.js";
import {
  DISPLAY_TOPOLOGY,
  FOCUSED_APP,
  VISITED_PAGE,
  type DisplayTopologyPayload,
  type FocusPayload,
  type IdentityDeclaration,
} from "../../src/knowledge/identities.js";

// No `refuseBarePositionals` here, deliberately: it is opt-in for a probe whose
// entire interface is flags, and this one takes none, so there is no flag npm
// could swallow.

interface EventRow {
  session_id: string;
  t_mono: number;
  data: string | null;
}

const db = openReadOnly(DB_PATH);

const sessions = db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number };
const span = db
  .prepare(
    "SELECT MIN(date(started_at/1000,'unixepoch')) AS lo, MAX(date(started_at/1000,'unixepoch')) AS hi FROM session",
  )
  .get() as { lo: string | null; hi: string | null };

section("Corpus");
note("library", DB_PATH);
note("recordings", `${sessions.n}${span.lo === null ? "" : ` (${span.lo} -> ${span.hi})`}`);

if (sessions.n < 2) {
  console.log(
    "\nRefusing: cross-recording identity needs at least two recordings. " +
      "With one, every payload is from the same session and the table below would " +
      "be an empty result wearing a verdict.",
  );
  db.close();
  process.exit(1);
}

/** Read every payload of one kind, parsed, in recording order. */
function observations<R>(kind: string): Observation<R>[] {
  const rows = db
    .prepare("SELECT session_id, t_mono, data FROM event WHERE kind = ? ORDER BY session_id, t_mono")
    .all(kind) as EventRow[];
  const out: Observation<R>[] = [];
  for (const row of rows) {
    if (row.data === null) continue;
    out.push({
      value: JSON.parse(row.data) as R,
      source: { sessionId: row.session_id, tMono: row.t_mono },
    });
  }
  return out;
}

/** `url_change` stores `{url}`; the identity takes the string itself. */
function urlObservations(): Observation<string>[] {
  const out: Observation<string>[] = [];
  for (const o of observations<{ url?: string }>("url_change")) {
    const url = o.value.url;
    if (typeof url === "string") out.push({ value: url, source: o.source });
  }
  return out;
}

interface Row {
  kind: string;
  occurrences: number;
  raw: number;
  folded: number;
  unidentified: number;
}

function measure<Raw, Canon>(
  decl: IdentityDeclaration<Raw, Canon>,
  obs: readonly Observation<Raw>[],
): Row {
  const folded = foldByIdentity(decl.kind, obs, decl.identity);
  const raw = new Set(obs.map((o) => JSON.stringify(o.value))).size;
  return {
    kind: decl.kind,
    occurrences: obs.length,
    raw,
    folded: folded.values.length,
    unidentified: folded.unidentified,
  };
}

const rows: Row[] = [
  measure(DISPLAY_TOPOLOGY, observations<DisplayTopologyPayload>("display_change")),
  measure(FOCUSED_APP, observations<FocusPayload>("focus_change")),
  measure(VISITED_PAGE, urlObservations()),
];

section("What identity collapses");
console.log(
  `  ${padEnd("kind", 16)}${padStart("occurrences", 12)}${padStart("raw", 6)}${padStart("folded", 8)}${padStart("unidentified", 14)}`,
);
for (const r of rows) {
  console.log(
    `  ${padEnd(r.kind, 16)}${padStart(r.occurrences, 12)}${padStart(r.raw, 6)}${padStart(r.folded, 8)}${padStart(r.unidentified, 14)}`,
  );
}

// keymap_change is measured but has no identity, and the reason is the number.
const keymaps = observations<unknown>("keymap_change");
const keymapRaw = new Set(keymaps.map((o) => JSON.stringify(o.value))).size;
section("Declined");
note(
  "keymap_change",
  `${keymaps.length} occurrences, ${keymapRaw} distinct payload${keymapRaw === 1 ? "" : "s"} — ` +
    `${keymapRaw <= 1 ? "an identity would buy nothing" : "WORTH RE-READING: it now has more than one"}`,
);

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

db.close();
process.exit(summary("\n"));
