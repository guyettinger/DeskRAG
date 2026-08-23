/**
 * The habit CATALOGUE as text — what `list_habits` prints.
 *
 * Only the list. `get_habit` returns the HABIT.md verbatim and this module is
 * not involved, deliberately: the value of that tool is that its output IS a
 * file, and anything wrapping it would corrupt a paste-to-disk.
 *
 * In `mcp/` so `test/mcp.readonly.test.ts` covers it — the guard `readdirSync`s
 * this directory, so a new file here is guarded the day it lands.
 */

import type { HabitDTO, HabitsDTO } from "@shared/types";

/** A habit by its id, or undefined — the caller reports the miss. */
export function findHabit(habits: HabitsDTO, habitId: string): HabitDTO | undefined {
  return habits.habits.find((s) => s.id === habitId && s.state !== "dismissed");
}

const PREAMBLE =
  "Habits kept from this user's own recordings. Each one is a HABIT.md written from a route " +
  "they actually walked, so it is evidence about what they did rather than general knowledge " +
  "about how software works. get_habit returns the file verbatim.";

/**
 * One habit's block in the catalogue, and the same block a search result draws.
 *
 * EXPORTED so `habit-search.ts` renders from this function rather than a second
 * copy of it — the `wayFork` rule. A disclosure added here appears in both
 * surfaces or in neither, which is the only way the two can be made unable to
 * disagree.
 */
export function habitLines(s: HabitDTO, others: ReadonlyMap<string, HabitDTO>): string[] {
  const b = s.binding;
  const out = [s.slug === "" ? s.title : s.slug];
  out.push(`  id: ${s.id}`);
  if (s.description !== "") out.push(`  ${s.description}`);
  // Concrete situational anchoring, and the cheapest disclosure on this list: an
  // agent deciding whether a habit is relevant asks "is this about the app I am
  // in?" before it asks anything else.
  if (s.apps.length > 0) out.push(`  passes through: ${s.apps.join(" → ")}`);

  const bits = [
    `v${s.version}`,
    `${b.recordings} recording${b.recordings === 1 ? "" : "s"}`,
    `prose: ${s.bodySource}`,
  ];
  if (s.pinned) bits.push("pinned");
  if (s.state === "archived") bits.push("archived");
  out.push(`  ${bits.join(" · ")}`);
  // The recordings disagreed. An agent that follows a multi-way file top to
  // bottom performs two procedures in sequence, which is why the record prints
  // "follow one of them, not all of them in sequence" — said here too, because
  // the catalogue is where the agent decides whether to fetch.
  if (s.ways.length > 1) {
    out.push(
      `  ${s.ways.length} WAYS recorded — the recordings did not take the same path. ` +
        `Follow ONE way, not all of them; \`get_habit_step\` needs a way letter.`,
    );
  }
  if (s.fork !== null) {
    // The withheld reason VERBATIM. `Verdict.withheld.reason` is a required
    // string precisely so it can be printed rather than summarised.
    out.push(
      s.fork.verdict.kind === "named"
        ? `  ${s.fork.verdict.text}`
        : `  No way is established as better: ${s.fork.verdict.reason}`,
    );
  }
  const dropped = s.droppedEarly.reduce((n, d) => n + d.count, 0);
  if (dropped > 0) {
    out.push(
      `  STARTED AND DROPPED — ${dropped} recording(s) began this work and stopped partway. ` +
        `They walked a different route and are NOT counted in the recordings above.`,
    );
  }
  // Who is speaking in the file. `prose: llm` in the bits above says a model
  // wrote it; this says a person has since taken it over.
  if (s.edited) out.push("  Hand-edited — the prose is the user's own words, not a model's.");

  // The two disclosures an agent actually needs to weigh the file, stated in the
  // LIST so it can choose before fetching. One recording is not a habit, and an
  // orphaned habit's steps have not been re-checked against anything.
  if (b.recordings === 1) {
    out.push("  RECORDED ONCE — kept from a single observation. Nothing has confirmed it repeats.");
  }
  if (b.state === "orphaned" || b.state === "ambiguous") {
    out.push(
      "  ORPHANED — the route this was written from is no longer in the trace graph. Its steps are a stored copy and have not been re-checked.",
    );
  } else if (b.state === "rebound") {
    out.push("  RE-BOUND — the states this flow passes through changed since it was kept.");
  }
  // Two files describing one procedure. Said in the list because an agent that
  // fetches both and finds them near-identical cannot tell whether that is a
  // duplicate or two genuinely different ways of doing the same work.
  //
  // Their RECORDS are byte-identical by construction — both are re-rendered from
  // the same live route, which is what made them duplicates — so the only thing
  // that CAN differ is the prose. Naming the ids alone left an agent with two
  // opaque keys and nothing to choose with.
  if (s.duplicates.length > 0) {
    const named = s.duplicates.map((id) => {
      const other = others.get(id);
      return other === undefined || other.slug === "" ? id : `${other.slug} (${id})`;
    });
    const quoted = s.duplicates
      .map((id) => others.get(id))
      .find((o) => o !== undefined && o.description !== "");
    out.push(
      `  ALSO DESCRIBED BY — ${named.join(", ")}. The recorded steps are identical; ` +
        (quoted === undefined
          ? "these habits answer to the same recorded route; nobody has merged them."
          : `these two differ only in how they are described. That one says: ${JSON.stringify(quoted.description)}`),
    );
  }

  out.push(`  route: ${b.routeKey}`);
  return out;
}

