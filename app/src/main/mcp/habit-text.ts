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

function lines(s: HabitDTO): string[] {
  const b = s.binding;
  const out = [s.slug === "" ? s.title : s.slug];
  out.push(`  id: ${s.id}`);
  if (s.description !== "") out.push(`  ${s.description}`);

  const bits = [
    `v${s.version}`,
    `${b.recordings} recording${b.recordings === 1 ? "" : "s"}`,
    `prose: ${s.bodySource}`,
  ];
  if (s.pinned) bits.push("pinned");
  if (s.state === "archived") bits.push("archived");
  out.push(`  ${bits.join(" · ")}`);

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
  if (s.duplicates.length > 0) {
    out.push(
      `  ALSO DESCRIBED BY — ${s.duplicates.join(", ")}. These habits answer to the same recorded route; nobody has merged them.`,
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

  const body = kept.map((s) => lines(s).join("\n")).join("\n\n");
  const hidden = habits.habits.length - kept.length;
  const foot =
    hidden > 0 ? "\n\nDismissed proposals are not listed." : "";
  return `${PREAMBLE}\n\n${body}${foot}`;
}
