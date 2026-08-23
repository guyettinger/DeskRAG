/**
 * Where a habit's Ways share a spine, and where they fork.
 *
 * The record prints each Way as an independent numbered list, so a reader has
 * to diff four procedures by eye. This is the diff, and it is the ONE
 * implementation both formatters read — `habit-doc.ts` renders it into the
 * file and `HabitsScreen.tsx` draws it. Two readers of one tree is the
 * `ax-dump`/`ax-exec` drift hazard by name.
 *
 * Pure: `FlowsDTO` in, plain objects out. No store, no Electron, no model —
 * the same contract `flow-steps.ts` and `walk-analysis.ts` hold, and what keeps
 * this file in the ROOT suite.
 *
 * IT ALIGNS ON PLACE LABELS, NOT ON EDGE IDS, and that is a measurement rather
 * than a preference. Read off the real store on 2026-08-23: the one route with
 * several Ways has FOUR of them and they share EXACTLY ONE EDGE between them.
 * Aligning on edge ids yields two disjoint lists with zero matches — not a
 * fork. The cause is structural and no corpus growth fixes it: a node's
 * identity is what the task does next, so two recordings of the same button
 * mashing lift to different nodes and therefore different edges. It is the same
 * fact that made `FlowRouteDTO.id` a place-label sequence, where edge-id and
 * node-id keys both split five identical walks into nine routes of ×1.
 *
 * THERE IS NO SCORE HERE. `walk-align.ts` states the rule for its own numbers
 * and it holds here: an edit-distance ratio is exactly the figure this repo
 * refuses to print. What comes out is a spine a person can check against a
 * screen, the runs that hang off it, and — behind two gates — one sentence
 * comparing printed ranges.
 */

import type { FlowStep, FlowWalk } from "./flow-steps.js";

/**
 * A step's place identity: where it came from and where it went.
 *
 * A NUL delimiter, for the reason `src/store/store.ts` uses one — a place label
 * cannot contain one, so the joined key cannot collide. Written as an ESCAPE
 * rather than a literal byte, because two literal NULs in `store.ts` are why
 * `grep` silently skips that file.
 */
export const placeKey = (s: FlowStep): string => `${s.from}\0${s.to}`;

/**
 * The longest common subsequence of two key sequences.
 *
 * Standard O(nm) DP with a forward traceback. The tie-break prefers advancing
 * `a`, which makes the result deterministic — a spine that moved between runs
 * would re-order the record on every read.
 */
function lcs(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length;
  const m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      len[i]![j] =
        a[i] === b[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(a[i]!);
      i += 1;
      j += 1;
    } else if (len[i + 1]![j]! >= len[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

/**
 * A place-step sequence every Way contains, in order.
 *
 * Folded pairwise: the first Way, then LCS'd against each subsequent one. An
 * N-way LCS is NP-hard, so this is the standard progressive approximation and
 * is NOT claimed to be the longest such sequence — only to be one every Way
 * contains, which is true of any fold result and is the property both surfaces
 * rely on. `test/way-fork.test.ts` asserts exactly that property rather than a
 * length.
 */
export function spineOf(ways: readonly FlowWalk[]): string[] {
  if (ways.length === 0) return [];
  let spine = ways[0]!.steps.map(placeKey);
  for (let i = 1; i < ways.length; i += 1) {
    if (spine.length === 0) break;
    spine = lcs(spine, ways[i]!.steps.map(placeKey));
  }
  return spine;
}

/** One Way's own step at a spine position. */
export interface SpineAt {
  wayIndex: number;
  step: FlowStep;
}

/** What one Way did in the gap between two spine positions. May be empty. */
export interface ForkRun {
  wayIndex: number;
  steps: FlowStep[];
}

export type ForkRow =
  /** A place-step every Way took, with each Way's own step at that position. */
  | { kind: "spine"; from: string; to: string; at: SpineAt[] }
  /** The gap AFTER spine position `after`. `-1` is the gap before the first. */
  | { kind: "fork"; after: number; runs: ForkRun[] };

/**
 * One Way scanned forward against the spine.
 *
 * Greedy leftmost matching, which always succeeds when the spine is a
 * subsequence of the Way — and `spineOf` guarantees that it is, so `at` is
 * fully populated. `runs` has `spine.length + 1` entries: `runs[k]` is what
 * this Way did BEFORE spine position `k`, and `runs[spine.length]` is what it
 * did after the last one.
 */
function scan(
  steps: readonly FlowStep[],
  spine: readonly string[],
): { at: (FlowStep | undefined)[]; runs: FlowStep[][] } {
  const at = new Array<FlowStep | undefined>(spine.length).fill(undefined);
  const runs: FlowStep[][] = Array.from({ length: spine.length + 1 }, () => []);
  let k = 0;
  for (const s of steps) {
    if (k < spine.length && placeKey(s) === spine[k]) {
      at[k] = s;
      k += 1;
    } else {
      runs[k]!.push(s);
    }
  }
  return { at, runs };
}

/**
 * The spine and its forks, as one ordered list a formatter can walk.
 *
 * A fork row is emitted ONLY where at least one Way filled the gap — a row of
 * four "nothing here"s is noise, and `cautionsFor` already paid for that shape
 * once by printing one fact twelve times in an eighteen-bullet section. But
 * within a row that IS drawn, every Way appears, empty run and all: "B did
 * nothing here" and "B is not in this picture" are different facts.
 */
export function forkRows(ways: readonly FlowWalk[], spine: readonly string[]): ForkRow[] {
  const scans = ways.map((w) => scan(w.steps, spine));
  const out: ForkRow[] = [];

  const gap = (k: number): void => {
    const runs = scans.map((s, i) => ({ wayIndex: ways[i]!.index, steps: s.runs[k]! }));
    if (runs.some((r) => r.steps.length > 0)) out.push({ kind: "fork", after: k - 1, runs });
  };

  for (let k = 0; k < spine.length; k += 1) {
    gap(k);
    const at: SpineAt[] = [];
    for (let i = 0; i < ways.length; i += 1) {
      const s = scans[i]!.at[k];
      // Cannot be undefined — the spine is a subsequence of every Way and
      // greedy leftmost matching of a subsequence always succeeds. Guarded
      // rather than asserted so a future spine rule that breaks the invariant
      // degrades to a thinner row instead of throwing at render time.
      if (s !== undefined) at.push({ wayIndex: ways[i]!.index, step: s });
    }
    const first = at[0];
    out.push({
      kind: "spine",
      from: first?.step.from ?? "",
      to: first?.step.to ?? "",
      at,
    });
  }
  gap(spine.length);
  return out;
}

/**
 * What one Way did in a gap, in words.
 *
 * The words live HERE rather than in either formatter, so the file and the
 * screen cannot disagree about them — the same reason `differBlock` prints
 * `Baseline.reason` verbatim.
 *
 * A single step names BOTH its places, because on the real store the one
 * single-step run is Way C's `n0 — no state → Calculator`, where the FROM is
 * the entire news. A longer run names its distinct destinations instead: nine
 * lines of `TextEdit → TextEdit` is not a reading.
 */
export function runPhrase(run: ForkRun, after: number): string {
  const lead = after < 0 ? "first, " : "then ";
  const n = run.steps.length;
  if (n === 0) return "nothing here";
  const one = run.steps[0]!;
  if (n === 1) return `${lead}1 step: ${one.from} → ${one.to}`;
  const via = [...new Set(run.steps.map((s) => s.to))].join(", ");
  return `${lead}${n} steps, via ${via}`;
}
