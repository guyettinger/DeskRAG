/**
 * The two Knowledge tools' text: facts, their values, and what DeskRAG will and
 * will not call current.
 *
 * Pure, like every other renderer here — no reader, no store, no MCP SDK.
 *
 * THE CORPUS COMES FIRST, before any answer, on `search_habits`'s rule: a fact
 * folded from twelve recordings and a fact folded from one are different claims,
 * and an agent that is not told the size of the evidence will report the second
 * as though it were the first.
 *
 * NO SCORE, NO PERCENTAGE. A value's evidence is a stability tier — a word and a
 * count of recordings — which is exactly the disclosure the Flows graph shows,
 * and a ratio here would be `FrameResult.score` under a new name.
 */

import type {
  KnowledgeDTO,
  KnowledgeFactDTO,
  KnowledgeFactDetailDTO,
  KnowledgeValueDTO,
  StabilityDTO,
} from "@shared/types";

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * A value's evidence, in the vocabulary the rest of the app already uses.
 *
 * The tier's own `reason` is not repeated per value — it is one sentence
 * restated identically on every row, and the number it is computed from is right
 * here. `withheld` is a graph lifted before provenance existed, which is a state
 * and not a zero.
 */
function evidence(s: StabilityDTO): string {
  const tier = s.tier ?? "withheld";
  return `${tier}, seen in ${plural(s.sessions, "recording")}`;
}

/** What the recorder exclusion did or did not do to this fact. */
function attributionNote(fact: KnowledgeFactDTO | KnowledgeFactDetailDTO): string {
  return fact.attribution === "ambient"
    ? "ambient — sampled whatever was frontmost, so the recorder exclusion does NOT apply"
    : "about the focused application, so the recorder's own stretches are excluded";
}

/** The answer, or the refusal, in the same slot. A refusal IS an answer here. */
function verdict(fact: KnowledgeFactDTO | KnowledgeFactDetailDTO): string {
  return fact.current === null
    ? `No current value. ${fact.reason}`
    : `Current: ${fact.current}\n  ${fact.reason}`;
}

/** The tail every fact carries: what could not be placed, and what could not be dated. */
function caveats(fact: KnowledgeFactDTO | KnowledgeFactDetailDTO): string[] {
  const out: string[] = [];
  if (fact.unidentified > 0) {
    out.push(
      `  ${plural(fact.unidentified, "observation")} could not be placed under this fact's ` +
        `identity — counted here rather than dropped, and never folded into a value.`,
    );
  }
  if (fact.undated > 0) {
    out.push(
      `  ${plural(fact.undated, "observation")} came from a recording that could not be dated, ` +
        `so it could not be ordered against the others.`,
    );
  }
  return out;
}

function valueLine(v: KnowledgeValueDTO): string {
  const variants =
    v.variants > 1 ? `, folded from ${plural(v.variants, "distinct payload")}` : "";
  return `  - ${v.label} — ${evidence(v.stability)}, ${plural(v.observations, "observation")}${variants}`;
}

/** One fact, as `list_facts` prints it. */
export function renderFact(fact: KnowledgeFactDTO): string {
  const lines = [
    `${fact.title} (${fact.kind}) · ${attributionNote(fact)}`,
    `  ${verdict(fact)}`,
  ];
  if (fact.values.length === 0) lines.push("  Nothing has been observed for this fact.");
  for (const v of fact.values) lines.push(valueLine(v));
  lines.push(...caveats(fact));
  return lines.join("\n");
}

/**
 * Every fact, with the corpus first.
 *
 * The excluded applications are NAMED, not counted — this is an agent reading,
 * not a chip on a screen, and a reader who finds their own application missing
 * is entitled to the answer without opening Settings. `flows()` states the same
 * reasoning for the same list.
 */
export function renderFacts(dto: KnowledgeDTO): string {
  if (dto.recordings === 0) {
    return (
      "Nothing has been recorded yet, so there are no facts. These are derived from " +
      "recordings — they are not configuration, and there is nothing to read until a " +
      "session has been captured."
    );
  }
  const head = [
    `${plural(dto.facts.length, "environment fact")}, derived from ` +
      `${plural(dto.recordings, "recording")}. Nothing here is stored: a fact is recomputed ` +
      `from the recorded events on every call.`,
  ];
  if (dto.excludedApps.length > 0) {
    head.push(
      `${plural(dto.excludedEvents, "event")} excluded as the recorder's own ` +
        `(${dto.excludedApps.join(", ")}). That exclusion applies to the facts ABOUT the ` +
        `focused application and deliberately not to the ambient ones — the display topology ` +
        `while the recorder is frontmost is the same display topology.`,
    );
  }
  if (dto.unattributable > 0) {
    head.push(
      `${plural(dto.unattributable, "recording")} carried no focus events at all, so nothing ` +
        `in ${dto.unattributable === 1 ? "it" : "them"} could be attributed to any application ` +
        `and nothing was excluded.`,
    );
  }
  return [head.join(" "), ...dto.facts.map(renderFact)].join("\n\n");
}

/** The kinds a caller may ask for, for an error message that can be acted on. */
export function factKinds(dto: KnowledgeDTO): string {
  return dto.facts.map((f) => f.kind).join(", ");
}

/**
 * One fact in full, raw payloads included.
 *
 * THE VARIANTS ARE THE POINT. A folded value is a claim that several observed
 * payloads are one thing, and the payloads are the only evidence for it — on the
 * real library the same 1920x1080 primary display carried seven different ids
 * because macOS re-mints them, and nothing but this list shows that.
 */
export function renderFactDetail(fact: KnowledgeFactDetailDTO): string {
  const lines = [
    `${fact.title} (${fact.kind}) · ${attributionNote(fact)}`,
    `  ${verdict(fact)}`,
  ];
  if (fact.values.length === 0) lines.push("  Nothing has been observed for this fact.");
  for (const v of fact.values) {
    lines.push(
      "",
      `  ${v.label}`,
      `    ${evidence(v.stability)}, ${plural(v.observations, "observation")}`,
      `    ${plural(v.variants.length, "distinct payload")} folded into this one value:`,
    );
    for (const raw of v.variants) lines.push(`      ${raw}`);
  }
  const tail = caveats(fact);
  if (tail.length > 0) lines.push("", ...tail);
  return lines.join("\n");
}