/**
 * The catalogue, or the specific reason it is empty.
 *
 * THREE empty states, never one — the `search_experience` rule. "No graph",
 * "a graph that yields no routes" and "routes nobody has kept" are different
 * situations with different remedies, and an agent handed a bare empty list
 * reports the wrong one. The third names how many routes are available, because
 * that is the actionable half.
 */
/** How many candidates to name before the rest are counted. */
const MAX_CANDIDATES = 10;

/**
 * Recorded routes nobody has kept yet, named with their recurrence.
 *
 * THIS IS THE ONLY PLACE AN AGENT CAN SEE THEM. `renderHabitList` used to
 * mention proposals solely in its EMPTY states, so the moment one habit was
 * kept the catalogue stopped reporting that eleven other routes had been walked
 * four times each — the very thing that makes one worth keeping.
 *
 * Recurrence is the whole disclosure, so the partition is by recurrence:
 * routes walked more than once are NAMED, routes walked once are COUNTED and
 * not named. That is `habitLines`'s RECORDED ONCE rule applied one level up — a
 * single walk is an observation, and presenting it beside a repeated route as
 * though the two were the same kind of thing is the misreading the whole file
 * exists to prevent. Counting them rather than dropping them keeps the
 * disclosure complete.
 *
 * `stepSummary` is used verbatim and never recomputed: it is the field that
 * exists BECAUSE the union of every walk over-counts. `preview` is deliberately
 * never printed — it is a whole rendered record and would dwarf the catalogue.
 */
function candidateBlock(habits: HabitsDTO): string {
  const repeated = habits.proposals.filter((p) => p.count > 1);
  const once = habits.proposals.length - repeated.length;
  if (repeated.length === 0 && once === 0) return "";

  const out: string[] = [];
  if (repeated.length > 0) {
    out.push(
      `NOT YET KEPT — ${repeated.length} recorded route${repeated.length === 1 ? "" : "s"} ` +
        `walked more than once that nobody has kept as a habit. Recurrence is the evidence: ` +
        `these have no prose and no HABIT.md, only a shape somebody repeated.`,
    );
    for (const p of repeated.slice(0, MAX_CANDIDATES)) {
      const name = p.name ?? p.label;
      const label = p.name === null ? "" : ` — ${p.label}`;
      out.push(`  ×${p.count}  ${name}${label} · ${p.stepSummary}`);
    }
    const more = repeated.length - MAX_CANDIDATES;
    if (more > 0) out.push(`  …and ${more} more, not listed.`);
  }
  if (once > 0) {
    out.push(
      `${once} further route${once === 1 ? " was" : "s were"} walked once each and ` +
        `${once === 1 ? "is" : "are"} not listed — one walk is an observation, and nothing ` +
        `has confirmed it repeats.`,
    );
  }
  out.push("`get_flow` shows one in full; keeping one is done in DeskRAG → Habits.");
  return out.join("\n");
}

export function renderHabitList(habits: HabitsDTO, noGraph: string): string {
  const kept = habits.habits.filter((s) => s.state !== "dismissed");

  if (kept.length === 0) {
    if (!habits.graphPresent) return noGraph;
    if (habits.proposals.length === 0) {
      return (
        "No habits, and no recorded routes to build them from: this graph carries no " +
        "provenance, so press `Rebuild trace graph` in DeskRAG (Settings → Maintenance)."
      );
    }
    const n = habits.proposals.length;
    return (
      `No habits have been kept yet. DeskRAG proposes one per recorded route and the user ` +
      `keeps the ones worth keeping — there ${n === 1 ? "is" : "are"} ${n} route${n === 1 ? "" : "s"} ` +
      `it could propose from right now. \`list_flows\` shows them; keeping one is done in ` +
      `DeskRAG → Habits.`
    );
  }

  // Keyed by id, because `duplicates` holds ids. Built from `habits.habits`
  // rather than `kept`: `duplicateHabits` pairs only ACTIVE habits, so both
  // members are present, but reading from the wider set means a filter change
  // upstream cannot silently turn every differentiator back into a bare id.
  const byId = new Map(habits.habits.map((h) => [h.id, h]));
  const body = kept.map((s) => habitLines(s, byId).join("\n")).join("\n\n");
  const hidden = habits.habits.length - kept.length;
  const foot =
    hidden > 0 ? "\n\nDismissed proposals are not listed." : "";
  // The candidates come AFTER the kept habits: the catalogue's job is to answer
  // "what has this user established", and what nobody has kept yet is context
  // for that answer rather than part of it.
  const candidates = candidateBlock(habits);
  const tail = candidates === "" ? "" : `\n\n${candidates}`;
  return `${PREAMBLE}\n\n${body}${foot}${tail}`;
}
