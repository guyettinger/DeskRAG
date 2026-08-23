/**
 * The fork rows, folded into the shape JSX needs.
 *
 * `HabitForkRowDTO[]` is FLAT — spine rows and fork rows interleaved — because
 * that is the order both formatters walk and a flat list cannot disagree with
 * itself about nesting. A list needs the nesting, so it happens here, in a
 * `.ts` module the ROOT suite can reach. Renderer modules that hold a judgement
 * must not be `.tsx`: the root `tsconfig.json` sets no `jsx`.
 *
 * IT COMPOSES NO WORDS. Every phrase is carried on the DTO, written by
 * `app/src/main/way-fork.ts`, so the screen and the rendered file cannot say
 * different things about the same run — the `differBlock`/`Baseline.reason`
 * precedent.
 */

import type { HabitForkDTO, HabitWayDTO } from "@shared/types";

export interface ForkRunView {
  way: number;
  letter: string;
  steps: number[];
  phrase: string;
}

export interface ForkStepView {
  /** One-based, for display. */
  n: number;
  from: string;
  to: string;
  at: { way: number; letter: string; step: number }[];
  /** The gap that followed this step. Empty when nothing forked there. */
  after: ForkRunView[];
}

export interface ForkView {
  /** The gap BEFORE the first spine step. It has no step to sit under. */
  leading: ForkRunView[];
  steps: ForkStepView[];
}

/** One decimal and a unit — the same form `way-fork.ts` prints into the file. */
export const waySecs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function foldFork(fork: HabitForkDTO, ways: readonly HabitWayDTO[]): ForkView {
  const letterOf = (way: number): string => ways[way]?.letter ?? String(way);
  const leading: ForkRunView[] = [];
  const steps: ForkStepView[] = [];

  for (const row of fork.rows) {
    if (row.kind === "spine") {
      steps.push({
        n: steps.length + 1,
        from: row.from,
        to: row.to,
        at: row.at.map((a) => ({ way: a.way, letter: letterOf(a.way), step: a.step })),
        after: [],
      });
      continue;
    }
    const runs: ForkRunView[] = row.runs.map((r) => ({
      way: r.way,
      letter: letterOf(r.way),
      steps: [...r.steps],
      phrase: r.phrase,
    }));
    // `after === -1` is the leading gap. Everything else attaches to the step
    // it followed; the rows arrive in order, so that is always the last one
    // pushed.
    const last = steps[steps.length - 1];
    if (row.after < 0 || last === undefined) leading.push(...runs);
    else last.after.push(...runs);
  }

  return { leading, steps };
}
