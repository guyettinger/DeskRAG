/**
 * The composing provider: it partitions AND names in one call.
 *
 * Those are one act, not two. If a run cannot be named, it was not one — and
 * splitting the jobs leaves the namer justifying a grouping it would not have
 * chosen, which is exactly how a screenshot description ends up labelling a
 * task.
 *
 * Barrel-safe: an interface and a fake. The Ollama adapter in
 * `ollama-summary.ts` is barrel-safe too (plain fetch, no native module).
 */

import type { ChildSummary, ComposeGroup, LevelKind } from "../represent/compose/types.js";

export interface ComposeContext {
  /** WHICH question this call asks — the adapter maps it to a system prompt. */
  kind: LevelKind;
}

export interface SummaryProvider {
  readonly id: string;
  readonly model: string;
  /**
   * Partition `children` (indices 0..n-1) into named contiguous runs.
   *
   * May return anything, including a malformed partition — the caller validates
   * and rejects wholesale. Implementations should THROW rather than return a
   * guess when the daemon is unreachable or the reply is torn; the composer
   * catches and takes the structural path.
   */
  compose(children: readonly ChildSummary[], ctx: ComposeContext): Promise<ComposeGroup[]>;
}

/**
 * A deterministic stand-in: fixed-size runs, named from the first child.
 *
 * Deterministic input -> deterministic output is what lets a test place an
 * exact grouping, the same contract the fake embedder holds.
 */
export class FakeSummaryProvider implements SummaryProvider {
  readonly id = "fake";
  readonly model = "fake-compose";

  constructor(private readonly groupSize = 2) {}

  async compose(
    children: readonly ChildSummary[],
    _ctx: ComposeContext,
  ): Promise<ComposeGroup[]> {
    const out: ComposeGroup[] = [];
    for (let i = 0; i < children.length; i += this.groupSize) {
      out.push({
        start: i,
        end: Math.min(i + this.groupSize, children.length),
        summary: `did: ${children[i]!.text}`,
      });
    }
    return out;
  }
}
