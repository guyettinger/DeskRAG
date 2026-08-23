/**
 * `search_habits` — one habit for a situation, out of a corpus an agent should
 * not have to read whole.
 *
 * TWO LANES, fused by RANK, which is Tier 1's architecture at a smaller scale
 * and is chosen for the reason Tier 1 measured: on a default install the
 * lexical lane is the only route from a query to an exact term.
 *
 * The DENSE lane reads the AUTHORED half — title, description, prose, apps —
 * and not the whole file, for two measured reasons. Both pinned text models
 * truncate hard at 2,048 tokens against a ~1,583-token median composite, so
 * embedding the file is one long habit away from a document whose tail was
 * never seen. And a duplicate pair's RECORD blocks are byte-identical by
 * construction (`habit-text.ts` says so: both are re-rendered from the same
 * live route, which is what made them duplicates), so a vector over the record
 * cannot separate two habits the app already knows are two descriptions of one
 * procedure.
 *
 * The LEXICAL lane reads the whole markdown, which is where the exact terms the
 * dense lane dropped actually live — a button label, a URL, an app.
 *
 * Pure: no MCP SDK, no Electron, no store, no model. The dense lane arrives as
 * a parameter, so every branch below is reachable from the root suite.
 *
 * NO SCORE. Output is a rank plus which lanes a habit appeared in and where —
 * the `FrameEvidence` precedent, and the rule `search_experience` already
 * follows. A fused RRF value is not a confidence and is not comparable between
 * queries; an agent handed one reports a percentage to a user.
 */

import type { HabitDTO, HabitsDTO } from "@shared/types";
import { DEFAULT_RRF_K, reciprocalRankFusion, type RankedList } from "deskrag";
import { habitLines, renderHabitList } from "./habit-text.js";

/**
 * Below this many kept habits, the ranking is disclosed as barely a ranking.
 *
 * UNSWEPT, and it ships that way deliberately — the store it was written
 * against holds ONE kept habit, so only the `1 kept` branch can run on real
 * data. It joins the three floors C2 and C3 already ship unswept
 * (`RHYTHM_MIN_WALKS`/`RHYTHM_MIN_DAYS`, `FADE_MULTIPLE`/`FADE_FLOOR_MS`,
 * `FORK_VERDICT_MIN_WALKS`). C2's own spec prediction was falsified within six
 * days when the library grew; treat this number with the same suspicion.
 */
export const RANKING_MIN_HABITS = 5;

/** The two documents one habit contributes, one per lane. */
export interface HabitDoc {
  id: string;
  /** The AUTHORED half — what the dense lane embeds. */
  dense: string;
  /** The whole rendered file — what the lexical lane indexes. */
  lexical: string;
}

export function habitDocs(habits: readonly HabitDTO[]): HabitDoc[] {
  return habits.map((h) => ({
    id: h.id,
    dense: [h.title, h.description, h.body, h.apps.join(" ")]
      .filter((s) => s.trim() !== "")
      .join("\n\n"),
    lexical: h.markdown,
  }));
}

/** Lowercase alphanumeric runs. Single characters are dropped as noise. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 over the whole markdown, in memory, best first.
 *
 * IN MEMORY and not an FTS table: habits are `AUTHORED_TABLES`, and a derived
 * table beside them would make "can a purge remake it?" a question with two
 * answers, for a corpus of tens of documents.
 *
 * Documents with NO query term are OMITTED, and that is the point — this lane's
 * membership is a signal, where the dense lane's is not.
 */
export function bm25Ranking(docs: readonly HabitDoc[], query: string): string[] {
  const terms = tokenize(query);
  if (terms.length === 0 || docs.length === 0) return [];

  const toks = docs.map((d) => tokenize(d.lexical));
  const total = toks.reduce((n, t) => n + t.length, 0);
  const avg = total === 0 ? 1 : total / toks.length;

  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);

  const scored = docs.map((d, i) => {
    const own = toks[i] ?? [];
    const tf = new Map<string, number>();
    for (const term of own) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const n = df.get(term) ?? 0;
      // Lucene's always-positive idf. Textbook BM25 is
      // log((N - n + 0.5) / (n + 0.5)), which goes NEGATIVE once a term appears
      // in more than half the documents — over a corpus of ten habits that is
      // any word two of them share, and a MATCH would subtract.
      const idf = Math.log(1 + (toks.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * own.length) / avg)));
    }
    return { id: d.id, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .map((s) => s.id);
}

