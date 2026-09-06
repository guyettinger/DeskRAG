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
 * count of recordings — plus the moment it was last seen. A tier is a word, a
 * count is a count and a date is a date; the recency weight that ORDERS the
 * values is a fraction and never leaves `knowledge-view.ts`, because a ratio
 * here would be `FrameResult.score` under a new name.
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

/**
 * A date, in the one format an agent cannot misread.
 *
 * ISO shape, and the DATE only: the values here are observed across whole
 * recordings and a time of day would claim a precision the fold does not have.
 * `null` is a value no recording could date, which is a state and not a zero.
 *
 * BUILT FROM LOCAL COMPONENTS, NOT `toISOString`, and that is not a nicety. The
 * screen renders the same moment with `toLocaleDateString`, so a UTC date makes
 * the two faces disagree by a day on a value observed after 5pm here —
 * `get_fact` said 2026-08-25 where the card said Aug 24, for one value, measured.
 * The label itself is rendered once in main precisely so the faces cannot
 * disagree; furniture that contradicts the screen defeats that for free.
 */
function on(at: number | null): string {
  if (at === null) return "undated";
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The verdict's date, when there is one.
 *
 * The paper's supersession keeps both claims and DATES them, and a "current"
 * with no *as of* cannot be checked against the list under it.
 */
function asOf(fact: KnowledgeFactDTO | KnowledgeFactDetailDTO): string {
  return fact.currentSince === null ? "" : ` (as of ${on(fact.currentSince)})`;
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
    : `Current: ${fact.current}${asOf(fact)}\n  ${fact.reason}`;
}

/** The tail every fact carries: what could not be placed, and what is not listed. */
function caveats(fact: KnowledgeFactDTO | KnowledgeFactDetailDTO): string[] {
  const out: string[] = [];
  if (fact.unidentified > 0) {
    out.push(
      `  ${plural(fact.unidentified, "observation")} could not be placed under this fact's ` +
        `identity — counted here rather than dropped, and never folded into a value.`,
    );
  }
  if (fact.unlisted > 0) {
    out.push(
      `  ${plural(fact.unlisted, "further value")} not listed — the values above are the ` +
        `most recently corroborated, and the rest are counted rather than dropped.`,
    );
  }
  if (fact.projected) {
    out.push(
      `  The payloads behind this fact are PROJECTED, not raw: the reader keeps the layout ` +
        `identifier and drops the ~70 keycode mappings beside it, so a variant below is what ` +
        `was folded and not what was recorded.`,
    );
  }
  return out;
}

function valueLine(v: KnowledgeValueDTO): string {
  const variants =
    v.variants > 1 ? `, folded from ${plural(v.variants, "distinct payload")}` : "";
  // The CURRENT row is marked IN THE BULLET rather than left to be matched
  // against the verdict by its label — labels are a rendering, and the list is
  // ordered by recent evidence, so the current value is usually but not always
  // the first row. In the bullet because that column is otherwise constant, so
  // one glance down it finds the answer.
  const bullet = v.isCurrent ? "*" : "-";
  return (
    `  ${bullet} ${v.label} — ${evidence(v.stability)}, ` +
    `${plural(v.observations, "observation")}, last seen ${on(v.lastObservedAt)}${variants}`
  );
}

/** One fact, as `list_facts` prints it. */
export function renderFact(fact: KnowledgeFactDTO): string {
  const lines = [
    // The ID is what `get_fact` takes; the KIND is where the fact was read from,
    // and two facts share one. Both are printed because an agent needs the first
    // to ask again and the second to know what it is looking at.
    `${fact.title} (${fact.id}, from ${fact.kind}) · ${attributionNote(fact)}`,
    // THE EVIDENCE BEFORE THE ANSWER, `search_habits`'s rule at the grain of one
    // fact: "7 applications" folded from 92 observations and the same 7 folded
    // from 9 are different claims.
    `  ${plural(fact.observations, "observation")} -> ` +
      `${plural(fact.values.length + fact.unlisted, "distinct value")}`,
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
      `from the recorded events on every call. Values are listed most recently ` +
      `corroborated first, and the current one — where a fact has one — is marked \`*\`.`,
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
    `${fact.title} (${fact.id}, from ${fact.kind}) · ${attributionNote(fact)}`,
    `  ${verdict(fact)}`,
  ];
  if (fact.values.length === 0) lines.push("  Nothing has been observed for this fact.");
  for (const v of fact.values) {
    lines.push(
      "",
      `  ${v.label}${v.isCurrent ? "  [current]" : ""}`,
      `    ${evidence(v.stability)}, ${plural(v.observations, "observation")}, ` +
        `last seen ${on(v.lastObservedAt)}`,
      `    ${plural(v.variants.length, "distinct payload")} folded into this one value:`,
    );
    for (const raw of v.variants) lines.push(`      ${raw}`);
  }
  const tail = caveats(fact);
  if (tail.length > 0) lines.push("", ...tail);
  return lines.join("\n");
}
