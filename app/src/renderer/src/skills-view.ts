/**
 * How the Skills screen orders and labels what it is given.
 *
 * A `.ts` module, never `.tsx`: the root `tsconfig.json` sets no `jsx`, so a
 * root test that reaches into a `.tsx` — even for a type — breaks
 * `npm run typecheck`. Main decides what a row MEANS; this decides how it reads.
 */

import type { SkillBindState, SkillDTO, SkillProposalDTO } from "@shared/types";

/**
 * Which band a skill is drawn in.
 *
 * "Needs attention" leads, because a skill whose evidence moved is the only
 * thing on this screen that can be silently wrong, and a band that sorts below
 * the ones that are fine would hide exactly that.
 */
export type SkillBand = "attention" | "mine" | "archived";

const NEEDS_ATTENTION: readonly SkillBindState[] = ["rebound", "ambiguous", "orphaned"];

export function bandOf(skill: SkillDTO): SkillBand {
  if (skill.state === "archived") return "archived";
  // A duplicate needs attention for the same reason a re-bind does: something
  // about this skill is unresolved and only a person can resolve it. It is not
  // a binding STATE — the binding is exact and correct on both halves — so it
  // is checked separately rather than folded into `SkillBindState`.
  if (skill.duplicates.length > 0) return "attention";
  return NEEDS_ATTENTION.includes(skill.binding.state) ? "attention" : "mine";
}

/**
 * Pinned first, then newest-touched.
 *
 * `updatedAt` rather than `createdAt`, so editing a skill moves it to the top of
 * its band — the thing just worked on is the thing being looked for.
 */
export function orderSkills(skills: readonly SkillDTO[]): SkillDTO[] {
  return [...skills].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
  );
}

export interface SkillBands {
  attention: SkillDTO[];
  mine: SkillDTO[];
  archived: SkillDTO[];
}

/** Active and archived split, dismissals dropped — they are not skills. */
export function bandSkills(skills: readonly SkillDTO[]): SkillBands {
  const out: SkillBands = { attention: [], mine: [], archived: [] };
  for (const s of orderSkills(skills)) {
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
export function bindingChip(skill: SkillDTO): string | null {
  const b = skill.binding;
  // Said FIRST: a duplicate is the one thing here that another skill also
  // claims, and a row reading "re-bound" while two files describe one route
  // points at the smaller of the two problems.
  if (skill.duplicates.length > 0) return "duplicated";
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
export function evidenceLine(skill: SkillDTO): string {
  const b = skill.binding;
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

/** "×5", and whether that count is strong enough to lead with. */
export function proposalCount(p: SkillProposalDTO): { text: string; repeated: boolean } {
  return { text: `×${p.count}`, repeated: p.count > 1 };
}

/**
 * Proposals in `frequentRoutes`' own order — count first, then length.
 *
 * The order is preserved rather than recomputed: main already sorted them, and a
 * second sort here would be a second opinion about what "most walked" means.
 */
export function orderProposals(proposals: readonly SkillProposalDTO[]): SkillProposalDTO[] {
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
