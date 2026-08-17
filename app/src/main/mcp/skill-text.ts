/**
 * The skill CATALOGUE as text — what `list_skills` prints.
 *
 * Only the list. `get_skill` returns the SKILL.md verbatim and this module is
 * not involved, deliberately: the value of that tool is that its output IS a
 * file, and anything wrapping it would corrupt a paste-to-disk.
 *
 * In `mcp/` so `test/mcp.readonly.test.ts` covers it — the guard `readdirSync`s
 * this directory, so a new file here is guarded the day it lands.
 */

import type { SkillDTO, SkillsDTO } from "@shared/types";

/** A skill by its id, or undefined — the caller reports the miss. */
export function findSkill(skills: SkillsDTO, skillId: string): SkillDTO | undefined {
  return skills.skills.find((s) => s.id === skillId && s.state !== "dismissed");
}

const PREAMBLE =
  "Skills kept from this user's own recordings. Each one is a SKILL.md written from a route " +
  "they actually walked, so it is evidence about what they did rather than general knowledge " +
  "about how software works. get_skill returns the file verbatim.";

function lines(s: SkillDTO): string[] {
  const b = s.binding;
  const out = [s.slug === "" ? s.title : s.slug];
  out.push(`  id: ${s.id}`);
  if (s.description !== "") out.push(`  ${s.description}`);

  const bits = [
    `${b.recordings} recording${b.recordings === 1 ? "" : "s"}`,
    `prose: ${s.bodySource}`,
  ];
  if (s.pinned) bits.push("pinned");
  if (s.state === "archived") bits.push("archived");
  out.push(`  ${bits.join(" · ")}`);

  // The two disclosures an agent actually needs to weigh the file, stated in the
  // LIST so it can choose before fetching. One recording is not a habit, and an
  // orphaned skill's steps have not been re-checked against anything.
  if (b.recordings === 1) {
    out.push("  RECORDED ONCE — one observation, not an established habit.");
  }
  if (b.state === "orphaned" || b.state === "ambiguous") {
    out.push(
      "  ORPHANED — the route this was written from is no longer in the trace graph. Its steps are a stored copy and have not been re-checked.",
    );
  } else if (b.state === "rebound") {
    out.push("  RE-BOUND — the states this flow passes through changed since it was kept.");
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
export function renderSkillList(skills: SkillsDTO, noGraph: string): string {
  const kept = skills.skills.filter((s) => s.state !== "dismissed");

  if (kept.length === 0) {
    if (!skills.graphPresent) return noGraph;
    if (skills.proposals.length === 0) {
      return (
        "No skills, and no recorded routes to build them from: this graph carries no " +
        "provenance, so press `Rebuild trace graph` in DeskRAG (Settings → Maintenance)."
      );
    }
    const n = skills.proposals.length;
    return (
      `No skills have been kept yet. DeskRAG proposes one per recorded route and the user ` +
      `keeps the ones worth keeping — there ${n === 1 ? "is" : "are"} ${n} route${n === 1 ? "" : "s"} ` +
      `it could propose from right now. \`list_flows\` shows them; keeping one is done in ` +
      `DeskRAG → Skills.`
    );
  }

  const body = kept.map((s) => lines(s).join("\n")).join("\n\n");
  const hidden = skills.skills.length - kept.length;
  const foot =
    hidden > 0 ? "\n\nDismissed proposals are not listed." : "";
  return `${PREAMBLE}\n\n${body}${foot}`;
}
