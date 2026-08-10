# Compositional Segment Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat, near-duplicate `action`/`task`/`caption` rail lanes with a real hierarchy — actions compose into tasks, tasks into processes, up to one root node whose summary is the session's purpose.

**Architecture:** A new always-on `represent/` stage recursively merges *adjacent* sibling segments into parents until one node covers the recording. A local LLM partitions **and** names each run in one call; a deterministic structural grouper is the always-on fallback and the control it is measured against. Levels are stored as ordinary `segment` rows keyed by `granularity` (`action`, `level:1`, `level:2`, …, `session`), with two new tables for parent→child edges and summary text.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, better-sqlite3 (WAL), LanceDB, Electron + React (app), Ollama for the local LLM.

**Spec:** `docs/superpowers/specs/2026-08-09-compositional-segment-hierarchy-design.md`

## Global Constraints

- **Existing data is discarded.** No migration, no re-index of old recordings, no `task`-compatibility path, no rebuild banner. Delete the data dir when testing: `~/Library/Application Support/deskrag-app/DeskRAG/`.
- **`segment`'s columns are frozen.** There is no migration mechanism — `CREATE TABLE IF NOT EXISTS` runs on every open, so an existing table's shape can never change. Everything new is a **table**. This holds despite the data reset, because the constraint is permanent.
- **`src/segment/` stays a leaf.** It sees only `SegEvent`. The composer lives in `src/represent/`, never in `src/segment/`.
- **Pure cores are `.ts` and root-tested.** The root `tsconfig.json` sets no `jsx`, so a root test that reaches into a `.tsx` — even for a type — breaks `npm run typecheck`.
- **Write order is SQLite first, then Lance.** Never the reverse.
- **`grep` silently skips `src/store/store.ts`** (two deliberate NUL bytes). Use `grep -a` / `rg -a`.
- **The app imports `dist/`, not `src/`.** After changing library code run `npm run build` before launching the app.
- **Gates:** `npm run typecheck` and `npm test` for the library; `npm --prefix app run typecheck` for the app. Both must pass before every commit.
- **Ollama model discovery is `/api/tags` only** (`listModels`), never a hardcoded model name — Ollama's library includes cloud-hosted models and naming one would route activity off the machine.
- **No network calls to third parties.** Every provider is local.

---

## File Structure

**Create:**
- `src/store/types.ts` additions — `SegmentTreeInsert`, `SegmentSummaryInsert`, `SegmentSummaryRow`, `SummarySource`, six `Store` methods.
- `src/represent/compose/types.ts` — `ChildSummary`, `ComposeGroup`, `Block`, `ComposedNode`, `ComposedLevel`, `Partitioner`.
- `src/represent/compose/agglomerate.ts` — pure: `validatePartition`, `splitIntoBlocks`, `coherence`, `structuralRanges`.
- `src/represent/compose/rollup.ts` — pure: `rollupText`.
- `src/represent/compose/levels.ts` — pure: `composeLevels` recursion.
- `src/represent/compose/prompt.ts` — the one prompt, all levels.
- `src/represent/compose/compose-representer.ts` — the stage (I/O).
- `src/embed/summary.ts` — `SummaryProvider` interface + `FakeSummaryProvider`.
- `src/embed/ollama-summary.ts` — `OllamaSummaryProvider`.
- `test/compose.agglomerate.test.ts`, `test/compose.levels.test.ts`, `test/compose.rollup.test.ts`, `test/compose.representer.test.ts`, `test/segment-tree.store.test.ts`, `test/summary.ollama.test.ts`.

**Modify:**
- `src/store/sqlite/schema.ts` — two `CREATE TABLE IF NOT EXISTS`.
- `src/store/store.ts` — the six methods.
- `src/segment/types.ts` — remove the `task` granularity.
- `src/represent/segment-text.ts` — index the summary text.
- `src/index.ts` — barrel exports.
- `app/src/main/deskrag-service.ts` — the Compose stage, retriever wiring, DTO hydration.
- `app/src/main/session-tracks.ts` — level lanes, caption strip.
- `app/src/main/graph-view.ts` — route naming.
- `app/src/shared/types.ts` — `TrackLaneDTO.level`, hit altitude, session purpose.
- `app/src/renderer/src/screens/TrackRail.tsx`, `TrackLane.tsx` — lane indent.
- `app/src/renderer/src/screens/LibraryScreen.tsx` — session purpose.
- `app/src/renderer/src/styles.css` — lane title indent.

---

# Phase 1 — Store

### Task 1: `segment_tree` and `segment_summary`

**Files:**
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/store.ts`
- Test: `test/segment-tree.store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type SummarySource = "llm" | "template";
  export interface SegmentTreeInsert { sessionId: string; parentId: string; childId: string }
  export interface SegmentSummaryInsert { segmentId: string; text: string; source: SummarySource }
  export interface SegmentSummaryRow { segmentId: string; text: string; source: SummarySource }
  // on Store:
  putSegmentTree(rows: SegmentTreeInsert[]): Promise<void>;
  getSegmentChildren(parentId: string): string[];
  getDescendantLeaves(segmentId: string): string[];
  putSegmentSummaries(rows: SegmentSummaryInsert[]): Promise<void>;
  getSegmentSummary(segmentId: string): SegmentSummaryRow | undefined;
  getSegmentSummariesBySession(sessionId: string): SegmentSummaryRow[];
  ```

- [ ] **Step 1: Write the failing test**

Create `test/segment-tree.store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeStore, id } from "./helpers.js";

