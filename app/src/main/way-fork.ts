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
