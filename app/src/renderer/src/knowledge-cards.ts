/**
 * What a Knowledge card says, as strings — pure, and therefore `.ts` and in the
 * root suite rather than eyeballed in the running app.
 *
 * The VALUE's own text is not minted here: `knowledge-view.ts` renders a label
 * once, in main, so this screen and the `list_facts` tool are byte-identical on
 * the thing they are both about. What this file adds is the card's own
 * furniture — the evidence line, the disclosures, the corpus footer — which is
 * this face's wording and nobody else's.
 *
 * NOTHING HERE IS A RATIO. A value's evidence is a tier and a count of
 * recordings, which is what may be printed where `FrameResult.score` may not.
 */

import type { KnowledgeDTO, KnowledgeFactDTO, KnowledgeValueDTO } from "@shared/types";

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Whether the recorder exclusion touched this fact, as a chip.
 *
 * ON THE CARD BECAUSE THE CARD HAS TO BE ABLE TO SAY IT. Measured, applying the
 * exclusion to the ambient facts costs 6 of 12 recordings their display and
 * keymap observations outright — so a screen that quietly did so would state one
 * display setup where there are two, and would have no way to explain itself.
 */
export function attributionChip(fact: KnowledgeFactDTO): string {
  return fact.attribution === "ambient" ? "ambient" : "recorder excluded";
}

/** The long form, for the chip's title — the chip states a word, this the rule. */
export function attributionNote(fact: KnowledgeFactDTO): string {
  return fact.attribution === "ambient"
    ? "Sampled whatever application was frontmost, so this is not about the recorder and " +
        "the recorder exclusion does not apply to it."
    : "This fact is about the focused application, so the stretches where the recorder was " +
        "frontmost are left out.";
}

/**
 * A value's evidence: a tier, the recordings behind it, and what it folded.
 *
 * `withheld` is a tier that could not be computed — a graph lifted before
 * provenance existed — and is deliberately not shown as zero recordings, which
 * is a different state entirely.
 */
export function evidenceLine(value: KnowledgeValueDTO): string {
  const parts = [
    value.stability.tier ?? "withheld",
    plural(value.stability.sessions, "recording"),
  ];
  // Only when the fold actually did something: "1 payload" on every row would be
  // noise on three facts out of four.
  if (value.variants > 1) parts.push(plural(value.variants, "payload"));
  return parts.join(" · ");
}

/** What could not be placed and what could not be dated. Counts, never dropped. */
export function caveatLines(fact: KnowledgeFactDTO): string[] {
  const out: string[] = [];
  if (fact.unidentified > 0) {
    out.push(
      `${plural(fact.unidentified, "observation")} could not be placed under this fact's ` +
        `identity — counted, never folded in.`,
    );
  }
  if (fact.undated > 0) {
    out.push(
      `${plural(fact.undated, "observation")} came from a recording that could not be dated, ` +
        `so it could not be ordered against the others.`,
    );
  }
  return out;
}

/**
 * The corpus, in the footer.
 *
 * `flows()`'s stated reasoning, for the same list: a reader who finds their own
 * application missing is entitled to that answer without opening Settings. The
 * NAMES are given rather than a count, because unlike the Flows chip this is a
 * footer with room for a sentence and nothing here is truncated.
 */
export function corpusLines(dto: KnowledgeDTO): string[] {
  const out = [
    `Derived from ${plural(dto.recordings, "recording")}, recomputed on every visit — ` +
      `nothing on this screen is stored.`,
  ];
  if (dto.excludedApps.length > 0) {
    out.push(
      `${plural(dto.excludedEvents, "event")} left out as the recorder's own ` +
        `(${dto.excludedApps.join(", ")}). Facts marked ambient keep theirs.`,
    );
  }
  if (dto.unattributable > 0) {
    out.push(
      `${plural(dto.unattributable, "recording")} carried no focus events, so nothing in ` +
        `${dto.unattributable === 1 ? "it" : "them"} could be attributed to an application ` +
        `and nothing was left out.`,
    );
  }
  return out;
}