/** 0 rather than NaN against a zero vector — an unembeddable habit is not a match. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Every id, closest first. This lane ranks everything, so its MEMBERSHIP says nothing — its rank does. */
export function denseRanking(
  ids: readonly string[],
  docVectors: readonly Float32Array[],
  queryVector: Float32Array,
): string[] {
  return ids
    .map((id, i) => ({ id, score: cosine(queryVector, docVectors[i] ?? new Float32Array(0)) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .map((s) => s.id);
}

/**
 * The dense lane, or the reason there isn't one.
 *
 * `reason` is REQUIRED on the skipped arm — the `Verdict.withheld` and
 * `StageSpec.skipReason` rule. A quietly lexical-only ranking is
 * indistinguishable from a working one.
 */
export type DenseLane = { kind: "ranked"; ids: string[] } | { kind: "skipped"; reason: string };

export interface HabitSearchInput {
  habits: HabitsDTO;
  query: string;
  limit: number;
  dense: DenseLane;
  /** `tools.ts`'s NO_GRAPH, passed in so the two cannot drift. */
  noGraph: string;
}

const LANE_PROSE = "prose";
const LANE_TERMS = "exact terms";

/** What "best first" is worth here, said once per response rather than implied by a number. */
function corpusNote(n: number): string {
  const relative =
    "Ranking is RELATIVE to this corpus: there is no score here, and the best match of any " +
    'query comes first however weak it is. "matched in" names the lanes each habit appeared ' +
    "in, and its rank within that lane.";
  if (n === 1) {
    return (
      "There is 1 kept habit, so it is the only candidate below. Nothing was ranked against " +
      `it — this is not a match. ${relative}`
    );
  }
  if (n < RANKING_MIN_HABITS) {
    return (
      `Ranked among ${n} kept habits. A corpus this small ranks nearly everything, so read ` +
      `the disclosures on each before relying on the order. ${relative}`
    );
  }
  return `${n} kept habits, best first. ${relative}`;
}

/** Recurring routes nobody kept. Counted, never ranked: a proposal has no prose to match. */
function unkeptNote(habits: HabitsDTO): string {
  const repeated = habits.proposals.filter((p) => p.count > 1).length;
  if (repeated === 0) return "";
  return (
    `\n\n${repeated} recorded route${repeated === 1 ? " is" : "s are"} walked more than once ` +
    `but not kept as a habit, so ${repeated === 1 ? "it has" : "they have"} no prose and ` +
    `cannot be searched here. \`list_habits\` names ${repeated === 1 ? "it" : "them"}.`
  );
}

export function renderHabitSearch(input: HabitSearchInput): string {
  const kept = input.habits.habits.filter((h) => h.state !== "dismissed");
  // The three distinct emptinesses, reused rather than restated — "no graph",
  // "a graph with no routes" and "routes nobody kept" have different remedies.
  if (kept.length === 0) return renderHabitList(input.habits, input.noGraph);

  const docs = habitDocs(kept);
  const lexical = bm25Ranking(docs, input.query);

  const lanes: RankedList[] = [];
  if (lexical.length > 0) lanes.push({ key: LANE_TERMS, ids: lexical });
  if (input.dense.kind === "ranked" && input.dense.ids.length > 0) {
    lanes.push({ key: LANE_PROSE, ids: input.dense.ids });
  }

  const skipNote =
    input.dense.kind === "skipped"
      ? `The prose lane was skipped: ${input.dense.reason}. Only exact terms were matched.`
      : "";

  if (lanes.length === 0) {
    return (
      `No kept habit contains any of those terms` +
      (skipNote === "" ? "." : `, and ${skipNote.charAt(0).toLowerCase()}${skipNote.slice(1)}`) +
      ` \`list_habits\` prints all ${kept.length}.` +
      unkeptNote(input.habits)
    );
  }

  const byId = new Map(input.habits.habits.map((h) => [h.id, h]));
  const fused = reciprocalRankFusion(lanes, DEFAULT_RRF_K).slice(0, input.limit);

  const blocks = fused.map((item, i) => {
    const h = byId.get(item.id);
    if (h === undefined) return `${i + 1}. ${item.id}`;
    const block = habitLines(h, byId);
    const matched = [LANE_PROSE, LANE_TERMS]
      .filter((key) => item.ranks[key] !== undefined)
      .map((key) => `${key} #${item.ranks[key]}`)
      .join(", ");
    return [`${i + 1}. ${block[0] ?? h.title}`, ...block.slice(1), `  matched in: ${matched}`].join(
      "\n",
    );
  });

  const head = [corpusNote(kept.length), skipNote].filter((s) => s !== "").join("\n\n");
  return `${head}\n\n${blocks.join("\n\n")}${unkeptNote(input.habits)}`;
}