describe("segment tree + summary", () => {
  it("round-trips edges and resolves descendant leaves", async () => {
    const { store, sessionId } = await makeStore();
    const a = id(), b = id(), task = id(), root = id();
    await store.putSegments([
      { id: a, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
      { id: b, sessionId, granularity: "action", tMonoStart: 1000, tMonoEnd: 2000 },
      { id: task, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 2000 },
      { id: root, sessionId, granularity: "session", tMonoStart: 0, tMonoEnd: 2000 },
    ]);
    await store.putSegmentTree([
      { sessionId, parentId: task, childId: a },
      { sessionId, parentId: task, childId: b },
      { sessionId, parentId: root, childId: task },
    ]);

    expect(store.getSegmentChildren(task).sort()).toEqual([a, b].sort());
    expect(store.getDescendantLeaves(root).sort()).toEqual([a, b].sort());
    // A leaf resolves to itself, so Tier-2 scoping needs no special case.
    expect(store.getDescendantLeaves(a)).toEqual([a]);
  });

  it("stores summaries with their source and reads them per session", async () => {
    const { store, sessionId } = await makeStore();
    const task = id();
    await store.putSegments([
      { id: task, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 2000 },
    ]);
    await store.putSegmentSummaries([
      { segmentId: task, text: "renamed the capture clock", source: "llm" },
    ]);
    expect(store.getSegmentSummary(task)).toEqual({
      segmentId: task,
      text: "renamed the capture clock",
      source: "llm",
    });
    expect(store.getSegmentSummariesBySession(sessionId)).toHaveLength(1);
    expect(store.getSegmentSummary(id())).toBeUndefined();
  });

  it("cascades both tables when the session is deleted", async () => {
    const { store, sessionId } = await makeStore();
    const child = id(), parent = id();
    await store.putSegments([
      { id: child, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
      { id: parent, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 1000 },
    ]);
    await store.putSegmentTree([{ sessionId, parentId: parent, childId: child }]);
    await store.putSegmentSummaries([{ segmentId: parent, text: "x", source: "template" }]);

    await store.deleteSession(sessionId);

    expect(store.getSegmentChildren(parent)).toEqual([]);
    expect(store.getSegmentSummary(parent)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/segment-tree.store.test.ts`
Expected: FAIL — `store.putSegmentTree is not a function`.

- [ ] **Step 3: Add the schema**

Append to `src/store/sqlite/schema.ts`, after the `segment_app_caption` block:

```sql
-- Parent -> child edges for the compositional segment hierarchy.
--
-- A SEPARATE TABLE, not a `parent_id` column: `segment`'s shape is frozen
-- (CREATE TABLE IF NOT EXISTS with no migration step), the same reason
-- segment_app_caption and transcript_clip are tables.
--
-- Edges are STORED rather than derived from spans. A parent's span is exactly
-- its children's union, so interval containment looks sufficient — until a
-- parent with a single child has an identical span and containment cannot say
-- which is which.
CREATE TABLE IF NOT EXISTS segment_tree (
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  parent_id  TEXT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  child_id   TEXT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_segtree_child   ON segment_tree(child_id);
CREATE INDEX IF NOT EXISTS idx_segtree_session ON segment_tree(session_id);

-- The composed summary of a level >= 1 segment.
--
-- NOT the `digest` column: digest means templated text over a segment's OWN
-- events and owns a Tier-1 vector namespace. A summary is composed from
-- CHILDREN. Putting both in one column would put two kinds of text in one
-- similarity space — what namespaceFor exists to prevent.
--
-- `source` is disclosure, not bookkeeping: it records which parents got a real
-- sentence and which got a structural rollup, so a hierarchy composed without
-- a model cannot masquerade as one composed with it.
CREATE TABLE IF NOT EXISTS segment_summary (
  segment_id TEXT PRIMARY KEY REFERENCES segment(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL          -- 'llm' | 'template'
);
```

- [ ] **Step 4: Add the types**

In `src/store/types.ts`, beside `TranscriptClipInsert`:

```ts
/** Which producer wrote a composed summary. See `segment_summary.source`. */
export type SummarySource = "llm" | "template";

export interface SegmentTreeInsert {
  sessionId: string;
  parentId: string;
  childId: string;
}

export interface SegmentSummaryInsert {
  segmentId: string;
  text: string;
  source: SummarySource;
}

export interface SegmentSummaryRow {
  segmentId: string;
  text: string;
  source: SummarySource;
}
```

And on the `Store` interface, after `getTranscriptClipsBySession`:

```ts
  /**
   * Parent -> child edges for composed levels. SQLite only — no vector space is
   * keyed on an edge, so there is no SQLite->Lance ordering hazard, the same as
   * the trace_* tables.
   */
  putSegmentTree(rows: SegmentTreeInsert[]): Promise<void>;
  /** The direct children of a composed segment, or [] for a leaf. */
  getSegmentChildren(parentId: string): string[];
  /**
   * Every LEAF beneath a segment — the segment itself when it has no children.
   *
   * This is what Tier-2 scoping uses. Frame vectors denormalize `segment_ids`
   * at represent time, long before composing runs, so a composed level can
   * never appear in that field: scoping a parent hit directly would match zero
   * frames and return empty with no error at all.
   */
  getDescendantLeaves(segmentId: string): string[];
  /** Persist composed summaries. Replaces any existing row for the same id. */
  putSegmentSummaries(rows: SegmentSummaryInsert[]): Promise<void>;
  /** One composed summary, or undefined for a leaf / an unknown id. */
  getSegmentSummary(segmentId: string): SegmentSummaryRow | undefined;
  /** Every composed summary in a session. */
  getSegmentSummariesBySession(sessionId: string): SegmentSummaryRow[];
```

- [ ] **Step 5: Implement in `store.ts`**

Add to `DualStore` (remember `grep -a` when searching this file):

```ts
  async putSegmentTree(rows: SegmentTreeInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const stmt = this.db.prepare(
        `INSERT INTO segment_tree (session_id, parent_id, child_id)
         VALUES (?, ?, ?) ON CONFLICT(parent_id, child_id) DO NOTHING`,
      );
      this.db.transaction(() => {
        for (const r of rows) stmt.run(r.sessionId, r.parentId, r.childId);
      })();
    });
  }

  getSegmentChildren(parentId: string): string[] {
    return this.db
      .prepare(`SELECT child_id FROM segment_tree WHERE parent_id = ?`)
      .all(parentId)
      .map((r) => (r as { child_id: string }).child_id);
  }

  getDescendantLeaves(segmentId: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE d(id) AS (
           SELECT ?
           UNION
           SELECT st.child_id FROM segment_tree st JOIN d ON st.parent_id = d.id
         )
         SELECT d.id AS id FROM d
         WHERE NOT EXISTS (SELECT 1 FROM segment_tree c WHERE c.parent_id = d.id)`,
      )
      .all(segmentId);
    return rows.map((r) => (r as { id: string }).id);
  }

  async putSegmentSummaries(rows: SegmentSummaryInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const stmt = this.db.prepare(
        `INSERT INTO segment_summary (segment_id, text, source) VALUES (?, ?, ?)
         ON CONFLICT(segment_id) DO UPDATE SET text = excluded.text, source = excluded.source`,
      );
      this.db.transaction(() => {
        for (const r of rows) stmt.run(r.segmentId, r.text, r.source);
      })();
    });
  }

  getSegmentSummary(segmentId: string): SegmentSummaryRow | undefined {
    const row = this.db
      .prepare(`SELECT segment_id, text, source FROM segment_summary WHERE segment_id = ?`)
      .get(segmentId) as { segment_id: string; text: string; source: string } | undefined;
    if (row === undefined) return undefined;
    return { segmentId: row.segment_id, text: row.text, source: row.source as SummarySource };
  }

  getSegmentSummariesBySession(sessionId: string): SegmentSummaryRow[] {
    const rows = this.db
      .prepare(
        `SELECT ss.segment_id AS segment_id, ss.text AS text, ss.source AS source
         FROM segment_summary ss
         JOIN segment s ON s.id = ss.segment_id
         WHERE s.session_id = ?`,
      )
      .all(sessionId) as { segment_id: string; text: string; source: string }[];
    return rows.map((r) => ({
      segmentId: r.segment_id,
      text: r.text,
      source: r.source as SummarySource,
    }));
  }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/segment-tree.store.test.ts`
Expected: PASS (3 tests).

Then: `npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/store/sqlite/schema.ts src/store/types.ts src/store/store.ts test/segment-tree.store.test.ts
git commit -m "feat(store): segment_tree and segment_summary tables"
```

---

# Phase 2 — The pure composer core

### Task 2: Partition validation, blocks, and structural grouping

**Files:**
- Create: `src/represent/compose/types.ts`
- Create: `src/represent/compose/agglomerate.ts`
- Test: `test/compose.agglomerate.test.ts`

**Interfaces:**
- Consumes: `SummarySource` from `src/store/types.ts`.
- Produces:
  ```ts
  export interface ChildSummary {
    index: number; text: string; app: string | null; url: string | null;
    startSec: number; endSec: number; barrier: boolean;
  }
  export interface Block { start: number; end: number }          // [start, end)
  export interface ComposeGroup { start: number; end: number; summary: string }
  export function validatePartition(groups: readonly ComposeGroup[], start: number, end: number): boolean;
  export function splitIntoBlocks(children: readonly ChildSummary[], cap: number): Block[];
  export function coherence(a: ChildSummary, b: ChildSummary): number;
  export function structuralRanges(children: readonly ChildSummary[], block: Block): Block[];
  export const DEFAULT_BATCH_CAP = 24;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/compose.agglomerate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_CAP,
  coherence,
  splitIntoBlocks,
  structuralRanges,
  validatePartition,
} from "../src/represent/compose/agglomerate.js";
import type { ChildSummary } from "../src/represent/compose/types.js";

function kid(i: number, over: Partial<ChildSummary> = {}): ChildSummary {
  return {
    index: i,
    text: `child ${i}`,
    app: "Calculator",
    url: null,
    startSec: i,
    endSec: i + 0.5,
    barrier: false,
    ...over,
  };
}

describe("validatePartition", () => {
  const g = (start: number, end: number) => ({ start, end, summary: "s" });

  it("accepts a contiguous covering partition", () => {
    expect(validatePartition([g(0, 2), g(2, 5)], 0, 5)).toBe(true);
  });

  it("rejects a gap, an overlap, an empty group and a short cover", () => {
    expect(validatePartition([g(0, 2), g(3, 5)], 0, 5)).toBe(false); // gap
    expect(validatePartition([g(0, 3), g(2, 5)], 0, 5)).toBe(false); // overlap
    expect(validatePartition([g(0, 0), g(0, 5)], 0, 5)).toBe(false); // empty
    expect(validatePartition([g(0, 4)], 0, 5)).toBe(false);          // short
    expect(validatePartition([], 0, 5)).toBe(false);                 // none
  });

  it("rejects a group that runs past the block", () => {
    expect(validatePartition([g(0, 9)], 0, 5)).toBe(false);
  });

  it("rejects non-integer indices — the model must name children that exist", () => {
    expect(validatePartition([{ start: 0, end: 2.5, summary: "s" }], 0, 5)).toBe(false);
  });
});

describe("splitIntoBlocks", () => {
  it("splits at a barrier — a bookmark is inviolable", () => {
    const kids = [kid(0), kid(1), kid(2, { barrier: true }), kid(3)];
    expect(splitIntoBlocks(kids, DEFAULT_BATCH_CAP)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("returns one block when nothing bars and nothing exceeds the cap", () => {
    expect(splitIntoBlocks([kid(0), kid(1), kid(2)], DEFAULT_BATCH_CAP)).toEqual([
      { start: 0, end: 3 },
    ]);
  });

  it("splits an over-cap block at its largest gap", () => {
    // Five children, cap 2. The biggest gap is before index 3.
    const kids = [
      kid(0, { startSec: 0, endSec: 1 }),
      kid(1, { startSec: 1, endSec: 2 }),
      kid(2, { startSec: 2, endSec: 3 }),
      kid(3, { startSec: 40, endSec: 41 }),
      kid(4, { startSec: 41, endSec: 42 }),
    ];
    const blocks = splitIntoBlocks(kids, 2);
    expect(blocks.every((b) => b.end - b.start <= 2)).toBe(true);
    // The 37s gap must be a block edge.
    expect(blocks.some((b) => b.start === 3)).toBe(true);
  });

  it("is translation invariant — a uniform time shift changes nothing", () => {
    const base = [kid(0), kid(1, { app: "Chrome" }), kid(2), kid(3)];
    const shifted = base.map((c) => ({
      ...c,
      startSec: c.startSec + 987.654,
      endSec: c.endSec + 987.654,
    }));
    expect(splitIntoBlocks(shifted, 2)).toEqual(splitIntoBlocks(base, 2));
  });
});

describe("structuralRanges", () => {
  it("at least halves the block, so recursion always terminates", () => {
    const kids = Array.from({ length: 9 }, (_, i) => kid(i));
    const out = structuralRanges(kids, { start: 0, end: 9 });
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out[0]!.start).toBe(0);
    expect(out[out.length - 1]!.end).toBe(9);
  });

  it("produces a contiguous covering partition of the block", () => {
    const kids = Array.from({ length: 7 }, (_, i) => kid(i));
    const out = structuralRanges(kids, { start: 2, end: 7 });
    let cursor = 2;
    for (const r of out) {
      expect(r.start).toBe(cursor);
      cursor = r.end;
    }
    expect(cursor).toBe(7);
  });

  it("never returns an empty list, even for a single child", () => {
    expect(structuralRanges([kid(0)], { start: 0, end: 1 })).toEqual([{ start: 0, end: 1 }]);
  });

  it("prefers merging same-app neighbours over a cross-app seam", () => {
    const kids = [
      kid(0, { app: "Calculator" }),
      kid(1, { app: "Calculator" }),
      kid(2, { app: "Google Chrome" }),
      kid(3, { app: "Google Chrome" }),
    ];
    expect(structuralRanges(kids, { start: 0, end: 4 })).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});

describe("coherence", () => {
  it("scores a same-app small-gap seam above a cross-app long-gap one", () => {
    const near = coherence(kid(0), kid(1));
    const far = coherence(
      kid(0, { app: "Calculator", endSec: 1 }),
      kid(1, { app: "Chrome", startSec: 30 }),
    );
    expect(near).toBeGreaterThan(far);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.agglomerate.test.ts`
Expected: FAIL — cannot resolve `../src/represent/compose/agglomerate.js`.

- [ ] **Step 3: Write `types.ts`**

Create `src/represent/compose/types.ts`:

```ts
/**
 * Types for the compositional segment hierarchy.
 *
 * Everything here is index-space, never time-space: a partitioner chooses cut
 * points among CHILDREN THAT EXIST, so it cannot invent a moment nothing was
 * recorded in. Times ride along on ChildSummary for coherence scoring only.
 */

import type { SummarySource } from "../../store/types.js";

/** One node of the level being composed, as its parent-to-be sees it. */
export interface ChildSummary {
  /** Position in the level's ordered array. */
  index: number;
  /** The text a partitioner reads: a caption/digest at level 0, a summary above. */
  text: string;
  app: string | null;
  url: string | null;
  startSec: number;
  endSec: number;
  /**
   * True when a group may not extend LEFTWARD across this child — an explicit
   * user bookmark. A barrier outranks every similarity score there is.
   */
  barrier: boolean;
}

/** A half-open index range `[start, end)` into a level's children. */
export interface Block {
  start: number;
  end: number;
}

/** A named run a partitioner proposes. Index ranges, never times. */
export interface ComposeGroup {
  start: number;
  end: number;
  summary: string;
}

/** One composed parent: which children it covers, what it is called, who named it. */
export interface ComposedNode {
  range: Block;
  summary: string;
  source: SummarySource;
}

/** One whole level of the tree. `level` is 1-based; level 0 is the input leaves. */
export interface ComposedLevel {
  level: number;
  nodes: ComposedNode[];
}

/**
 * Proposes a partition of one block. Injected, so `levels.ts` stays pure and the
 * suite can drive a model-shaped path with no model.
 *
 * May return anything at all — including a malformed partition. The caller
 * validates and REJECTS; it never repairs. Repairing means guessing intent,
 * the rule `parseInterventionResponse` already sets in `trace/`.
 */
export type Partitioner = (
  children: readonly ChildSummary[],
  block: Block,
  level: number,
) => Promise<ComposeGroup[]>;
```

- [ ] **Step 4: Write `agglomerate.ts`**

Create `src/represent/compose/agglomerate.ts`:

```ts
/**
 * The pure judgment core of the composer: where a level may be cut, and — with
 * no model at all — where it IS cut.
 *
 * No store, no provider, no I/O. Root-testable like `track-buckets.ts` and
 * `graph-view.ts`.
 */

import type { Block, ChildSummary, ComposeGroup } from "./types.js";

/**
 * Children per model call. A calibration target, not a tuned value: it trades
 * context length against how often a real run is forced apart, and the first
 * real recording is what sets it.
 */
export const DEFAULT_BATCH_CAP = 24;

/**
 * Is this a partition of `[start, end)` — contiguous, non-overlapping, covering?
 *
 * A group cannot cross a barrier because barriers are BLOCK edges and a
 * partition is validated per block, so containment falls out of the geometry
 * rather than needing its own check.
 */
export function validatePartition(
  groups: readonly ComposeGroup[],
  start: number,
  end: number,
): boolean {
  if (groups.length === 0) return false;
  let cursor = start;
  for (const g of groups) {
    if (!Number.isInteger(g.start) || !Number.isInteger(g.end)) return false;
    if (g.start !== cursor) return false;
    if (g.end <= g.start) return false;
    if (g.end > end) return false;
    cursor = g.end;
  }
  return cursor === end;
}

/**
 * Cut a level into blocks a partitioner can be asked about one at a time.
 *
 * Barriers cut first and unconditionally. Anything still over the cap is cut at
 * its largest STRUCTURAL discontinuity — the biggest inter-child gap, then an
 * app change, then the lowest index — so the split is deterministic and no
 * cross-batch stitching is ever needed.
 *
 * Gaps are DIFFERENCES, which is what makes this translation invariant: a
 * uniform time shift must not change the layout, the trap `thumbPlacement` and
 * `Path.curve` span-splitting both hit.
 */
export function splitIntoBlocks(children: readonly ChildSummary[], cap: number): Block[] {
  if (children.length === 0) return [];
  const atBarriers: Block[] = [];
  let start = 0;
  for (let i = 1; i < children.length; i++) {
    if (children[i]!.barrier) {
      atBarriers.push({ start, end: i });
      start = i;
    }
  }
  atBarriers.push({ start, end: children.length });

  const out: Block[] = [];
  for (const b of atBarriers) out.push(...splitToCap(children, b, cap));
  return out;
}

function splitToCap(children: readonly ChildSummary[], b: Block, cap: number): Block[] {
  if (b.end - b.start <= Math.max(1, cap)) return [b];
  let bestIdx = b.start + 1;
  let bestGap = -Infinity;
  let bestAppChange = false;
  for (let i = b.start + 1; i < b.end; i++) {
    const prev = children[i - 1]!;
    const cur = children[i]!;
    const gap = cur.startSec - prev.endSec;
    const appChange = prev.app !== null && cur.app !== null && prev.app !== cur.app;
    // Strictly greater keeps the LOWEST index on a tie, which is what makes the
    // choice deterministic under floating-point noise.
    if (gap > bestGap || (gap === bestGap && appChange && !bestAppChange)) {
      bestGap = gap;
      bestIdx = i;
      bestAppChange = appChange;
    }
  }
  return [
    ...splitToCap(children, { start: b.start, end: bestIdx }, cap),
    ...splitToCap(children, { start: bestIdx, end: b.end }, cap),
  ];
}

/**
 * How strongly two adjacent children want to be siblings.
 *
 * These signals are CORRELATES of intent, not intent. A task is often
 * goal-directed heterogeneity — open terminal, run build, read error, edit,
 * run again — which this scores badly on purpose-built evidence it cannot see.
 * That is exactly why this is the fallback and the control, not the primary.
 */
export function coherence(a: ChildSummary, b: ChildSummary): number {
  let s = 0;
  if (a.app !== null && a.app === b.app) s += 2;
  if (a.url !== null && a.url === b.url) s += 1;
  const gap = b.startSec - a.endSec;
  if (gap <= 1) s += 1;
  else if (gap >= 3) s -= 1;
  return s;
}

/**
 * The always-on grouping: greedy-merge the best-scoring adjacent pair until the
 * block's node count is AT MOST HALF its child count.
 *
 * Halving is what guarantees the strict shrinkage `composeLevels` depends on to
 * terminate.
 */
export function structuralRanges(children: readonly ChildSummary[], block: Block): Block[] {
  const n = block.end - block.start;
  if (n <= 0) return [];
  if (n === 1) return [{ start: block.start, end: block.end }];

  let groups: Block[] = [];
  for (let i = block.start; i < block.end; i++) groups.push({ start: i, end: i + 1 });

  const target = Math.max(1, Math.ceil(n / 2));
  while (groups.length > target) {
    let bestI = 0;
    let bestS = -Infinity;
    for (let i = 0; i + 1 < groups.length; i++) {
      const s = coherence(children[groups[i]!.end - 1]!, children[groups[i + 1]!.start]!);
      // Strictly greater: ties keep the leftmost seam, so the result cannot
      // flip on floating-point noise.
      if (s > bestS) {
        bestS = s;
        bestI = i;
      }
    }
    groups = [
      ...groups.slice(0, bestI),
      { start: groups[bestI]!.start, end: groups[bestI + 1]!.end },
      ...groups.slice(bestI + 2),
    ];
  }
  return groups;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/compose.agglomerate.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/represent/compose/types.ts src/represent/compose/agglomerate.ts test/compose.agglomerate.test.ts
git commit -m "feat(represent): pure partition validation and structural grouping"
```

---

### Task 3: The templated rollup

**Files:**
- Create: `src/represent/compose/rollup.ts`
- Test: `test/compose.rollup.test.ts`

**Interfaces:**
- Consumes: `ChildSummary`, `Block` from `src/represent/compose/types.ts`.
- Produces: `export function rollupText(children: readonly ChildSummary[], range: Block, level: number): string`

- [ ] **Step 1: Write the failing test**

Create `test/compose.rollup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rollupText } from "../src/represent/compose/rollup.js";
import type { ChildSummary } from "../src/represent/compose/types.js";

function kid(i: number, over: Partial<ChildSummary> = {}): ChildSummary {
  return {
    index: i, text: `child ${i}`, app: "Calculator", url: null,
    startSec: i, endSec: i + 1, barrier: false, ...over,
  };
}

describe("rollupText", () => {
  it("names the apps spanned, the child count and the duration", () => {
    const kids = [kid(0), kid(1, { app: "Google Chrome" }), kid(2, { app: "Google Chrome" })];
    expect(rollupText(kids, { start: 0, end: 3 }, 1)).toBe(
      "Calculator, Google Chrome · 3 actions · 3.0s",
    );
  });

  it("says 'groups' above level 1, because its children are not actions", () => {
    expect(rollupText([kid(0), kid(1)], { start: 0, end: 2 }, 2)).toBe(
      "Calculator · 2 groups · 2.0s",
    );
  });

  it("uses the singular for one child", () => {
    expect(rollupText([kid(0)], { start: 0, end: 1 }, 1)).toBe("Calculator · 1 action · 1.0s");
  });

  it("dedupes apps in first-seen order and omits an unknown app", () => {
    const kids = [kid(0, { app: null }), kid(1, { app: "Chrome" }), kid(2, { app: "Chrome" })];
    expect(rollupText(kids, { start: 0, end: 3 }, 1)).toBe("Chrome · 3 actions · 3.0s");
  });

  it("still names the span when NO app is known", () => {
    const kids = [kid(0, { app: null }), kid(1, { app: null })];
    expect(rollupText(kids, { start: 0, end: 2 }, 1)).toBe("2 actions · 2.0s");
  });

  it("is translation invariant", () => {
    const base = [kid(0), kid(1)];
    const shifted = base.map((c) => ({ ...c, startSec: c.startSec + 500, endSec: c.endSec + 500 }));
    expect(rollupText(shifted, { start: 0, end: 2 }, 1)).toBe(
      rollupText(base, { start: 0, end: 2 }, 1),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.rollup.test.ts`
Expected: FAIL — cannot resolve `rollup.js`.

- [ ] **Step 3: Write `rollup.ts`**

Create `src/represent/compose/rollup.ts`:

```ts
/**
 * The parent's text when no model wrote one — a structural rollup, in
 * `buildDigest`'s own vocabulary.
 *
 * It is a CONCATENATION DISCIPLINE over text that already exists, not new
 * extraction: at level 1 the children are actions whose digests already carry
 * window title, URL, typed text and the label of what was clicked.
 *
 * Deterministic and pure, so it doubles as the control the LLM path is
 * measured against.
 */

import type { Block, ChildSummary } from "./types.js";

export function rollupText(
  children: readonly ChildSummary[],
  range: Block,
  level: number,
): string {
  const slice = children.slice(range.start, range.end);
  if (slice.length === 0) return "";

  const apps: string[] = [];
  for (const c of slice) {
    if (c.app !== null && c.app.length > 0 && !apps.includes(c.app)) apps.push(c.app);
  }

  const noun = level === 1 ? "action" : "group";
  const count = `${slice.length} ${noun}${slice.length === 1 ? "" : "s"}`;

  // A DIFFERENCE, so a uniform time shift cannot change the text.
  const dur = `${(slice[slice.length - 1]!.endSec - slice[0]!.startSec).toFixed(1)}s`;

  return [apps.length > 0 ? apps.join(", ") : null, count, dur]
    .filter((p): p is string => p !== null)
    .join(" · ");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose.rollup.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/represent/compose/rollup.ts test/compose.rollup.test.ts
git commit -m "feat(represent): templated rollup text for composed levels"
```

---

### Task 4: The recursion

**Files:**
- Create: `src/represent/compose/levels.ts`
- Test: `test/compose.levels.test.ts`

**Interfaces:**
- Consumes: `validatePartition`, `splitIntoBlocks`, `structuralRanges`, `DEFAULT_BATCH_CAP` (Task 2); `rollupText` (Task 3); `ChildSummary`, `Block`, `ComposedLevel`, `ComposedNode`, `Partitioner` (Task 2).
- Produces:
  ```ts
  export const MAX_DEPTH = 8;
  export interface ComposeLevelsOptions {
    partitioner?: Partitioner;
    batchCap?: number;
    maxDepth?: number;
  }
  export function composeLevels(
    leaves: readonly ChildSummary[],
    opts?: ComposeLevelsOptions,
  ): Promise<ComposedLevel[]>;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/compose.levels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeLevels } from "../src/represent/compose/levels.js";
import type { ChildSummary, ComposeGroup } from "../src/represent/compose/types.js";

function leaves(n: number, over: (i: number) => Partial<ChildSummary> = () => ({})) {
  return Array.from({ length: n }, (_, i): ChildSummary => ({
    index: i, text: `action ${i}`, app: "Calculator", url: null,
    startSec: i, endSec: i + 1, barrier: false, ...over(i),
  }));
}

/** Pairs children up and names each pair — a well-behaved model. */
const pairwise = async (
  _children: readonly ChildSummary[],
  block: { start: number; end: number },
): Promise<ComposeGroup[]> => {
  const out: ComposeGroup[] = [];
  for (let i = block.start; i < block.end; i += 2) {
    const end = Math.min(i + 2, block.end);
    out.push({ start: i, end, summary: `run ${i}` });
  }
  return out;
};

describe("composeLevels", () => {
  it("recurses to exactly one root", async () => {
    const out = await composeLevels(leaves(8), { partitioner: pairwise });
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
  });

  it("numbers levels from 1 upward", async () => {
    const out = await composeLevels(leaves(8), { partitioner: pairwise });
    expect(out.map((l) => l.level)).toEqual(out.map((_, i) => i + 1));
  });

  it("every level is strictly smaller than the one below", async () => {
    const out = await composeLevels(leaves(16), { partitioner: pairwise });
    let prev = 16;
    for (const l of out) {
      expect(l.nodes.length).toBeLessThan(prev);
      prev = l.nodes.length;
    }
  });

  it("each level covers its children exactly, contiguously", async () => {
    const out = await composeLevels(leaves(9), { partitioner: pairwise });
    let below = 9;
    for (const l of out) {
      let cursor = 0;
      for (const n of l.nodes) {
        expect(n.range.start).toBe(cursor);
        cursor = n.range.end;
      }
      expect(cursor).toBe(below);
      below = l.nodes.length;
    }
  });

  it("marks LLM-named nodes 'llm' and rolled-up ones 'template'", async () => {
    const withModel = await composeLevels(leaves(4), { partitioner: pairwise });
    expect(withModel[0]!.nodes.every((n) => n.source === "llm")).toBe(true);
    expect(withModel[0]!.nodes[0]!.summary).toBe("run 0");

    const noModel = await composeLevels(leaves(4));
    expect(noModel[0]!.nodes.every((n) => n.source === "template")).toBe(true);
    expect(noModel[0]!.nodes[0]!.summary).toContain("Calculator");
  });

  it("REJECTS a malformed partition wholesale rather than repairing it", async () => {
    const broken = async (): Promise<ComposeGroup[]> => [
      { start: 0, end: 2, summary: "a" },
      { start: 3, end: 4, summary: "b" }, // gap at 2
    ];
    const out = await composeLevels(leaves(4), { partitioner: broken });
    // Nothing the model said survives — not the ranges, not the names.
    expect(out[0]!.nodes.every((n) => n.source === "template")).toBe(true);
    expect(out[0]!.nodes.map((n) => n.summary)).not.toContain("a");
  });

  it("falls back when a partition does not shrink its block", async () => {
    const identity = async (
      _c: readonly ChildSummary[],
      block: { start: number; end: number },
    ): Promise<ComposeGroup[]> =>
      Array.from({ length: block.end - block.start }, (_, k) => ({
        start: block.start + k,
        end: block.start + k + 1,
        summary: "no",
      }));
    const out = await composeLevels(leaves(4), { partitioner: identity });
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
    expect(out[0]!.nodes.every((n) => n.source === "template")).toBe(true);
  });

  it("falls back when the partitioner throws — composing never fails the run", async () => {
    const boom = async (): Promise<ComposeGroup[]> => {
      throw new Error("ollama is not running");
    };
    const out = await composeLevels(leaves(4), { partitioner: boom });
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
    expect(out[0]!.nodes.every((n) => n.source === "template")).toBe(true);
  });

  it("never merges across a barrier", async () => {
    const kids = leaves(4, (i) => (i === 2 ? { barrier: true } : {}));
    const out = await composeLevels(kids, { partitioner: pairwise });
    // No level-1 node may span the seam at index 2.
    expect(out[0]!.nodes.some((n) => n.range.start < 2 && n.range.end > 2)).toBe(false);
  });

  it("returns one root node for a single leaf", async () => {
    const out = await composeLevels(leaves(1), { partitioner: pairwise });
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
    expect(out[out.length - 1]!.nodes[0]!.range).toEqual({ start: 0, end: 1 });
  });

  it("returns [] for no leaves", async () => {
    expect(await composeLevels([])).toEqual([]);
  });

  it("is translation invariant", async () => {
    const base = leaves(8);
    const shifted = base.map((c) => ({
      ...c, startSec: c.startSec + 4242.4242, endSec: c.endSec + 4242.4242,
    }));
    expect(await composeLevels(shifted)).toEqual(await composeLevels(base));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.levels.test.ts`
Expected: FAIL — cannot resolve `levels.js`.

- [ ] **Step 3: Write `levels.ts`**

Create `src/represent/compose/levels.ts`:

```ts
/**
 * The recursion: merge adjacent siblings into parents, level by level, until one
 * node covers the recording.
 *
 * Bottom-up rather than top-down, for two reasons. It SCALES — a 3h session has
 * thousands of actions and they do not fit one context, which is exactly where
 * hierarchy matters most. And every node stays GROUNDED: a parent's span is
 * exactly the union of its children's, so no node can claim time nothing was
 * recorded in.
 *
 * Pure. The model arrives as an injected `Partitioner`, so this file has no
 * provider, no store and no I/O.
 */

import {
  DEFAULT_BATCH_CAP,
  splitIntoBlocks,
  structuralRanges,
  validatePartition,
} from "./agglomerate.js";
import { rollupText } from "./rollup.js";
import type {
  Block,
  ChildSummary,
  ComposedLevel,
  ComposedNode,
  Partitioner,
} from "./types.js";

/** A stop the geometry should already guarantee. Cheap insurance against a loop. */
export const MAX_DEPTH = 8;

export interface ComposeLevelsOptions {
  partitioner?: Partitioner;
  batchCap?: number;
  maxDepth?: number;
}

export async function composeLevels(
  leaves: readonly ChildSummary[],
  opts: ComposeLevelsOptions = {},
): Promise<ComposedLevel[]> {
  if (leaves.length === 0) return [];
  const cap = opts.batchCap ?? DEFAULT_BATCH_CAP;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;

  const out: ComposedLevel[] = [];
  let children: ChildSummary[] = leaves.map((c, i) => ({ ...c, index: i }));
  let level = 1;

  while (level <= maxDepth) {
    if (children.length === 1) {
      // The single node below IS the root; nothing to compose.
      if (out.length === 0) {
        out.push({ level, nodes: [rollupNode(children, { start: 0, end: 1 }, level)] });
      }
      break;
    }

    const nodes = await composeOneLevel(children, level, cap, opts.partitioner);
    // Geometry guarantees this, but a level that failed to shrink would loop
    // forever. Wrapping everything into one root terminates and is honest:
    // "this could not be subdivided further".
    const shrunk = nodes.length < children.length ? nodes : [rollupNode(children, { start: 0, end: children.length }, level)];

    out.push({ level, nodes: shrunk });
    if (shrunk.length === 1) break;

    children = shrunk.map((n, i) => liftNode(children, n, i));
    level += 1;
  }

  // A depth cap reached without a root still gets one, so callers can always
  // rely on "the last level holds exactly one node".
  const last = out[out.length - 1];
  if (last !== undefined && last.nodes.length > 1) {
    const lifted = last.nodes.map((n, i) => liftNode(children, n, i));
    out.push({
      level: last.level + 1,
      nodes: [rollupNode(lifted, { start: 0, end: lifted.length }, last.level + 1)],
    });
  }
  return out;
}

async function composeOneLevel(
  children: readonly ChildSummary[],
  level: number,
  cap: number,
  partitioner: Partitioner | undefined,
): Promise<ComposedNode[]> {
  const nodes: ComposedNode[] = [];
  for (const block of splitIntoBlocks(children, cap)) {
    nodes.push(...(await composeBlock(children, block, level, partitioner)));
  }
  return nodes;
}

async function composeBlock(
  children: readonly ChildSummary[],
  block: Block,
  level: number,
  partitioner: Partitioner | undefined,
): Promise<ComposedNode[]> {
  const size = block.end - block.start;
  if (size <= 1) return [rollupNode(children, block, level)];

  if (partitioner !== undefined) {
    let groups;
    try {
      groups = await partitioner(children, block, level);
    } catch {
      // Composing NEVER fails the run: an unreachable daemon, a timeout or a
      // torn response all degrade to the structural path.
      groups = undefined;
    }
    if (
      groups !== undefined &&
      validatePartition(groups, block.start, block.end) &&
      groups.length < size
    ) {
      return groups.map((g) => ({
        range: { start: g.start, end: g.end },
        summary: g.summary.trim().length > 0
          ? g.summary.trim()
          : rollupText(children, { start: g.start, end: g.end }, level),
        source: "llm" as const,
      }));
    }
    // Rejected WHOLESALE — not repaired. Nothing the model said survives, not
    // the ranges and not the names.
  }

  return structuralRanges(children, block).map((r) => rollupNode(children, r, level));
}

function rollupNode(
  children: readonly ChildSummary[],
  range: Block,
  level: number,
): ComposedNode {
  return { range, summary: rollupText(children, range, level), source: "template" };
}

/** Turn a composed parent into a child of the level above it. */
function liftNode(children: readonly ChildSummary[], n: ComposedNode, index: number): ChildSummary {
  const slice = children.slice(n.range.start, n.range.end);
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const app = slice.every((c) => c.app === first.app) ? first.app : null;
  const url = slice.every((c) => c.url === first.url) ? first.url : null;
  return {
    index,
    text: n.summary,
    app,
    url,
    startSec: first.startSec,
    endSec: last.endSec,
    // A parent inherits its FIRST child's barrier, so a bookmark keeps barring
    // all the way up rather than being swallowed at level 1.
    barrier: first.barrier,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose.levels.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/represent/compose/levels.ts test/compose.levels.test.ts
git commit -m "feat(represent): recursive level composition with wholesale rejection"
```

---

# Phase 3 — The provider

### Task 5: `SummaryProvider`, the fake, and the prompt

**Files:**
- Create: `src/embed/summary.ts`
- Create: `src/represent/compose/prompt.ts`
- Test: covered by Task 6's adapter test and Task 7's stage test.

**Interfaces:**
- Consumes: `ChildSummary`, `ComposeGroup`, `Block` from `src/represent/compose/types.ts`.
- Produces:
  ```ts
  export interface SummaryProvider {
    readonly id: string;
    readonly model: string;
    compose(children: readonly ChildSummary[], ctx: ComposeContext): Promise<ComposeGroup[]>;
  }
  export interface ComposeContext { level: number }
  export class FakeSummaryProvider implements SummaryProvider { constructor(groupSize?: number) }
  // prompt.ts
  export const COMPOSE_SYSTEM: string;
  export function composePrompt(children: readonly ChildSummary[], level: number): string;
  export function parseComposeResponse(raw: string, offset: number): ComposeGroup[] | undefined;
  ```

Note: `compose()` receives the **block's** children already sliced, and returns
indices **relative to the block's start** — `offset` in `parseComposeResponse`
is what maps them back. The stage's adapter does that mapping so the model only
ever sees `0..n`.

- [ ] **Step 1: Write `prompt.ts` and its test**

Create `src/represent/compose/prompt.ts`:

```ts
/**
 * The one prompt, for every level.
 *
 * At level 1 the input is action captions; at level 2 it is level-1 goals, and
 * composing goals into bigger goals is the same instruction with the depth
 * passed as context. Recursion needs exactly one prompt.
 *
 * It asks for the GOAL, not the appearance — which is the whole defect being
 * fixed. The VLM caption prompt says "describe what is on screen", and running
 * that over a longer window produces a longer screenshot description, never a
 * higher altitude.
 */

import type { ChildSummary, ComposeGroup } from "./types.js";

export const COMPOSE_SYSTEM =
  "You group a user's recorded desktop activity into the tasks it composes. " +
  "You are given an ordered, numbered list of consecutive steps. Partition it " +
  "into contiguous runs, where each run is ONE thing the user was trying to " +
  "accomplish. Name each run in one short phrase stating the GOAL, not what was " +
  "on screen. Merge freely: fewer, larger runs are better than many small ones. " +
  'Reply with JSON only: {"groups":[{"start":0,"end":3,"summary":"..."}]} where ' +
  "start is inclusive, end is exclusive, the runs are in order, and together " +
  "they cover every step exactly once. No preamble.";

export function composePrompt(children: readonly ChildSummary[], level: number): string {
  const lines = children.map((c, i) => {
    const app = c.app === null ? "" : `[${c.app}] `;
    return `${i}. ${app}${c.text.replace(/\s+/g, " ").trim()}`;
  });
  const what =
    level === 1
      ? "These are individual actions."
      : "These are already-grouped activities; group them into larger ones.";
  return `${what}\nPartition these ${children.length} steps.\n\n${lines.join("\n")}`;
}

/**
 * Parse a model reply into groups, shifting indices back into the level's own
 * index space.
 *
 * Returns `undefined` on anything unparseable. It does NOT validate the
 * partition — `validatePartition` does, and the caller rejects wholesale.
 */
export function parseComposeResponse(raw: string, offset: number): ComposeGroup[] | undefined {
  // Models wrap JSON in prose or a fence often enough that finding the object
  // is worth doing; anything past that is the caller's problem.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return undefined;
  const out: ComposeGroup[] = [];
  for (const g of groups) {
    const o = g as { start?: unknown; end?: unknown; summary?: unknown };
    if (typeof o.start !== "number" || typeof o.end !== "number") return undefined;
    out.push({
      start: o.start + offset,
      end: o.end + offset,
      summary: typeof o.summary === "string" ? o.summary : "",
    });
  }
  return out;
}
```

- [ ] **Step 2: Write `summary.ts`**

Create `src/embed/summary.ts`:

```ts
/**
 * The composing provider: it partitions AND names in one call.
 *
 * Those are one act, not two. If a run cannot be named, it was not one — and
 * splitting the jobs leaves the namer justifying a grouping it would not have
 * chosen, which is exactly how a screenshot description ends up labelling a
 * task.
 *
 * Barrel-safe: an interface and a fake. The Ollama adapter lives in
 * `ollama-summary.ts` and is also barrel-safe (plain fetch, no native module).
 */

import type { ChildSummary, ComposeGroup } from "../represent/compose/types.js";

export interface ComposeContext {
  /** 1 for the first composed level, 2 above it, and so on. */
  level: number;
}

export interface SummaryProvider {
  readonly id: string;
  readonly model: string;
  /**
   * Partition `children` (indices 0..n-1) into named contiguous runs.
   *
   * May return anything, including a malformed partition — the caller
   * validates and rejects wholesale. Implementations should THROW rather than
   * return a guess when the daemon is unreachable; the composer catches.
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

  async compose(children: readonly ChildSummary[]): Promise<ComposeGroup[]> {
    const out: ComposeGroup[] = [];
    for (let i = 0; i < children.length; i += this.groupSize) {
      const end = Math.min(i + this.groupSize, children.length);
      out.push({ start: i, end, summary: `did: ${children[i]!.text}` });
    }
    return out;
  }
}
```

- [ ] **Step 3: Write the prompt test**

Create `test/compose.prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composePrompt, parseComposeResponse } from "../src/represent/compose/prompt.js";
import type { ChildSummary } from "../src/represent/compose/types.js";

const kid = (i: number, text: string, app: string | null = "Calculator"): ChildSummary => ({
  index: i, text, app, url: null, startSec: i, endSec: i + 1, barrier: false,
});

describe("composePrompt", () => {
  it("numbers steps from zero and names the app", () => {
    const p = composePrompt([kid(0, "clicked 7"), kid(1, "clicked +")], 1);
    expect(p).toContain("0. [Calculator] clicked 7");
    expect(p).toContain("1. [Calculator] clicked +");
    expect(p).toContain("These are individual actions.");
  });

  it("changes the framing above level 1", () => {
    expect(composePrompt([kid(0, "a")], 2)).toContain("already-grouped");
  });

  it("collapses whitespace so a multi-line caption stays one step", () => {
    expect(composePrompt([kid(0, "a\n\n  b")], 1)).toContain("0. [Calculator] a b");
  });
});

describe("parseComposeResponse", () => {
  it("parses groups and shifts them by the block offset", () => {
    const raw = '{"groups":[{"start":0,"end":2,"summary":"added numbers"}]}';
    expect(parseComposeResponse(raw, 10)).toEqual([
      { start: 10, end: 12, summary: "added numbers" },
    ]);
  });

  it("finds the object inside prose or a code fence", () => {
    const raw = 'Sure!\n```json\n{"groups":[{"start":0,"end":1,"summary":"x"}]}\n```';
    expect(parseComposeResponse(raw, 0)).toEqual([{ start: 0, end: 1, summary: "x" }]);
  });

  it("returns undefined for unparseable or wrongly-typed replies", () => {
    expect(parseComposeResponse("no json here", 0)).toBeUndefined();
    expect(parseComposeResponse("{ not json", 0)).toBeUndefined();
    expect(parseComposeResponse('{"groups":"nope"}', 0)).toBeUndefined();
    expect(parseComposeResponse('{"groups":[{"start":"a","end":1}]}', 0)).toBeUndefined();
  });

  it("defaults a missing summary to empty, letting the caller roll one up", () => {
    expect(parseComposeResponse('{"groups":[{"start":0,"end":1}]}', 0)).toEqual([
      { start: 0, end: 1, summary: "" },
    ]);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose.prompt.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/embed/summary.ts src/represent/compose/prompt.ts test/compose.prompt.test.ts
git commit -m "feat(embed): SummaryProvider interface, fake, and the compose prompt"
```

---

### Task 6: The Ollama adapter

**Files:**
- Create: `src/embed/ollama-summary.ts`
- Test: `test/summary.ollama.test.ts`

**Interfaces:**
- Consumes: `SummaryProvider`, `ComposeContext` (Task 5); `COMPOSE_SYSTEM`, `composePrompt`, `parseComposeResponse` (Task 5); `resolveOllamaHost`, `postJson`, `listModels` from `src/embed/ollama-client.ts`.
- Produces:
  ```ts
  export interface OllamaSummaryOptions {
    model: string; host?: string; fetchImpl?: typeof globalThis.fetch;
  }
  export class OllamaSummaryProvider implements SummaryProvider {
    constructor(opts: OllamaSummaryOptions);
  }
  export function listSummaryModels(host?: string): Promise<string[]>;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/summary.ollama.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OllamaSummaryProvider } from "../src/embed/ollama-summary.js";
import type { ChildSummary } from "../src/represent/compose/types.js";

const kids: ChildSummary[] = [
  { index: 0, text: "clicked 7", app: "Calculator", url: null, startSec: 0, endSec: 1, barrier: false },
  { index: 1, text: "clicked +", app: "Calculator", url: null, startSec: 1, endSec: 2, barrier: false },
];

function fakeFetch(body: unknown, ok = true): typeof globalThis.fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof globalThis.fetch;
}

describe("OllamaSummaryProvider", () => {
  it("parses a well-formed reply into groups", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({
        message: { content: '{"groups":[{"start":0,"end":2,"summary":"added numbers"}]}' },
      }),
    });
    expect(await p.compose(kids, { level: 1 })).toEqual([
      { start: 0, end: 2, summary: "added numbers" },
    ]);
  });

  it("THROWS on an unparseable reply — the composer decides what that means", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({ message: { content: "I cannot help with that." } }),
    });
    await expect(p.compose(kids, { level: 1 })).rejects.toThrow(/unparseable/i);
  });

  it("throws on a non-2xx, rather than returning a guess", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({ error: "model not found" }, false),
    });
    await expect(p.compose(kids, { level: 1 })).rejects.toThrow();
  });

  it("reports its namespace parts", () => {
    const p = new OllamaSummaryProvider({ model: "qwen3:8b" });
    expect(p.id).toBe("ollama");
    expect(p.model).toBe("qwen3:8b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/summary.ollama.test.ts`
Expected: FAIL — cannot resolve `ollama-summary.js`.

- [ ] **Step 3: Write the adapter**

Create `src/embed/ollama-summary.ts`:

```ts
/**
 * Composing over a local Ollama chat model.
 *
 * Barrel-safe: plain `fetch`, no native module, no subprocess.
 *
 * Failure policy: THROWS. A composed level is recoverable — the composer
 * catches and takes the structural path — but this adapter must not decide
 * that, and must never return a guessed partition, which would be
 * indistinguishable from a real one downstream.
 */

import {
  COMPOSE_SYSTEM,
  composePrompt,
  parseComposeResponse,
} from "../represent/compose/prompt.js";
import type { ChildSummary, ComposeGroup } from "../represent/compose/types.js";
import { listModels, postJson, resolveOllamaHost } from "./ollama-client.js";
import type { ComposeContext, SummaryProvider } from "./summary.js";

export interface OllamaSummaryOptions {
  model: string;
  host?: string;
  fetchImpl?: typeof globalThis.fetch;
}

interface ChatResponse {
  message?: { content?: string };
}

export class OllamaSummaryProvider implements SummaryProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly host: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaSummaryOptions) {
    this.model = opts.model;
    this.host = resolveOllamaHost(opts.host);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async compose(children: readonly ChildSummary[], ctx: ComposeContext): Promise<ComposeGroup[]> {
    const res = await postJson<ChatResponse>(
      this.host,
      "/api/chat",
      {
        model: this.model,
        stream: false,
        // `format: json` is a request, not a guarantee — parseComposeResponse
        // still digs the object out of whatever comes back.
        format: "json",
        messages: [
          { role: "system", content: COMPOSE_SYSTEM },
          { role: "user", content: composePrompt(children, ctx.level) },
        ],
      },
      this.fetchImpl,
    );
    const content = res.message?.content ?? "";
    // Indices are block-relative here: the composer slices before calling, so
    // the model only ever sees 0..n-1 and the caller shifts them back.
    const groups = parseComposeResponse(content, 0);
    if (groups === undefined) {
      throw new Error(`Ollama compose returned an unparseable partition: ${content.slice(0, 200)}`);
    }
    return groups;
  }
}

/** Local chat-capable models, for the Settings picker. Never a hardcoded list. */
export async function listSummaryModels(host?: string): Promise<string[]> {
  return listModels(resolveOllamaHost(host), { capability: "completion" });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/summary.ollama.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the barrel**

In `src/index.ts`, beside the other `embed/` exports:

```ts
export { FakeSummaryProvider } from "./embed/summary.js";
export type { SummaryProvider, ComposeContext } from "./embed/summary.js";
export { OllamaSummaryProvider, listSummaryModels } from "./embed/ollama-summary.js";
export type { OllamaSummaryOptions } from "./embed/ollama-summary.js";
```

Both are barrel-safe: `summary.ts` is types plus a fake, `ollama-summary.ts` uses plain `fetch`. Neither loads a native module.

- [ ] **Step 6: Run the gates and commit**

Run: `npm run typecheck && npm test`
Expected: both clean.

```bash
git add src/embed/ollama-summary.ts src/index.ts test/summary.ollama.test.ts
git commit -m "feat(embed): OllamaSummaryProvider over the local chat API"
```

---

# Phase 4 — The stage

### Task 7: `ComposeRepresenter`

**Files:**
- Create: `src/represent/compose/compose-representer.ts`
- Test: `test/compose.representer.test.ts`

**Interfaces:**
- Consumes: `composeLevels` (Task 4); `SummaryProvider` (Task 5); `Store`, `SegmentRow`, `SegmentInsert`, `SegmentTreeInsert`, `SegmentSummaryInsert` (Task 1).
- Produces:
  ```ts
  export interface ComposeRepresenterOptions {
    summarizer?: SummaryProvider;
    mintId?: () => string;
    batchCap?: number;
  }
  export interface ComposeResult {
    levels: number;          // composed levels, excluding level 0
    nodes: number;           // composed segments written
    llmNodes: number;        // of those, named by a model
    rootSummary: string | null;
  }
  export class ComposeRepresenter {
    constructor(store: Store, opts?: ComposeRepresenterOptions);
    represent(sessionId: string): Promise<ComposeResult>;
  }
  export const LEVEL_PREFIX = "level:";
  export const ROOT_GRANULARITY = "session";
  export const LEAF_GRANULARITY = "action";
  ```

- [ ] **Step 1: Write the failing test**

Create `test/compose.representer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeSummaryProvider } from "../src/embed/summary.js";
import { ComposeRepresenter } from "../src/represent/compose/compose-representer.js";
import { id, makeStore } from "./helpers.js";

async function seedActions(store: Awaited<ReturnType<typeof makeStore>>["store"], sessionId: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sid = id();
    ids.push(sid);
    await store.putSegments([
      {
        id: sid, sessionId, granularity: "action",
        tMonoStart: i * 1000, tMonoEnd: (i + 1) * 1000,
        boundaryReason: "scene_change", digest: `action ${i}`,
      },
    ]);
  }
  return ids;
}

describe("ComposeRepresenter", () => {
  it("writes composed levels, edges and summaries up to one root", async () => {
    const { store, sessionId } = await makeStore();
    const actions = await seedActions(store, sessionId, 8);

    const r = await new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
    }).represent(sessionId);

    expect(r.nodes).toBeGreaterThan(0);
    expect(r.rootSummary).not.toBeNull();

    const segs = store.getSegmentsBySession(sessionId);
    const roots = segs.filter((s) => s.granularity === "session");
    expect(roots).toHaveLength(1);
    // The root spans the whole recording, because a parent IS its children's union.
    expect(roots[0]!.tMonoStart).toBe(0);
    expect(roots[0]!.tMonoEnd).toBe(8000);
    // And it resolves back down to every action.
    expect(store.getDescendantLeaves(roots[0]!.id).sort()).toEqual([...actions].sort());
  });

  it("names level granularities level:1, level:2, … below the root", async () => {
    const { store, sessionId } = await makeStore();
    await seedActions(store, sessionId, 8);
    await new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) })
      .represent(sessionId);

    const names = new Set(store.getSegmentsBySession(sessionId).map((s) => s.granularity));
    expect(names.has("action")).toBe(true);
    expect(names.has("level:1")).toBe(true);
    expect(names.has("session")).toBe(true);
    expect(names.has("task")).toBe(false);
  });

  it("composes with NO summarizer — the default install still gets a tree", async () => {
    const { store, sessionId } = await makeStore();
    await seedActions(store, sessionId, 6);

    const r = await new ComposeRepresenter(store).represent(sessionId);

    expect(r.nodes).toBeGreaterThan(0);
    expect(r.llmNodes).toBe(0);
    const summaries = store.getSegmentSummariesBySession(sessionId);
    expect(summaries.length).toBe(r.nodes);
    expect(summaries.every((s) => s.source === "template")).toBe(true);
  });

  it("writes a summary for every composed node and none for a leaf", async () => {
    const { store, sessionId } = await makeStore();
    const actions = await seedActions(store, sessionId, 4);
    await new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) })
      .represent(sessionId);

    for (const a of actions) expect(store.getSegmentSummary(a)).toBeUndefined();
    const composed = store
      .getSegmentsBySession(sessionId)
      .filter((s) => s.granularity !== "action");
    for (const c of composed) expect(store.getSegmentSummary(c.id)).toBeDefined();
  });

  it("is idempotent — re-running replaces rather than duplicating", async () => {
    const { store, sessionId } = await makeStore();
    await seedActions(store, sessionId, 6);
    const rep = new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) });
    await rep.represent(sessionId);
    const first = store.getSegmentsBySession(sessionId).length;
    await rep.represent(sessionId);
    expect(store.getSegmentsBySession(sessionId)).toHaveLength(first);
    expect(store.getSegmentsBySession(sessionId).filter((s) => s.granularity === "session"))
      .toHaveLength(1);
  });

  it("links a parent's frames as the union of its children's", async () => {
    const { store, sessionId } = await makeStore();
    const actions = await seedActions(store, sessionId, 2);
    const frame = id();
    await store.putFrames([
      { id: frame, sessionId, tMono: 500, width: 100, height: 100, phash: 0n, blobId: null },
    ]);
    await store.associateFrameSegments(frame, [actions[0]!]);

    await new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) })
      .represent(sessionId);

    const root = store.getSegmentsBySession(sessionId).find((s) => s.granularity === "session")!;
    expect(store.getFramesBySegment(root.id).map((f) => f.id)).toContain(frame);
  });

  it("returns an empty result for a session with no actions", async () => {
    const { store, sessionId } = await makeStore();
    const r = await new ComposeRepresenter(store).represent(sessionId);
    expect(r).toEqual({ levels: 0, nodes: 0, llmNodes: 0, rootSummary: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.representer.test.ts`
Expected: FAIL — cannot resolve `compose-representer.js`.

- [ ] **Step 3: Write the stage**

Create `src/represent/compose/compose-representer.ts`:

```ts
/**
 * The composing stage: read a session's level-0 segments, build the tree, write
 * it back.
 *
 * Runs AFTER Digest, Caption and Transcript — it reads their text — and BEFORE
 * the `segment_fts` stage, so composed summaries reach the lexical lane. It is
 * ALWAYS ON: the structural path needs no provider.
 *
 * It cannot fail the run. A provider error, a timeout, an unparseable reply or
 * no daemon at all each degrade that block to the structural grouping, which is
 * `composeLevels`' own contract; nothing here rethrows.
 */

import { ulid } from "ulid";
import type { SummaryProvider } from "../../embed/summary.js";
import type {
  SegmentInsert,
  SegmentSummaryInsert,
  SegmentTreeInsert,
  Store,
} from "../../store/types.js";
import { composeLevels } from "./levels.js";
import type { ChildSummary, ComposeGroup, Partitioner } from "./types.js";

export const LEAF_GRANULARITY = "action";
export const LEVEL_PREFIX = "level:";
export const ROOT_GRANULARITY = "session";

export interface ComposeRepresenterOptions {
  summarizer?: SummaryProvider;
  mintId?: () => string;
  batchCap?: number;
}

export interface ComposeResult {
  levels: number;
  nodes: number;
  llmNodes: number;
  rootSummary: string | null;
}

export class ComposeRepresenter {
  private readonly summarizer: SummaryProvider | undefined;
  private readonly mintId: () => string;
  private readonly batchCap: number | undefined;

  constructor(
    private readonly store: Store,
    opts: ComposeRepresenterOptions = {},
  ) {
    this.summarizer = opts.summarizer;
    this.mintId = opts.mintId ?? (() => ulid());
    this.batchCap = opts.batchCap;
  }

  async represent(sessionId: string): Promise<ComposeResult> {
    const all = this.store.getSegmentsBySession(sessionId);
    const leaves = all
      .filter((s) => s.granularity === LEAF_GRANULARITY)
      .sort((a, b) => a.tMonoStart - b.tMonoStart);
    if (leaves.length === 0) {
      return { levels: 0, nodes: 0, llmNodes: 0, rootSummary: null };
    }

    // Re-running must REPLACE, never accumulate: a second root would make
    // "the session's purpose" ambiguous, and no reconcile pass could tell which
    // was stale.
    const stale = all.filter((s) => s.granularity !== LEAF_GRANULARITY).map((s) => s.id);
    if (stale.length > 0) await this.store.deleteSegments(stale);

    const origin = leaves[0]!.tMonoStart;
    const children: ChildSummary[] = leaves.map((s, i) => ({
      index: i,
      // Caption first for the same reason `keyframeLabel` prefers it: the VLM
      // describes the pixels, the digest is a template over events.
      text: s.caption ?? s.digest ?? s.boundaryReason ?? "segment",
      app: appOf(s.digest),
      url: null,
      startSec: (s.tMonoStart - origin) / 1000,
      endSec: (s.tMonoEnd - origin) / 1000,
      barrier: s.boundaryReason === "bookmark",
    }));

    const composed = await composeLevels(children, {
      ...(this.summarizer !== undefined ? { partitioner: this.partitioner() } : {}),
      ...(this.batchCap !== undefined ? { batchCap: this.batchCap } : {}),
    });

    // Write bottom-up so a parent's span and frames come from rows that exist.
    let below = leaves.map((s) => ({ id: s.id, tMonoStart: s.tMonoStart, tMonoEnd: s.tMonoEnd }));
    const segments: SegmentInsert[] = [];
    const edges: SegmentTreeInsert[] = [];
    const summaries: SegmentSummaryInsert[] = [];
    let llmNodes = 0;
    let rootSummary: string | null = null;

    for (const level of composed) {
      const isRoot = level === composed[composed.length - 1];
      const next: typeof below = [];
      for (const node of level.nodes) {
        const kids = below.slice(node.range.start, node.range.end);
        const nodeId = this.mintId();
        const tMonoStart = kids[0]!.tMonoStart;
        const tMonoEnd = kids[kids.length - 1]!.tMonoEnd;
        segments.push({
          id: nodeId,
          sessionId,
          granularity: isRoot ? ROOT_GRANULARITY : `${LEVEL_PREFIX}${level.level}`,
          tMonoStart,
          tMonoEnd,
          boundaryReason: "window",
        });
        for (const k of kids) edges.push({ sessionId, parentId: nodeId, childId: k.id });
        summaries.push({ segmentId: nodeId, text: node.summary, source: node.source });
        if (node.source === "llm") llmNodes += 1;
        if (isRoot) rootSummary = node.summary;
        next.push({ id: nodeId, tMonoStart, tMonoEnd });
      }
      below = next;
    }

    // SQLite first, then the edges that point at those rows.
    await this.store.putSegments(segments);
    await this.store.putSegmentTree(edges);
    await this.store.putSegmentSummaries(summaries);
    await this.linkFrames(segments.map((s) => s.id));

    return {
      levels: composed.length,
      nodes: segments.length,
      llmNodes,
      rootSummary,
    };
  }

  /**
   * Adapts the provider to `composeLevels`' block-at-a-time contract: slice the
   * block, let the model see 0..n-1, shift the answer back.
   */
  private partitioner(): Partitioner {
    const summarizer = this.summarizer!;
    return async (children, block, level): Promise<ComposeGroup[]> => {
      const slice = children.slice(block.start, block.end).map((c, i) => ({ ...c, index: i }));
      const groups = await summarizer.compose(slice, { level });
      return groups.map((g) => ({
        start: g.start + block.start,
        end: g.end + block.start,
        summary: g.summary,
      }));
    };
  }

  /**
   * A parent's frames are exactly the union of its children's.
   *
   * Derived from the tree rather than by re-applying `segmentIdsForFrame`, so
   * the window rule keeps its single implementation — the drift hazard that
   * `ax-dump`/`ax-exec` already paid for.
   */
  private async linkFrames(nodeIds: readonly string[]): Promise<void> {
    for (const nodeId of nodeIds) {
      const seen = new Set<string>();
      for (const leaf of this.store.getDescendantLeaves(nodeId)) {
        for (const f of this.store.getFramesBySegment(leaf)) seen.add(f.id);
      }
      for (const frameId of seen) {
        const existing = this.store.getSegmentsForFrame(frameId);
        if (!existing.includes(nodeId)) {
          await this.store.associateFrameSegments(frameId, [...existing, nodeId]);
        }
      }
    }
  }
}

/**
 * The app a digest names, or null.
 *
 * `buildDigest` puts the focused window's app first, as `App — Title`. Reading
 * it back is a parse of our own template, not a heuristic over arbitrary text —
 * if the template changes, this returns null and coherence degrades to gaps
 * alone, which is the safe direction.
 */
function appOf(digest: string | null): string | null {
  if (digest === null) return null;
  const m = /^([^—\n·]{1,60}?)\s+—\s/.exec(digest.trim());
  return m === null ? null : m[1]!.trim();
}
```

- [ ] **Step 4: Add the two Store methods this needs**

`deleteSegments` and `getSegmentsForFrame` do not exist yet. Add to the `Store` interface in `src/store/types.ts`:

```ts
  /**
   * Delete segments by id — Lance vectors first, then the SQLite rows, the same
   * order `deleteSession` uses. Needed because composing may run twice and a
   * second root would make "the session's purpose" ambiguous.
   */
  deleteSegments(ids: readonly string[]): Promise<void>;
  /** The segments a frame is associated with (the `frame_segment` row set). */
  getSegmentsForFrame(frameId: string): string[];
```

And implement in `src/store/store.ts`:

```ts
  async deleteSegments(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.mutex.run(async () => {
      // Lance first, then SQLite: the reverse would leave vectors whose id has
      // no row, which is the orphan case reconcile cannot attribute.
      for (const space of this.listVectorSpaces()) {
        await this.lance.deleteByIds(space.namespace, [...ids]);
      }
      const stmt = this.db.prepare(`DELETE FROM segment WHERE id = ?`);
      this.db.transaction(() => {
        for (const id of ids) stmt.run(id);
      })();
    });
  }

  getSegmentsForFrame(frameId: string): string[] {
    return this.db
      .prepare(`SELECT segment_id FROM frame_segment WHERE frame_id = ?`)
      .all(frameId)
      .map((r) => (r as { segment_id: string }).segment_id);
  }
```

If `this.lance.deleteByIds` is named differently in this codebase, use whatever
`deleteSession` calls to remove Lance rows by id set — read that method first
(`grep -a "deleteSession" -A 30 src/store/store.ts`) and mirror it exactly.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/compose.representer.test.ts`
Expected: PASS (7 tests).

Then: `npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/represent/compose/compose-representer.ts src/store/types.ts src/store/store.ts test/compose.representer.test.ts
git commit -m "feat(represent): the composing stage, always-on with a structural fallback"
```

---

### Task 8: Retire `task`, index summaries, wire the stage

**Files:**
- Modify: `src/segment/types.ts:69-87` (`BASE_GRANULARITIES`), `:98-107` (`resolveGranularities`)
- Modify: `src/represent/segment-text.ts:34`
- Modify: `src/index.ts`
- Modify: `app/src/main/deskrag-service.ts` (stage list, near line 694)
- Test: `test/segment.test.ts` (existing — update), `test/compose.fts.test.ts` (new)

**Interfaces:**
- Consumes: `ComposeRepresenter` (Task 7), `OllamaSummaryProvider` (Task 6).
- Produces: nothing new; wiring only.

- [ ] **Step 1: Write the failing FTS test**

Create `test/compose.fts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { indexSegmentText } from "../src/represent/segment-text.js";
import { id, makeStore } from "./helpers.js";

describe("segment_fts includes composed summaries", () => {
  it("indexes a composed level's summary text", async () => {
    const { store, sessionId } = await makeStore();
    const task = id();
    await store.putSegments([
      { id: task, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 2000 },
    ]);
    await store.putSegmentSummaries([
      { segmentId: task, text: "renamed the capture clock", source: "llm" },
    ]);

    const r = indexSegmentText(store, sessionId);

    // The summary is the ONLY text this segment has, so it must be what makes
    // it indexable — on a default install this lane is the only route from a
    // query to an exact term.
    expect(r.indexedCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.fts.test.ts`
Expected: FAIL — `indexedCount` is 0, because the summary is not read.

- [ ] **Step 3: Index the summary**

In `src/represent/segment-text.ts`, extend the `parts` array inside `indexSegmentText`:

```ts
    const parts = [
      seg.digest,
      seg.caption,
      store.getAppCaption(seg.id),
      seg.transcript,
      // Composed levels carry no digest/caption of their own — the summary IS
      // their text, and without it a task is unreachable by an exact term.
      store.getSegmentSummary(seg.id)?.text,
    ].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
```

Update the module docstring's "four views" to five, naming `summary`.

- [ ] **Step 4: Retire the `task` granularity**

In `src/segment/types.ts`, reduce `BASE_GRANULARITIES` to `action` only:

```ts
/**
 * Level 0 of the hierarchy, and the only granularity segmentation produces.
 *
 * `task` used to live here as a second, LONGER window over the same event
 * timeline — which is why the rail's ACTION and TASK lanes read as one signal
 * drawn twice. Height in the hierarchy is now COMPOSED from what actions mean
 * together (`represent/compose/`), not cut from a bigger box.
 */
export const BASE_GRANULARITIES: GranularityConfig[] = [
  {
    name: "action",
    targetMs: 10_000,
    strideMs: 10_000,
    boundaryAware: true,
    // Inactivity indicates INTENT, not a change of state, so it does not cut
    // here — it is surfaced as its own rail lane instead.
    cutReasons: ["scene_change", "focus_change", "bookmark"],
    subdivide: false,
  },
];
```

And simplify `resolveGranularities`, whose whole body was the `task` special case:

```ts
/**
 * Kept as the seam where a granularity could scale with session length. Nothing
 * scales today: `action`'s 10s cap only ever subdivides a span between real
 * boundaries, so it stays meaningful at any session length, and every level
 * above it is composed rather than windowed.
 */
export function resolveGranularities(
  _endTMono: number,
  base: GranularityConfig[] = BASE_GRANULARITIES,
): GranularityConfig[] {
  return base;
}
```

- [ ] **Step 5: Update the existing segmentation test**

Run `npx vitest run test/segment.test.ts` and fix every assertion that expects a
`task` granularity: those cases now assert `action` only. Do **not** delete the
cases — change their expectations, so the file still proves what segmentation
produces.

- [ ] **Step 6: Export the stage from the barrel**

In `src/index.ts`:

```ts
export {
  ComposeRepresenter,
  LEAF_GRANULARITY,
  LEVEL_PREFIX,
  ROOT_GRANULARITY,
} from "./represent/compose/compose-representer.js";
export type {
  ComposeRepresenterOptions,
  ComposeResult,
} from "./represent/compose/compose-representer.js";
export type { ChildSummary, ComposedLevel, ComposedNode } from "./represent/compose/types.js";
```

- [ ] **Step 7: Wire the stage into the app**

In `app/src/main/deskrag-service.ts`, add the import:

```ts
import { ComposeRepresenter, OllamaSummaryProvider } from "deskrag";
```

Then push the stage **immediately before** the `"Search index"` stage (around
line 699), so it runs after every text-writing stage and before the lexical index:

```ts
    // Compose the hierarchy: actions -> tasks -> processes -> one root whose
    // summary is the session's purpose. AFTER Digest/Captions/Transcribing,
    // because it reads their text; BEFORE "Search index", so summaries reach
    // the lexical lane. Always on — the structural path needs no provider.
    stages.push({
      name: "Composing",
      run: async () => {
        const summarizer =
          p.summaryProvider === "ollama"
            ? new OllamaSummaryProvider({ model: p.ollamaSummaryModel, host: p.ollamaHost })
            : undefined;
        const r = await new ComposeRepresenter(this.store, {
          ...(summarizer !== undefined ? { summarizer } : {}),
        }).represent(sessionId);
        if (r.nodes === 0) return;
        // Say WHICH path produced the tree. A structurally-composed hierarchy
        // must not read as a summarized one.
        const how = r.llmNodes === 0 ? "structural" : `${r.llmNodes} summarized`;
        return { stage: `Composing — ${r.levels} levels, ${r.nodes} nodes (${how})` };
      },
    });
```

Add the two settings this reads. In the app's settings type and `PROVIDER_VALUES`
(`app/src/main/settings.ts`), add `summaryProvider: "none" | "ollama"` defaulting
to `"none"` and `ollamaSummaryModel: string` defaulting to `""`. Follow exactly
what `captionProvider` / `ollamaCaptionModel` do in that file — including the
reset-to-default rule for a persisted value outside `PROVIDER_VALUES`.

- [ ] **Step 8: Run every gate**

```bash
npm run typecheck && npm test && npm run build && npm --prefix app run typecheck
```
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/segment/types.ts src/represent/segment-text.ts src/index.ts \
        app/src/main/deskrag-service.ts app/src/main/settings.ts \
        test/compose.fts.test.ts test/segment.test.ts
git commit -m "feat: retire the task granularity and run the composing stage"
```

---

# Phase 5 — The rail

### Task 9: Level lanes in the projection

**Files:**
- Modify: `app/src/shared/types.ts` (`TrackLaneDTO`)
- Modify: `app/src/main/session-tracks.ts` (`segmentLanes`, `captionLane`, `LaneInput`, `bandedLanes`)
- Test: `test/session-tracks.test.ts` (extend)

**Interfaces:**
- Consumes: `SegmentSummaryRow` (Task 1); `LEVEL_PREFIX`, `ROOT_GRANULARITY`, `LEAF_GRANULARITY` (Task 7).
- Produces:
  ```ts
  // on TrackLaneDTO:
  level: number | null;
  // in session-tracks.ts:
  export function levelTitle(granularity: string): string | null;
  export function levelIndex(granularity: string): number | null;
  export function levelLanes(input: LaneInput): LaneBody[];
  // LaneInput gains:
  summaries: Map<string, { text: string; source: "llm" | "template" }>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/session-tracks.test.ts`:

```ts
import { levelIndex, levelTitle } from "../app/src/main/session-tracks.js";

describe("hierarchy lanes", () => {
  it("titles levels from the bottom, with the root always SESSION", () => {
    expect(levelTitle("action")).toBe("action");
    expect(levelTitle("level:1")).toBe("task");
    expect(levelTitle("level:2")).toBe("process");
    expect(levelTitle("level:3")).toBe("level 3");
    expect(levelTitle("session")).toBe("session");
    expect(levelTitle("nonsense")).toBeNull();
  });

  it("orders levels coarse -> fine, so the rail reads as an outline", () => {
    // Higher index sorts FIRST: session above process above task above action.
    expect(levelIndex("action")).toBe(0);
    expect(levelIndex("level:1")).toBe(1);
    expect(levelIndex("level:2")).toBe(2);
    expect(levelIndex("session")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
```

Then, in the same file, a projection test (adapt the existing fixture builder in
that file — read how the other `describe` blocks construct `LaneInput` and reuse
it verbatim rather than inventing a second shape):

```ts
describe("levelLanes", () => {
  it("labels a composed lane with its summary and a leaf lane with nothing", () => {
    const lanes = levelLanes(inputWith({
      segments: [
        seg({ id: "a", granularity: "action", tMonoStart: 0, tMonoEnd: 1000 }),
        seg({ id: "t", granularity: "level:1", tMonoStart: 0, tMonoEnd: 1000 }),
      ],
      summaries: new Map([["t", { text: "added two numbers", source: "llm" as const }]]),
    }));

    const task = lanes.find((l) => l.title === "task")!;
    const action = lanes.find((l) => l.title === "action")!;
    expect(task.showLabels).toBe(true);
    expect(task.spans![0]!.label).toBe("added two numbers");
    expect(task.level).toBe(1);
    // An action's label is a whole VLM caption — exactly what labelFits withholds.
    expect(action.showLabels).toBe(false);
    expect(action.level).toBe(0);
  });

  it("orders coarse to fine", () => {
    const lanes = levelLanes(inputWith({
      segments: [
        seg({ id: "a", granularity: "action", tMonoStart: 0, tMonoEnd: 1000 }),
        seg({ id: "t", granularity: "level:1", tMonoStart: 0, tMonoEnd: 1000 }),
        seg({ id: "r", granularity: "session", tMonoStart: 0, tMonoEnd: 1000 }),
      ],
      summaries: new Map([
        ["t", { text: "t", source: "template" as const }],
        ["r", { text: "r", source: "template" as const }],
      ]),
    }));
    expect(lanes.map((l) => l.title)).toEqual(["session", "task", "action"]);
  });

  it("warns when a whole level was composed with no model", () => {
    const lanes = levelLanes(inputWith({
      segments: [
        seg({ id: "a", granularity: "action", tMonoStart: 0, tMonoEnd: 1000 }),
        seg({ id: "t", granularity: "level:1", tMonoStart: 0, tMonoEnd: 1000 }),
      ],
      summaries: new Map([["t", { text: "Calculator · 1 action · 1.0s", source: "template" as const }]]),
    }));
    const task = lanes.find((l) => l.title === "task")!;
    expect(task.warning).toMatch(/no text model/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: FAIL — `levelTitle is not exported`.

- [ ] **Step 3: Add `level` to the DTO**

In `app/src/shared/types.ts`, on `TrackLaneDTO`, after `showLabels`:

```ts
  /**
   * Depth in the compositional hierarchy — 0 for `action`, 1 for `task`, and so
   * on up to the root. `null` for every lane that is not part of the tree.
   *
   * Required rather than optional, the same rationale as `showLabels` and
   * `TrackGroup`: the compiler then finds every builder and every test fixture,
   * so a new lane cannot silently claim a depth it does not have.
   */
  level: number | null;
```

Then run `npm --prefix app run typecheck` and add `level: null` to **every**
existing lane builder in `app/src/main/session-tracks.ts` the compiler names.

- [ ] **Step 4: Replace `segmentLanes` with `levelLanes`**

In `app/src/main/session-tracks.ts`, delete `segmentLanes` and add:

```ts
const LEVEL_NAMES = ["action", "task", "process"];

/** Display name for a granularity, or null when it is not a hierarchy level. */
export function levelTitle(granularity: string): string | null {
  if (granularity === LEAF_GRANULARITY) return LEVEL_NAMES[0]!;
  if (granularity === ROOT_GRANULARITY) return "session";
  if (!granularity.startsWith(LEVEL_PREFIX)) return null;
  const n = Number(granularity.slice(LEVEL_PREFIX.length));
  if (!Number.isInteger(n) || n < 1) return null;
  // Your vocabulary at the depths recordings actually reach; honest numbering
  // past it, where nobody has a word anyway.
  return LEVEL_NAMES[n] ?? `level ${n}`;
}

/** Sort key: bigger is coarser, so the rail can order top-down. */
export function levelIndex(granularity: string): number | null {
  if (granularity === LEAF_GRANULARITY) return 0;
  // The root is always the coarsest, whatever depth it landed at.
  if (granularity === ROOT_GRANULARITY) return Number.MAX_SAFE_INTEGER;
  if (!granularity.startsWith(LEVEL_PREFIX)) return null;
  const n = Number(granularity.slice(LEVEL_PREFIX.length));
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * One lane per level, COARSE FIRST.
 *
 * Top-down is what makes the nesting legible: each bar visibly contains the
 * bars beneath it, so the rail reads as an outline rather than as three
 * near-identical strips.
 */
export function levelLanes(input: LaneInput): LaneBody[] {
  const byGranularity = new Map<string, SegmentRow[]>();
  for (const s of input.segments) {
    if (levelIndex(s.granularity) === null) continue;
    const list = byGranularity.get(s.granularity) ?? [];
    list.push(s);
    byGranularity.set(s.granularity, list);
  }

  return [...byGranularity.entries()]
    .sort(([a], [b]) => levelIndex(b)! - levelIndex(a)!)
    .map(([granularity, rows]) => {
      const level = levelIndex(granularity)!;
      const composed = granularity !== LEAF_GRANULARITY;
      const sorted = rows.slice().sort((a, b) => a.tMonoStart - b.tMonoStart);
      const sources = composed
        ? sorted.map((s) => input.summaries.get(s.id)?.source ?? "template")
        : [];
      return {
        id: `seg-${granularity}`,
        title: levelTitle(granularity) ?? granularity,
        shape: "span" as const,
        // A composed summary is a short goal phrase, so labelFits usually
        // passes and the bar can be READ. An action's label is a whole VLM
        // caption sentence — the case labelFits exists to withhold.
        showLabels: composed,
        level: granularity === ROOT_GRANULARITY ? sorted.length && level : level,
        spans: sorted.map((s) => ({
          startSec: secOf(s.tMonoStart, input.originMono),
          endSec: secOf(s.tMonoEnd, input.originMono),
          label: composed
            ? (input.summaries.get(s.id)?.text ?? "summary missing")
            : segmentLabel(s),
          tone: BOUNDARY_TONE[s.boundaryReason ?? "window"] ?? "neutral",
        })),
        emptyReason: null,
        // `warning`, not `emptyReason`: the lane is full and healthy-looking,
        // and what is compromised is that no model named any of it.
        warning:
          composed && sources.length > 0 && sources.every((s) => s === "template")
            ? "composed structurally — no text model was configured, so these are rollups rather than summaries"
            : null,
      };
    });
}
```

Fix the `level` expression — it must be the plain depth. Replace that line with:

```ts
        level,
```

and compute the root's depth as its position: give `ROOT_GRANULARITY` the depth
`maxLevelIndex + 1` where `maxLevelIndex` is the highest `level:N` present, so
indenting is monotone. Add above the `.map`:

```ts
  const deepest = Math.max(
    0,
    ...[...byGranularity.keys()]
      .map((g) => levelIndex(g)!)
      .filter((n) => n !== Number.MAX_SAFE_INTEGER),
  );
```

and inside the map: `const level = granularity === ROOT_GRANULARITY ? deepest + 1 : levelIndex(granularity)!;`

- [ ] **Step 5: Add `summaries` to `LaneInput` and populate it**

In `app/src/main/session-tracks.ts`, add to the `LaneInput` interface:

```ts
  /** Composed summaries by segment id. Empty for a session composed of leaves only. */
  summaries: Map<string, { text: string; source: SummarySource }>;
```

In `bandedLanes`, replace the `segmentLanes(input)` entry with the level lanes
spread into the `segments` band, keeping `captionLane` after them. In
`DeskRagService.sessionTracks` (`app/src/main/deskrag-service.ts`), build the map:

```ts
      summaries: new Map(
        this.store
          .getSegmentSummariesBySession(sessionId)
          .map((s) => [s.segmentId, { text: s.text, source: s.source }]),
      ),
```

Every other `LaneInput` construction site (tests included) needs `summaries: new Map()`.

- [ ] **Step 6: Make the caption lane a presence strip**

`captionLane` already sets `showLabels: false`, so only its docstring changes.
Replace the `captionLane` docstring with:

```ts
/**
 * Which actions got a VLM caption — a PRESENCE strip, deliberately textless.
 *
 * It used to carry the caption text, which made it a redundant copy of the
 * ACTION lane: `presenceLane` filters the finest granularity, so its spans and
 * its labels were the same spans and the same labels. What survives is the one
 * thing only this lane can say — whether captioning reached a given action.
 */
```

- [ ] **Step 7: Run the tests and gates**

```bash
npx vitest run test/session-tracks.test.ts
npm run typecheck && npm test && npm --prefix app run typecheck
```
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add app/src/shared/types.ts app/src/main/session-tracks.ts app/src/main/deskrag-service.ts test/session-tracks.test.ts
git commit -m "feat(app): project the segment hierarchy as coarse-to-fine rail lanes"
```

---

### Task 10: Indent lane titles by depth

**Files:**
- Modify: `app/src/renderer/src/screens/TrackLane.tsx`
- Modify: `app/src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `TrackLaneDTO.level` (Task 9).
- Produces: nothing.

- [ ] **Step 1: Set the indent from the DTO**

In `TrackLane.tsx`, on the element that renders the lane title, add the custom
property. Depth counts DOWN from the root, so the coarsest sits flush left:

```tsx
        style={
          lane.level === null
            ? undefined
            : ({ "--lane-depth": String(maxLevel - lane.level) } as React.CSSProperties)
        }
```

`maxLevel` is the highest `level` among the session's lanes — pass it down from
`TrackRail.tsx`, which already maps over every lane:

```tsx
const maxLevel = Math.max(0, ...lanes.map((l) => l.level ?? 0));
```

- [ ] **Step 2: Add the CSS**

In `styles.css`, beside the other `.tracks__` rules:

```css
/* Hierarchy depth reads as indentation: the root sits flush left and each
   level steps in, so the lane titles are an outline of the recording. Uses the
   spacing scale — a raw px literal here is the regression this scale exists to
   prevent. */
.tracks__lane-title {
  padding-left: calc(var(--lane-depth, 0) * var(--s2));
}
```

- [ ] **Step 3: Verify in the running app**

Follow the `run-app` skill to launch DeskRAGApp, open a recording in the Library,
and confirm: lanes read `SESSION · … · PROCESS · TASK · ACTION` top to bottom,
titles step in with depth, and no lane title wraps or clips.

If no recording has levels yet, record a short session first (Recorder window
**closed to the tray** — its millisecond timer defeats mpdecimate entirely and
any keyframe-derived measurement taken with it visible is meaningless).

- [ ] **Step 4: Commit**

```bash
git add app/src/renderer/src/screens/TrackLane.tsx app/src/renderer/src/screens/TrackRail.tsx app/src/renderer/src/styles.css
git commit -m "feat(app): indent rail lane titles by hierarchy depth"
```

---

## ⏸ VALIDATION CHECKPOINT — before Phase 6

Two spec-required measurements. **Stop and report both before continuing.** Both
need a real recording; neither is visible to the suite.

- [ ] **Validation 1 — do LLM cuts beat structural cuts?**

Record one real multi-app session (e.g. terminal → editor → browser, doing one
recognizable task), then index it twice: once with `summaryProvider: "none"` and
once with an Ollama model. Compare the level-1 cuts against what the recording
actually did, the way `mpdecimate`'s `lo` was calibrated against a contact
sheet rather than a target count.

Report: cut counts, where each path put its boundaries, and whether the LLM
found the cross-app task that the structural path is predicted to shred. **A
result either way is a finding** — if structural wins, say so; the spec records
the anti-correlation claim as a hypothesis, not a conclusion.

- [ ] **Validation 2 — do level summaries fit?**

In the running app, hover and read the TASK and PROCESS bars at a normal window
size. `labelFits` withholds a label that cannot be drawn untruncated, so measure
how often a summary is actually painted. If most are withheld, the prompt needs
to ask for shorter phrases — that is a prompt change in
`src/represent/compose/prompt.ts`, not a change to `labelFits`.

Report the hit rate and a sample of the summaries produced.

---

# Phase 6 — Retrieval

### Task 11: The `summary` view and its Tier-1 lane

**Files:**
- Modify: `src/represent/compose/compose-representer.ts`
- Modify: `app/src/main/deskrag-service.ts` (`buildRetriever`)
- Test: `test/compose.retrieval.test.ts`

**Interfaces:**
- Consumes: `ComposeRepresenter` (Task 7); `namespaceFor`, `EmbeddingProvider` from `src/embed/types.ts`; `TextViewSearcher` from `src/retrieve/`.
- Produces:
  ```ts
  // ComposeRepresenterOptions gains:
  summaryEmbedder?: EmbeddingProvider;
  // ComposeRepresenter gains:
  readonly namespace: string | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/compose.retrieval.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeSummaryProvider } from "../src/embed/summary.js";
import { ComposeRepresenter } from "../src/represent/compose/compose-representer.js";
import { FakeTextEmbedding } from "../src/embed/fake.js";
import { id, makeStore } from "./helpers.js";

describe("summary vector space", () => {
  it("registers a summary namespace and writes one vector per composed node", async () => {
    const { store, sessionId } = await makeStore();
    for (let i = 0; i < 4; i++) {
      await store.putSegments([
        {
          id: id(), sessionId, granularity: "action",
          tMonoStart: i * 1000, tMonoEnd: (i + 1) * 1000, digest: `action ${i}`,
        },
      ]);
    }
    const embedder = new FakeTextEmbedding();
    const rep = new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
      summaryEmbedder: embedder,
    });
    const r = await rep.represent(sessionId);

    const spaces = store.listVectorSpaces().map((s) => s.namespace);
    expect(spaces).toContain(rep.namespace);
    expect(rep.namespace).toContain("summary:");
    // One vector per composed node — a leaf gets none.
    const hits = await store.searchSegments(rep.namespace!, await embedder.embed(["x"]).then((v) => v[0]!), 100);
    expect(hits.length).toBe(r.nodes);
  });

  it("registers NO space and writes no vectors without an embedder", async () => {
    const { store, sessionId } = await makeStore();
    await store.putSegments([
      { id: id(), sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000, digest: "a" },
      { id: id(), sessionId, granularity: "action", tMonoStart: 1000, tMonoEnd: 2000, digest: "b" },
    ]);
    const rep = new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) });
    await rep.represent(sessionId);
    expect(rep.namespace).toBeNull();
    expect(store.listVectorSpaces().some((s) => s.namespace.startsWith("summary:"))).toBe(false);
  });
});
```

Check the exact names of `FakeTextEmbedding` and `searchSegments`' signature
before running — read `src/embed/fake.ts` and the `Store` interface, and use
whatever those actually export.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.retrieval.test.ts`
Expected: FAIL — `rep.namespace` is undefined.

- [ ] **Step 3: Embed summaries in the stage**

In `compose-representer.ts`, add to the options and the class:

```ts
  summaryEmbedder?: EmbeddingProvider;
```

```ts
  readonly namespace: string | null;
  private spaceReady = false;
```

In the constructor:

```ts
    this.summaryEmbedder = opts.summaryEmbedder;
    // `view` is part of the namespace, so this is a distinct physical table on
    // the SAME embedder digest uses — a new similarity space at no extra
    // provider cost.
    this.namespace =
      this.summaryEmbedder === undefined
        ? null
        : namespaceFor("summary", this.summaryEmbedder);
```

At the end of `represent()`, after `putSegmentSummaries`:

```ts
    if (this.summaryEmbedder !== undefined && this.namespace !== null && summaries.length > 0) {
      if (!this.spaceReady) {
        await this.store.registerVectorSpace({
          namespace: this.namespace,
          view: "summary",
          providerId: this.summaryEmbedder.id,
          model: this.summaryEmbedder.model,
          dimensions: this.summaryEmbedder.dimensions,
          sharedTextSpace: false,
        });
        this.spaceReady = true;
      }
      const vectors = await this.summaryEmbedder.embed(summaries.map((s) => s.text));
      // Text is already committed above, so a crash here leaves a re-embeddable
      // row rather than an orphan vector. `replace`, not `put`: this stage can
      // run twice and a bare add would leave two vectors under one id that
      // reconcile() can never prune.
      await this.store.replaceSegmentVectors(
        summaries.map((s, i) => ({
          namespace: this.namespace!,
          id: s.segmentId,
          vector: vectors[i]!,
        })),
      );
    }
```

- [ ] **Step 4: Wire the searcher**

In `app/src/main/deskrag-service.ts`:

- pass `summaryEmbedder: prov.textEmbedder` when constructing `ComposeRepresenter` in the Composing stage;
- in `buildRetriever`, add a `TextViewSearcher(textEmbedder, "summary")` **gated on `listVectorSpaces()`** exactly as caption and transcript are — `searchSegments` throws on an unregistered namespace, and the summary space does not exist until something has been composed with an embedder.

- [ ] **Step 5: Re-sweep `DEFAULT_RRF_K`**

`DEFAULT_RRF_K` is 10 rather than the published 60 because the lane-count term
spans 5× at five lanes. A sixth lane changes that term, and the constant is
documented as *inverting* the ranking when wrong.

Run the known-answer sweep on a real library over k ∈ {5, 10, 20, 60} and record
the mean rank of the correct answer for five known-answer queries. If 10 is no
longer best, change `DEFAULT_RRF_K` in `src/retrieve/` **and** the comment
explaining it — and check `Tier1Retriever` does not carry its own literal.

Report the table before continuing.

- [ ] **Step 6: Run the tests and commit**

```bash
npx vitest run test/compose.retrieval.test.ts
npm run typecheck && npm test && npm run build && npm --prefix app run typecheck
git add src/represent/compose/compose-representer.ts app/src/main/deskrag-service.ts test/compose.retrieval.test.ts
git commit -m "feat(retrieve): a summary view and its Tier-1 lane"
```

---

### Task 12: Leaf expansion and ancestor collapse

**Files:**
- Modify: `src/retrieve/assemble.ts`
- Test: `test/assemble.test.ts` (extend)

**Interfaces:**
- Consumes: `getDescendantLeaves` (Task 1).
- Produces:
  ```ts
  export function collapseAncestors<T extends { segmentId: string }>(
    hits: readonly T[],
    childrenOf: (id: string) => string[],
  ): T[];
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/assemble.test.ts`:

```ts
import { collapseAncestors } from "../src/retrieve/assemble.js";

describe("collapseAncestors", () => {
  const tree: Record<string, string[]> = { root: ["task"], task: ["a", "b"] };
  const childrenOf = (id: string) => tree[id] ?? [];

  it("keeps the higher-ranked of an ancestor/descendant pair", () => {
    // Hits arrive best-first.
    expect(collapseAncestors([{ segmentId: "task" }, { segmentId: "a" }], childrenOf))
      .toEqual([{ segmentId: "task" }]);
    expect(collapseAncestors([{ segmentId: "a" }, { segmentId: "task" }], childrenOf))
      .toEqual([{ segmentId: "a" }]);
  });

  it("collapses across more than one generation", () => {
    expect(collapseAncestors([{ segmentId: "root" }, { segmentId: "b" }], childrenOf))
      .toEqual([{ segmentId: "root" }]);
  });

  it("keeps unrelated hits — siblings are two answers, not one", () => {
    expect(collapseAncestors([{ segmentId: "a" }, { segmentId: "b" }], childrenOf))
      .toEqual([{ segmentId: "a" }, { segmentId: "b" }]);
  });

  it("is a no-op with no tree at all", () => {
    expect(collapseAncestors([{ segmentId: "x" }, { segmentId: "y" }], () => []))
      .toEqual([{ segmentId: "x" }, { segmentId: "y" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assemble.test.ts`
Expected: FAIL — `collapseAncestors is not exported`.

- [ ] **Step 3: Implement**

In `src/retrieve/assemble.ts`:

```ts
/**
 * Drop a hit that is an ancestor or a descendant of a better-ranked one.
 *
 * A parent's span contains its children's, so Tier 1 returns a task AND several
 * of its actions as separate results — the very redundancy the hierarchy exists
 * to remove, reproduced in the result list. A moment belongs to ONE place in
 * the tree, so the better-ranked hit keeps it.
 *
 * `hits` must be best-first. Sibling hits are untouched: two siblings are two
 * answers, not one.
 */
export function collapseAncestors<T extends { segmentId: string }>(
  hits: readonly T[],
  childrenOf: (id: string) => string[],
): T[] {
  const descendants = (id: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...childrenOf(id)];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      stack.push(...childrenOf(cur));
    }
    return out;
  };

  const kept: T[] = [];
  const covered = new Set<string>();
  for (const hit of hits) {
    if (covered.has(hit.segmentId)) continue;
    const below = descendants(hit.segmentId);
    if (kept.some((k) => descendants(k.segmentId).has(hit.segmentId))) continue;
    kept.push(hit);
    for (const d of below) covered.add(d);
  }
  return kept;
}
```

- [ ] **Step 4: Apply both rules in the retriever**

In the Tier-1 → Tier-2 handoff in `src/retrieve/`:

1. run `collapseAncestors(tier1Hits, (id) => store.getSegmentChildren(id))` before scoping;
2. build the Tier-2 scope as `hits.flatMap((h) => store.getDescendantLeaves(h.segmentId))`, deduped.

Add the comment at the scope site:

```ts
  // Frame vectors denormalize `segment_ids` at represent time, long before
  // composing runs, so a composed level can NEVER appear in that field.
  // Scoping a parent hit directly matches zero frames and returns empty with no
  // error at all — the same silent shape as the frame<->segment bug. Expanding
  // to leaves costs one read and cannot drift.
```

Read the actual call site before editing (`grep -n "array_has_any\|segment_ids" src/retrieve/*.ts`) and thread the store reads through whatever injection that file already uses — do not add a store import to a module that does not have one.

- [ ] **Step 5: Run the tests and commit**

```bash
npx vitest run test/assemble.test.ts
npm run typecheck && npm test
git add src/retrieve/ test/assemble.test.ts
git commit -m "feat(retrieve): expand parent hits to leaves and collapse ancestors"
```

---

### Task 13: Hits carry their altitude

**Files:**
- Modify: `app/src/shared/types.ts` (`FrameHitDTO`, `ResultDetailDTO`)
- Modify: `app/src/main/deskrag-service.ts` (hydration, near lines 850–1000)
- Modify: `app/src/renderer/src/screens/SearchScreen.tsx`, `DetailView.tsx`

**Interfaces:**
- Consumes: `getSegmentSummary`, `getSegmentChildren` (Task 1).
- Produces:
  ```ts
  // on FrameHitDTO and ResultDetailDTO:
  taskSummary: string | null;
  ```

- [ ] **Step 1: Add the DTO field**

In `app/src/shared/types.ts`:

```ts
  /**
   * The summary of the lowest composed level containing this hit — the answer
   * to "what was I doing?" when the thing retrieved is a single frame.
   *
   * `null` for a recording indexed before composing, or one whose tree has no
   * level above the leaf.
   */
  taskSummary: string | null;
```

on both `FrameHitDTO` and `ResultDetailDTO`.

- [ ] **Step 2: Hydrate it**

In `DeskRagService`, add a private helper and call it from both hydration sites
(the `segmentCaption`/`segmentDigest` lines around 866 and 998):

```ts
  /**
   * Walk UP from a leaf to the nearest composed parent and take its summary.
   *
   * Nearest, not the root: the root's summary is the whole session's purpose,
   * which is true of every hit in the recording and therefore tells a reader
   * nothing about this one.
   */
  private taskSummaryFor(segmentId: string | null): string | null {
    if (segmentId === null) return null;
    let cur: string | undefined = segmentId;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const summary = this.store.getSegmentSummary(cur);
      if (summary !== undefined && cur !== segmentId) return summary.text;
      cur = this.store.getSegmentParent(cur);
    }
    return null;
  }
```

This needs one more Store read. Add to the interface and implement in `store.ts`:

```ts
  /** The composed parent of a segment, or undefined for a root / a stray leaf. */
  getSegmentParent(childId: string): string | undefined;
```

```ts
  getSegmentParent(childId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT parent_id FROM segment_tree WHERE child_id = ?`)
      .get(childId) as { parent_id: string } | undefined;
    return row?.parent_id;
  }
```

- [ ] **Step 3: Show it**

In `SearchScreen.tsx`, render `taskSummary` on the result card as a dimmed line
prefixed `in: `, below the existing label. In `DetailView.tsx`, the same, near the
existing segment caption. Withhold the line entirely when `null` — an empty
"in: " asserts a hierarchy that does not exist.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm test && npm run build && npm --prefix app run typecheck
```

Then follow the `run-app` skill: search for a term from a real recording and
confirm the result card reads `in: <task summary>`.

```bash
git add app/src/shared/types.ts app/src/main/deskrag-service.ts src/store/types.ts src/store/store.ts app/src/renderer/src/screens/SearchScreen.tsx app/src/renderer/src/screens/DetailView.tsx
git commit -m "feat(app): search hits carry the task they happened inside"
```

---

# Phase 7 — Flows and the Library

### Task 14: Route names from provenance

**Files:**
- Modify: `app/src/main/graph-view.ts`
- Modify: `app/src/shared/types.ts` (route DTO)
- Test: `test/flows.graph-view.test.ts` (extend)

**Interfaces:**
- Consumes: `TraceEdge.sources`; a summary lookup injected as a callback so `graph-view.ts` stays pure.
- Produces:
  ```ts
  export interface RouteSpan { sessionId: string; tMonoStart: number; tMonoEnd: number }
  export interface CoveringSummary { text: string; level: number; coveredMs: number }
  export function nameRoute(
    spans: readonly RouteSpan[],
    covering: (span: RouteSpan) => CoveringSummary[],
  ): { name: string | null; observations: number };
  // on the route DTO: name: string | null; nameObservations: number;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/flows.graph-view.test.ts`:

```ts
import { nameRoute } from "../app/src/main/graph-view.js";

describe("nameRoute", () => {
  const span = (sessionId: string, a: number, b: number) => ({
    sessionId, tMonoStart: a, tMonoEnd: b,
  });

  it("takes the LOWEST level that covers the majority of the route", () => {
    const covering = () => [
      { text: "filed the expense report", level: 1, coveredMs: 9000 },
      { text: "did admin", level: 2, coveredMs: 10000 },
    ];
    expect(nameRoute([span("s1", 0, 10000)], covering).name).toBe("filed the expense report");
  });

  it("rises a level when no single lower node covers the majority", () => {
    const covering = () => [
      { text: "opened the form", level: 1, coveredMs: 3000 },
      { text: "did admin", level: 2, coveredMs: 9000 },
    ];
    expect(nameRoute([span("s1", 0, 10000)], covering).name).toBe("did admin");
  });

  it("returns null when nothing covers the majority — the route is not one task", () => {
    const covering = () => [{ text: "a bit of this", level: 1, coveredMs: 1000 }];
    expect(nameRoute([span("s1", 0, 10000)], covering).name).toBeNull();
  });

  it("reports how many recordings agreed, and never merges disagreeing names", () => {
    const covering = (s: { sessionId: string }) =>
      s.sessionId === "s3"
        ? [{ text: "something else", level: 1, coveredMs: 10000 }]
        : [{ text: "filed the expense report", level: 1, coveredMs: 10000 }];
    const out = nameRoute(
      [span("s1", 0, 10000), span("s2", 0, 10000), span("s3", 0, 10000)],
      covering,
    );
    expect(out.name).toBe("filed the expense report");
    expect(out.nameObservations ?? out.observations).toBe(2);
  });

  it("returns null for a route with no provenance", () => {
    expect(nameRoute([], () => []).name).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flows.graph-view.test.ts`
Expected: FAIL — `nameRoute is not exported`.

- [ ] **Step 3: Implement**

In `app/src/main/graph-view.ts`:

```ts
/**
 * Name a route from what its recordings actually did.
 *
 * The route's KEY is unchanged — the deduped labelNode sequence — and must stay
 * that way. Summaries are NONDETERMINISTIC, so re-keying on them would change a
 * route's identity on every re-index. Names change; identities must not.
 *
 * Walk up from level 1 and take the lowest level at which a SINGLE node covers
 * the majority of the route's recorded time, so a route is named at the
 * altitude it actually occupies rather than a fixed one. If nothing qualifies,
 * the route keeps its label sequence — the honest answer for a route that is
 * not one task.
 *
 * Recordings sometimes disagree. The dominant name wins and its COUNT is
 * reported; the names are never merged into one sentence — the
 * `observations`/`sources` rule.
 */
export function nameRoute(
  spans: readonly RouteSpan[],
  covering: (span: RouteSpan) => CoveringSummary[],
): { name: string | null; observations: number } {
  const votes = new Map<string, { level: number; n: number }>();
  for (const span of spans) {
    const total = span.tMonoEnd - span.tMonoStart;
    if (total <= 0) continue;
    const candidates = covering(span)
      .filter((c) => c.coveredMs * 2 > total)
      .sort((a, b) => a.level - b.level);
    const best = candidates[0];
    if (best === undefined) continue;
    const prev = votes.get(best.text);
    votes.set(best.text, { level: best.level, n: (prev?.n ?? 0) + 1 });
  }
  let name: string | null = null;
  let observations = 0;
  for (const [text, v] of votes) {
    // Ties keep the first-inserted name, so the result is stable across reads.
    if (v.n > observations) {
      name = text;
      observations = v.n;
    }
  }
  return { name, observations };
}
```

Add `name: string | null` and `nameObservations: number` to the route DTO in
`app/src/shared/types.ts`, populate them in `DeskRagService.flows()` by passing a
`covering` callback that reads `getSegmentSummariesBySession` plus the segment
rows for that session, and render the name on the route row in the Flows drawer —
falling back to the existing label sequence when `name` is `null`.

- [ ] **Step 4: Run the tests and commit**

```bash
npx vitest run test/flows.graph-view.test.ts
npm run typecheck && npm test && npm --prefix app run typecheck
git add app/src/main/graph-view.ts app/src/shared/types.ts app/src/main/deskrag-service.ts app/src/renderer/src/screens/FlowsScreen.tsx test/flows.graph-view.test.ts
git commit -m "feat(app): name Flows routes from the task they perform"
```

---

### Task 15: The session's purpose in the Library

**Files:**
- Modify: `app/src/shared/types.ts` (session DTO)
- Modify: `app/src/main/deskrag-service.ts` (`sessions()`, `sessionTracks()`)
- Modify: `app/src/renderer/src/screens/LibraryScreen.tsx`

**Interfaces:**
- Consumes: `getSegmentSummary` (Task 1); `ROOT_GRANULARITY` (Task 7).
- Produces:
  ```ts
  // on the session summary DTO:
  purpose: string | null;
  purposeSource: "llm" | "template" | null;
  ```

- [ ] **Step 1: Add the DTO fields**

In `app/src/shared/types.ts`, on the session summary DTO:

```ts
  /**
   * The recording's purpose — the summary of its root segment, the one node
   * that covers the whole session.
   *
   * `null` for a session captured but not yet indexed. Required rather than
   * optional so the compiler finds every builder.
   */
  purpose: string | null;
  /** Which path produced `purpose`. `null` whenever `purpose` is null. */
  purposeSource: SummarySource | null;
```

- [ ] **Step 2: Populate it**

In `DeskRagService`, where the session list is built:

```ts
      const root = this.store
        .getSegmentsBySession(s.id)
        .find((seg) => seg.granularity === "session");
      const summary = root === undefined ? undefined : this.store.getSegmentSummary(root.id);
```

then `purpose: summary?.text ?? null, purposeSource: summary?.source ?? null`.

If `listSessions()` is the hot path for a large library, read the roots in one
query instead of per session — mirror how `sessionDetail` resolves keyframe
labels from a single `getSegmentsBySession()` map rather than a `getSegment()`
per keyframe.

- [ ] **Step 3: Render it**

In `LibraryScreen.tsx`, show `purpose` on the session card beneath the existing
duration/frame-count line. Withhold the line entirely when `null` — the list must
assert nothing false about a session that has not been composed.

When `purposeSource === "template"`, render it dimmed with a `title` attribute
saying the tree was composed structurally because no text model was configured.
Same disclosure rule as the rail's lane `warning`.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm test && npm run build && npm --prefix app run typecheck
```

Then follow the `run-app` skill: open the Library and confirm each indexed
recording shows a purpose, and that an un-indexed one shows none rather than an
empty line.

```bash
git add app/src/shared/types.ts app/src/main/deskrag-service.ts app/src/renderer/src/screens/LibraryScreen.tsx
git commit -m "feat(app): show each recording's purpose in the Library"
```

---

### Task 16: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the stale invariants**

Three passages now describe removed behavior and must change, or they will
mislead the next reader exactly as the `task` granularity misled this one:

1. The segmentation section's description of `action`/`task` as two granularities — replace with the hierarchy: level 0 is windowed, every level above it is composed.
2. `**The digest is a retrieval surface, not a tally.**` — add that composed levels carry a `summary` instead of a digest, and that `segment_fts` indexes five views now, not four.
3. The track rail's "Sixteen lanes are FOUR shapes" — the lane COUNT is now variable with depth, and `TrackLaneDTO.level` is required.

- [ ] **Step 2: Add the new invariants**

Write the non-obvious ones, in the file's existing voice — each stating the
measurement or the failure it prevents:

- Composed levels are `segment` rows; `segment_tree`/`segment_summary` are tables because `segment`'s shape is frozen.
- Tier-2 scoping expands a parent hit to its **leaves**, because frame vectors denormalize `segment_ids` before composing runs — scoping a parent directly returns zero frames with no error.
- A malformed partition is **rejected wholesale, never repaired**.
- `source` distinguishes a summarized hierarchy from a structural one, and the rail says which through `warning`.
- Whatever Validation 1 measured about LLM vs structural cuts — with the numbers.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the compositional hierarchy's invariants"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
| --- | --- |
| §1 Data model (tables, invariant, `finestGranularity`, cascade) | 1 |
| §1 `task` removed | 8 |
| §2 Provider contract, one prompt, Ollama, fake | 5, 6 |
| §2 Validation in code, rejected wholesale | 2, 4 |
| §2 Blocks, barriers, batch cap | 2 |
| §2 Termination, strict shrinkage | 4 |
| §2 Structural fallback + rollup | 2, 3 |
| §2 Compose cannot fail the run | 4, 7 |
| §2 Stage placement | 7, 8 |
| §3 Coarse→fine order, titles, `level`, `showLabels`, caption strip, `warning` | 9, 10 |
| §4 `summary` view + Tier-1 lane + gating | 11 |
| §4 `DEFAULT_RRF_K` re-sweep | 11 step 5 |
| §4 `segment_fts` gains summaries | 8 |
| §4 Ancestor/descendant collapse | 12 |
| §4 Tier-2 leaf expansion; parent frames = union of children's | 12, 7 |
| §4 Hits carry altitude | 13 |
| §5 Route keeps key, gains name from provenance | 14 |
| §5 Library purpose, no rebuild banner | 15 |
| §6 Testing (purity, default config, store round-trip, translation invariance) | 1–4, 7 |
| §7 Validation 1, 2, 3 | Checkpoint, 11 step 5 |
| §Build order | Phase order 1→7 |

**Two known gaps, recorded rather than hidden:**

- **Settings UI for the summary model.** Task 8 adds `summaryProvider` and `ollamaSummaryModel` to the settings store and `listSummaryModels` exists (Task 6), but no task adds the Settings *picker*. Add it in Task 8 step 7 alongside the store change, mirroring the caption model dropdown, or the feature is unreachable without editing `settings.json` by hand.
- **`appOf` parses `buildDigest`'s own template.** If that template changes, `appOf` returns `null` and coherence degrades to gaps alone. That is the safe direction and it is commented at the call site, but it is a real coupling between two files.

**Type consistency:** `ChildSummary`, `Block`, `ComposeGroup`, `ComposedNode`, `ComposedLevel` and `Partitioner` are defined once in `compose/types.ts` and imported everywhere. `SummarySource` is defined once in `store/types.ts`. Store method names are used identically in Tasks 1, 7, 9, 12, 13, 14, 15. `levelTitle`/`levelIndex` keep their names across Tasks 9 and 10.

**Placeholder scan:** no TBD, no "add error handling", no "similar to Task N". Two steps deliberately say *read the existing call site first* (Task 7 step 4's Lance delete, Task 12 step 4's scope site) rather than inventing a signature — that is a real instruction with a named command, not a placeholder.
