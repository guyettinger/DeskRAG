# Finer Segmentation, Transcript De-duplication, and App Caption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three real problems found by reading a real recording's timeline — the `task` granularity collapsing a whole short recording into one summary, the transcript row repeating text across straddled segments, and `action` segmentation being a flat clock instead of behavior-driven — and add a new `app_caption` view (a focused-window caption, distinct from the existing whole-desktop caption) as a 7th searchable Tier-1 view.

**Architecture:** `segment/` gains a `burst_gap` boundary reason (meaningful-input-only idle gaps) and lets each granularity filter which boundary reasons cut it, with `task`'s window size now adaptive to session length. `represent/transcript/` gains real whisper.cpp timestamps so transcript text is sliced per store segment instead of joined whole-blob. `represent/caption/` gains a second Representer that crops each sampled keyframe to the focused window's bounds (already captured on `focus_change` events) before captioning, storing the result in a new SQLite table (the existing `segment` table's shape is frozen — no migration mechanism) and a new `app_caption` vector namespace fused into Tier-1 retrieval.

**Tech Stack:** TypeScript (strict, ESM), better-sqlite3, LanceDB, vitest. No new dependencies.

## Global Constraints

- Run `npm run typecheck` after every task — it is the primary correctness gate (strict TS).
- Run the affected test file with `npx vitest run test/<file>.test.ts` after every task; run the full `npm test` at the end of Task 3 and again at the end of Task 9.
- SQLite writes commit before Lance vector writes, always (dual-store invariant) — every new write path in this plan follows `updateSegment*` (SQLite) then `putSegmentVectors` (Lance).
- The `segment` table's columns are frozen — `CREATE TABLE IF NOT EXISTS` with no migration mechanism means a new column never reaches an existing install. New persisted text goes in a new table.
- Adapters that load a **native npm module** are not barrel-exported; adapters that only **spawn a subprocess** are. Nothing in this plan touches a native module, so no barrel-export rule changes.
- Never commit with `--no-verify`; only commit when a task's own steps say to.

---

### Task 1: Burst-gap boundary detection

**Files:**
- Modify: `src/segment/types.ts`
- Modify: `src/segment/boundaries.ts`
- Test: `test/segment.test.ts`

**Interfaces:**
- Produces: `BoundaryReason` gains `"burst_gap"`; `DEFAULT_BURST_GAP_MS = 1_500`; `computeBoundaries(events, endTMono, dwellGapMs?, burstGapMs?)` — new 4th parameter, defaults to `DEFAULT_BURST_GAP_MS`.

- [ ] **Step 1: Write the failing tests in `test/segment.test.ts`**

Add these three `it` blocks inside the existing `describe("computeBoundaries", ...)` block (after the existing tests, using the existing local `ev` helper):

```ts
  it("marks a burst gap on a pause between meaningful input events, ignoring mouse_move in between", () => {
    const b = computeBoundaries(
      [
        ev(0, "mouse_down"),
        ev(200, "mouse_move"),
        ev(400, "mouse_move"),
        ev(1900, "mouse_move"), // mouse keeps moving through the pause
        ev(2000, "key_down"),   // 2000ms since the last MEANINGFUL event (mouse_down at 0)
      ],
      5000,
      3000, // dwellGapMs — no all-events gap here is big enough to fire dwell_gap
      1500, // burstGapMs
    );
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 2000, reason: "burst_gap" },
      { tMono: 5000, reason: "session_end" },
    ]);
  });

  it("does not fire burst_gap on continuous mouse_move alone", () => {
    const b = computeBoundaries(
      [ev(0, "mouse_move"), ev(1000, "mouse_move"), ev(2000, "mouse_move")],
      3000,
      3000,
      1500,
    );
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 3000, reason: "session_end" },
    ]);
  });

  it("prefers focus_change over a burst_gap when they land on the same t_mono", () => {
    const b = computeBoundaries(
      [ev(0, "key_down"), ev(2000, "key_down"), ev(2000, "focus_change")],
      5000,
      3000,
      1500,
    );
    expect(b[1]).toEqual({ tMono: 2000, reason: "focus_change" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/segment.test.ts -t "burst gap"`
Expected: FAIL — `computeBoundaries` called with a 4th argument doesn't produce `burst_gap` (the type doesn't exist yet either, so this should also fail to typecheck; that's expected at this point).

- [ ] **Step 3: Add `burst_gap` to types and `DEFAULT_BURST_GAP_MS`**

In `src/segment/types.ts`, change the `BoundaryReason` union and add the new constant next to `DEFAULT_DWELL_GAP_MS`:

```ts
export type BoundaryReason =
  | "session_start"
  | "focus_change" // app/window focus changed
  | "dwell_gap" // activity resumed after a long input-idle gap (any event, including mouse_move)
  | "burst_gap" // activity resumed after a shorter gap between MEANINGFUL input (click/key/scroll)
  | "bookmark" // explicit user hotkey marker
  | "session_end"
  | "window"; // time-driven subdivision inside a span (no semantic boundary)
```

```ts
export const DEFAULT_DWELL_GAP_MS = 3_000;
export const DEFAULT_BURST_GAP_MS = 1_500;
```

- [ ] **Step 4: Implement the burst-gap check in `computeBoundaries`**

Replace the full contents of `src/segment/boundaries.ts` with:

```ts
/**
 * Event-driven boundary detection (v1). Candidate boundaries:
 *  - session_start (t=0) and session_end (endTMono) always bracket the timeline,
 *  - focus_change / bookmark events (semantic switches the user made),
 *  - dwell_gap: activity resuming after ANY input-idle gap > dwellGapMs — the
 *    "nothing happened at all, not even mouse movement" signal,
 *  - burst_gap: activity resuming after a gap > burstGapMs between MEANINGFUL
 *    input (mouse_down, key_down, scroll) specifically. mouse_move is excluded:
 *    it samples every 12-100ms, so a check over ALL events almost never lets
 *    dwell_gap fire during active use — this is the finer signal that does.
 *
 * When several reasons land on the same t_mono, the most specific wins
 * (bookmark > focus_change > dwell_gap > burst_gap); the endpoints always stay
 * session_start / session_end.
 */

import type { Boundary, BoundaryReason, SegEvent } from "./types.js";
import { DEFAULT_BURST_GAP_MS, DEFAULT_DWELL_GAP_MS } from "./types.js";

const PRIORITY: Record<BoundaryReason, number> = {
  session_start: 100,
  session_end: 100,
  bookmark: 30,
  focus_change: 20,
  dwell_gap: 10,
  burst_gap: 5,
  window: 0,
};

const MEANINGFUL_KINDS = new Set(["mouse_down", "key_down", "scroll"]);

export function computeBoundaries(
  events: readonly SegEvent[],
  endTMono: number,
  dwellGapMs: number = DEFAULT_DWELL_GAP_MS,
  burstGapMs: number = DEFAULT_BURST_GAP_MS,
): Boundary[] {
  const best = new Map<number, BoundaryReason>();
  const add = (tMono: number, reason: BoundaryReason) => {
    if (tMono < 0 || tMono > endTMono) return;
    const existing = best.get(tMono);
    if (existing === undefined || PRIORITY[reason] > PRIORITY[existing]) {
      best.set(tMono, reason);
    }
  };

  add(0, "session_start");
  let lastT: number | undefined;
  let lastMeaningfulT: number | undefined;
  for (const ev of events) {
    if (lastT !== undefined && ev.tMono - lastT > dwellGapMs) {
      add(ev.tMono, "dwell_gap");
    }
    lastT = ev.tMono;

    if (MEANINGFUL_KINDS.has(ev.kind)) {
      if (lastMeaningfulT !== undefined && ev.tMono - lastMeaningfulT > burstGapMs) {
        add(ev.tMono, "burst_gap");
      }
      lastMeaningfulT = ev.tMono;
    }

    if (ev.kind === "focus_change") add(ev.tMono, "focus_change");
    else if (ev.kind === "bookmark") add(ev.tMono, "bookmark");
  }
  add(endTMono, "session_end");

  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tMono, reason]) => ({ tMono, reason }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/segment.test.ts`
Expected: PASS — all existing `computeBoundaries`/`windowSegments`/`Segmenter` tests still pass (they call `computeBoundaries` with 2-3 args; the new 4th param defaults), plus the 3 new tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/segment/types.ts src/segment/boundaries.ts test/segment.test.ts
git commit -m "$(cat <<'EOF'
feat(segment): add burst_gap boundary for meaningful-input pauses

dwell_gap checks ALL events including mouse_move, which samples every
12-100ms and so almost never lets it fire during active use. burst_gap
gaps only on mouse_down/key_down/scroll, giving action segmentation a
signal that actually tracks behavior instead of a flat clock.
EOF
)"
```

---

### Task 2: Per-granularity `cutReasons` + adaptive task sizing

**Files:**
- Modify: `src/segment/types.ts`
- Modify: `src/segment/windowing.ts`
- Modify: `src/segment/segmenter.ts`
- Modify: `src/index.ts`
- Test: `test/segment.test.ts`

**Interfaces:**
- Consumes: `BoundaryReason`, `computeBoundaries` (Task 1).
- Produces: `GranularityConfig.cutReasons?: BoundaryReason[]`; `BASE_GRANULARITIES: GranularityConfig[]` (replaces the old exported `DEFAULT_GRANULARITIES`); `resolveGranularities(endTMono: number, base?: GranularityConfig[]): GranularityConfig[]`.

- [ ] **Step 1: Write the failing tests in `test/segment.test.ts`**

Add to the existing `describe("windowSegments", ...)` block, after its existing tests:

```ts
  it("ignores boundaries outside cutReasons (task-style filtering)", () => {
    const taskLike: GranularityConfig = {
      name: "task",
      targetMs: 100_000,
      strideMs: 50_000,
      boundaryAware: true,
      cutReasons: ["focus_change", "bookmark"],
    };
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 2000, reason: "burst_gap" }, // filtered out — not in cutReasons
      { tMono: 5000, reason: "focus_change" }, // kept
      { tMono: 8000, reason: "session_end" },
    ];
    const segs = windowSegments("s", taskLike, bounds, ulid);
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 5000, "session_start"],
      [5000, 8000, "focus_change"],
    ]);
  });

  it("an undefined cutReasons keeps every boundary (today's behavior)", () => {
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 2000, reason: "burst_gap" },
      { tMono: 8000, reason: "session_end" },
    ];
    const segs = windowSegments("s", action, bounds, ulid); // `action` has no cutReasons
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 2000, "session_start"],
      [2000, 8000, "burst_gap"],
    ]);
  });
```

Add a new `describe` block for `resolveGranularities` at the end of the file, before the final closing (import `resolveGranularities` and `BASE_GRANULARITIES` at the top alongside the other `segment/types.js` imports):

```ts
describe("resolveGranularities", () => {
  it("keeps action fixed and scales task's window to session length, floored at 30s", () => {
    const gs = resolveGranularities(8000); // 8s session
    const action = gs.find((g) => g.name === "action")!;
    const task = gs.find((g) => g.name === "task")!;
    expect(action.targetMs).toBe(10_000);
    expect(task.targetMs).toBe(30_000); // clamp(4000, 30_000, 180_000) -> floor
    expect(task.strideMs).toBe(15_000);
  });

  it("caps task's window at 180s for a long session", () => {
    const gs = resolveGranularities(1_000_000); // ~16.7 minutes
    const task = gs.find((g) => g.name === "task")!;
    expect(task.targetMs).toBe(180_000);
    expect(task.strideMs).toBe(90_000);
  });

  it("scales smoothly between the floor and the ceiling", () => {
    const gs = resolveGranularities(200_000); // 200s session -> raw 100s, within bounds
    const task = gs.find((g) => g.name === "task")!;
    expect(task.targetMs).toBe(100_000);
    expect(task.strideMs).toBe(50_000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/segment.test.ts -t "cutReasons"`
Run: `npx vitest run test/segment.test.ts -t "resolveGranularities"`
Expected: FAIL — `GranularityConfig` has no `cutReasons` field yet, `resolveGranularities`/`BASE_GRANULARITIES` don't exist.

- [ ] **Step 3: Update `src/segment/types.ts`**

Replace the `GranularityConfig` interface and the `DEFAULT_GRANULARITIES` export:

```ts
/**
 * One granularity to window at.
 *  - boundaryAware: cut at detected boundaries, then subdivide long spans into
 *    `targetMs` chunks (stride = targetMs => no overlap). Used for "actions"
 *    and (as of this change) "tasks".
 *  - !boundaryAware: pure sliding windows of `targetMs` every `strideMs`
 *    (stride < target => overlap).
 */
export interface GranularityConfig {
  name: string;
  targetMs: number;
  strideMs: number;
  boundaryAware: boolean;
  /**
   * Which boundary reasons count as a cut for this granularity, in addition to
   * session_start/session_end (always included). Undefined means every
   * reason counts — the granularity reacts to everything computeBoundaries
   * produces, which is what "action" wants: it should track behavior at full
   * resolution. "task" narrows this to the big semantic switches only, since a
   * click/key pause is noise at task scale.
   */
  cutReasons?: BoundaryReason[];
}

export interface SegmenterOptions {
  /** Input-idle gap (any event) that starts a new "true idle" boundary. */
  dwellGapMs?: number;
  /** Input-idle gap (meaningful input only) that starts a burst boundary. */
  burstGapMs?: number;
  /** Granularities to produce. Omit to resolve BASE_GRANULARITIES against the
   *  session's own length (adaptive task sizing) — see resolveGranularities. */
  granularities?: GranularityConfig[];
}

export const BASE_GRANULARITIES: GranularityConfig[] = [
  { name: "action", targetMs: 10_000, strideMs: 10_000, boundaryAware: true },
  {
    name: "task",
    targetMs: 180_000,
    strideMs: 90_000,
    boundaryAware: true,
    cutReasons: ["focus_change", "bookmark"],
  },
];

export const DEFAULT_DWELL_GAP_MS = 3_000;
export const DEFAULT_BURST_GAP_MS = 1_500;

/**
 * Task's targetMs/strideMs scale to the session's own length so a short
 * recording doesn't collapse into one giant window (clamped to [30s, 180s]);
 * action is unaffected — its 10s cap only ever subdivides a span between real
 * boundaries, so it stays meaningful at any session length.
 */
export function resolveGranularities(
  endTMono: number,
  base: GranularityConfig[] = BASE_GRANULARITIES,
): GranularityConfig[] {
  return base.map((g) => {
    if (g.name !== "task") return g;
    const targetMs = Math.min(180_000, Math.max(30_000, Math.round(endTMono / 2)));
    return { ...g, targetMs, strideMs: targetMs / 2 };
  });
}
```

(`BoundaryReason` and `Boundary` stay exactly as Task 1 left them; only `GranularityConfig`, `SegmenterOptions`, the granularity constants, and the new function change.)

- [ ] **Step 4: Filter boundaries by `cutReasons` in `windowSegments`**

In `src/segment/windowing.ts`, add the filter right after the existing early-return guard, and use the filtered list (`effective`) everywhere the function currently reads `boundaries`:

```ts
export function windowSegments(
  sessionId: string,
  g: GranularityConfig,
  boundaries: readonly Boundary[],
  mintId: () => string,
): SegmentInsert[] {
  if (boundaries.length === 0) return [];
  const effective = g.cutReasons
    ? boundaries.filter(
        (b) =>
          b.reason === "session_start" ||
          b.reason === "session_end" ||
          g.cutReasons!.includes(b.reason),
      )
    : boundaries;
  const start0 = effective[0]!.tMono;
  const end = effective[effective.length - 1]!.tMono;
  if (end <= start0) return [];

  const segs: SegmentInsert[] = [];
  const mk = (a: number, b: number, reason: string) =>
    segs.push({
      id: mintId(),
      sessionId,
      granularity: g.name,
      tMonoStart: a,
      tMonoEnd: b,
      boundaryReason: reason,
    });

  if (g.boundaryAware) {
    for (let i = 0; i < effective.length - 1; i++) {
      const b0 = effective[i]!;
      const b1 = effective[i + 1]!;
      let start = b0.tMono;
      let first = true;
      while (start < b1.tMono) {
        const stop = Math.min(start + g.targetMs, b1.tMono);
        mk(start, stop, first ? b0.reason : "window");
        start += g.strideMs;
        first = false;
      }
    }
  } else {
    let start = start0;
    for (;;) {
      const stop = Math.min(start + g.targetMs, end);
      mk(start, stop, "window");
      if (stop >= end) break;
      start += g.strideMs;
    }
  }
  return segs;
}
```

- [ ] **Step 5: Resolve granularities per-session in `Segmenter`**

In `src/segment/segmenter.ts`, change the import and constructor/`segment()`:

```ts
import { ulid } from "ulid";
import type { Store, SegmentInsert } from "../store/types.js";
import { computeBoundaries } from "./boundaries.js";
import { windowSegments } from "./windowing.js";
import {
  DEFAULT_BURST_GAP_MS,
  DEFAULT_DWELL_GAP_MS,
  resolveGranularities,
  type Boundary,
  type GranularityConfig,
  type SegmenterOptions,
} from "./types.js";
```

```ts
export class Segmenter {
  private readonly dwellGapMs: number;
  private readonly burstGapMs: number;
  private readonly granularitiesOverride: GranularityConfig[] | undefined;

  constructor(
    private readonly store: Store,
    opts: SegmenterOptions = {},
  ) {
    this.dwellGapMs = opts.dwellGapMs ?? DEFAULT_DWELL_GAP_MS;
    this.burstGapMs = opts.burstGapMs ?? DEFAULT_BURST_GAP_MS;
    this.granularitiesOverride = opts.granularities;
  }

  async segment(sessionId: string): Promise<SegmentResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const events = this.store.getEventsBySession(sessionId);

    const endTMono = this.deriveEnd(session.startedAt, session.endedAt, events);
    const boundaries = computeBoundaries(events, endTMono, this.dwellGapMs, this.burstGapMs);
    const granularities = this.granularitiesOverride ?? resolveGranularities(endTMono);

    const all: SegmentInsert[] = [];
    const byGranularity: Record<string, string[]> = {};
    for (const g of granularities) {
      const segs = windowSegments(sessionId, g, boundaries, ulid);
      byGranularity[g.name] = segs.map((s) => s.id);
      all.push(...segs);
    }
    await this.store.putSegments(all);

    return { boundaries, byGranularity, endTMono };
  }

  private deriveEnd(
    startedAt: number,
    endedAt: number | null,
    events: readonly { tMono: number }[],
  ): number {
    const lastEvent = events.length ? events[events.length - 1]!.tMono : 0;
    const wallDuration = endedAt !== null ? endedAt - startedAt : 0;
    return Math.max(lastEvent, wallDuration);
  }
}
```

(`SegmentResult` and the class docstring above it are unchanged.)

- [ ] **Step 6: Update the barrel export**

In `src/index.ts`, replace the `DEFAULT_GRANULARITIES` export block:

```ts
export {
  BASE_GRANULARITIES,
  resolveGranularities,
  DEFAULT_DWELL_GAP_MS,
  DEFAULT_BURST_GAP_MS,
  type Boundary,
  type BoundaryReason,
  type GranularityConfig,
  type SegmenterOptions,
} from "./segment/types.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/segment.test.ts`
Expected: PASS for the new `cutReasons`/`resolveGranularities` tests. The pre-existing `describe("Segmenter (integration)", ...)` tests in this same file will now FAIL — that's expected and is fixed in Task 3, not here. Confirm the failures are exactly:
- `"segments a session at multiple granularities and persists them"` — `result.byGranularity.task` now has length 2, not 1.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/segment/types.ts src/segment/windowing.ts src/segment/segmenter.ts src/index.ts test/segment.test.ts
git commit -m "$(cat <<'EOF'
feat(segment): per-granularity cutReasons + adaptive task sizing

task now cuts at focus_change/bookmark (not dwell/burst gaps, which are
noise at that scale) and its target/stride scale to the session's own
length instead of a fixed 180s/90s — a short recording no longer
collapses into one summary covering the whole session.

Known follow-up: this changes task's segment count on any session with
more than one focus span, which breaks a few existing test assertions
that assumed a single flat task segment — fixed in the next commit.
EOF
)"
```

---

### Task 3: Fix existing tests broken by the task-granularity change

**Files:**
- Modify: `test/segment.test.ts`
- Modify: `test/tier2.test.ts`
- Modify: `test/caption.test.ts`

**Interfaces:**
- Consumes: `resolveGranularities`, `windowSegments` (Task 2) — no new production code in this task, test fixes only.

This task exists because several existing tests hard-code the assumption that `task` produces exactly one segment covering the whole session. Three are already known (computed by hand below); after fixing them, run the full suite and fix anything else the same way: **any assertion that assumed a single flat `task` segment needs to account for `task` now splitting at every `focus_change`/`bookmark`, using the exact same `computeBoundaries` → `resolveGranularities` → `windowSegments` mechanics** documented in Tasks 1-2.

- [ ] **Step 1: Fix `test/segment.test.ts`'s Segmenter integration test**

The test `"segments a session at multiple granularities and persists them"` seeds events at t=0 (`mouse_move`), t=5000 (`focus_change`), t=6000 (`key_down`), `startedAt=1000`, `endedAt=9000` → `endTMono=8000`. Boundaries: `[{0,session_start},{5000,focus_change},{8000,session_end}]` (unchanged by Task 1 — no burst_gap fires here). `resolveGranularities(8000)` gives task `targetMs=30_000` (floored), so task's `cutReasons=[focus_change,bookmark]` still includes the `focus_change` at 5000, splitting task into the SAME two spans as action.

Replace the test body from `const result = await new Segmenter(store).segment(sessionId);` through the end of the `it` block with:

```ts
    const result = await new Segmenter(store).segment(sessionId);
    expect(result.endTMono).toBe(8000);
    expect(result.byGranularity.action).toHaveLength(2);
    expect(result.byGranularity.task).toHaveLength(2); // was 1 — task now cuts at focus_change too

    const segs = store.getSegmentsBySession(sessionId);
    expect(segs).toHaveLength(4); // was 3

    const actions = segs.filter((s) => s.granularity === "action");
    expect(actions.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 5000, "session_start"],
      [5000, 8000, "focus_change"],
    ]);
    const tasks = segs.filter((s) => s.granularity === "task");
    expect(tasks.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 5000, "session_start"],
      [5000, 8000, "focus_change"],
    ]);

    // represent/ fills these later; they're empty now.
    expect(actions[0]!.transcript).toBeNull();
    expect(actions[0]!.caption).toBeNull();
  });
```

- [ ] **Step 2: Fix `test/tier2.test.ts`'s frame-association test**

Its shared `setup()` uses the identical event schedule (t=0/5000/6000, `startedAt=1000`, `endSession(sessionId, 9000)`), so `task` splits the same way. In the test `"associates frames to the segments that contain them and embeds their images"`, replace:

```ts
    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 0)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;
    const task = segs.find((s) => s.granularity === "task")!;

    // frame A (t=1000) -> early action + task; frame B (t=6000) -> late action + task.
    expect(new Set(store.getFrame(frameA)!.segmentIds)).toEqual(new Set([early.id, task.id]));
    expect(new Set(store.getFrame(frameB)!.segmentIds)).toEqual(new Set([late.id, task.id]));
```

with:

```ts
    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 0)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;
    const earlyTask = segs.find((s) => s.granularity === "task" && s.tMonoStart === 0)!;
    const lateTask = segs.find((s) => s.granularity === "task" && s.tMonoStart === 5000)!;

    // frame A (t=1000) -> early action + early task; frame B (t=6000) -> late action + late task.
    // (task now splits at the same focus_change action does, so it is no
    // longer one segment shared by both frames.)
    expect(new Set(store.getFrame(frameA)!.segmentIds)).toEqual(new Set([early.id, earlyTask.id]));
    expect(new Set(store.getFrame(frameB)!.segmentIds)).toEqual(new Set([late.id, lateTask.id]));
```

- [ ] **Step 3: Fix `test/caption.test.ts`'s captioned-count assertion**

Same event schedule again. The test `"captions each segment's keyframes, persists the text, and makes it Tier-1 searchable"` currently expects 3 captioned segments (2 actions + 1 task); it's now 2 actions + 2 tasks = 4, because both the early and late keyframe now fall in their own task segment instead of sharing one. Replace:

```ts
    expect(result.namespace).toBe("caption:fake:m:8");
    // Every segment (2 actions + 1 task) contains a keyframe -> all captioned.
    expect(result.captionedCount).toBe(3);
```

with:

```ts
    expect(result.namespace).toBe("caption:fake:m:8");
    // Every segment (2 actions + 2 tasks, now that task splits at the same
    // focus_change action does) contains a keyframe -> all captioned.
    expect(result.captionedCount).toBe(4);
```

- [ ] **Step 4: Run the full suite and fix anything else the same way**

Run: `npm test`
Expected: any remaining failure is a test that assumed a single flat `task` segment. For each one: recompute `computeBoundaries` on that test's own events (Task 1's algorithm — burst_gap only from mouse_down/key_down/scroll, dwell_gap from any event), then `resolveGranularities(endTMono)` for task's `targetMs`/`strideMs` (Task 2's clamp formula), then `windowSegments` with task's `cutReasons=[focus_change, bookmark]` — same method used in Steps 1-3 above — and update the assertion to match. Do not weaken an assertion (e.g. loosening an exact-count check to `toBeGreaterThan(0)`) to make it pass; compute the real expected value.

Run `npm test` again after each fix until the full suite is green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add test/segment.test.ts test/tier2.test.ts test/caption.test.ts
git commit -m "$(cat <<'EOF'
test: fix assertions broken by task granularity now splitting at boundaries

task no longer collapses a whole recording into one segment when it
contains a focus_change — these three (and any the full suite still
flagged) hard-coded the old single-segment shape.
EOF
)"
```

(If Step 4 required touching additional files beyond the three named here, `git add` those too before committing.)

---

### Task 4: whisper.cpp `-oj` JSON timestamps

**Files:**
- Modify: `src/embed/types.ts`
- Modify: `src/represent/transcript/whisper-cpp.ts`
- Test: `test/whisper-cpp.test.ts` (new)

**Interfaces:**
- Produces: `TranscriptionResult.segments?: { text: string; startMs: number; endMs: number }[]`.

- [ ] **Step 1: Add the `segments` field to `TranscriptionResult`**

In `src/embed/types.ts`, replace:

```ts
export interface TranscriptionResult {
  /** The recognized speech; empty string when there is no speech / on failure. */
  text: string;
}
```

with:

```ts
export interface TranscriptionResult {
  /** The recognized speech; empty string when there is no speech / on failure. */
  text: string;
  /**
   * Sub-clip timing, when the provider can give it (whisper.cpp's -oj JSON
   * output; startMs/endMs are relative to the clip passed to transcribe()).
   * Absent means the caller must treat `text` as one opaque span — the
   * fallback TranscriptRepresenter.represent() uses for whole-blob attribution.
   */
  segments?: { text: string; startMs: number; endMs: number }[];
}
```

- [ ] **Step 2: Write the failing test in `test/whisper-cpp.test.ts`**

```ts
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WhisperCppTranscription } from "../src/represent/transcript/whisper-cpp.js";

/**
 * A stub whisper-cli: writes a canned whisper.cpp -oj-shaped JSON to
 * `<-of value>.json`, so WhisperCppTranscription is tested without a real
 * model or binary — same shebang-stub pattern as test/replay.sidecar-client.test.ts.
 */
function stubWhisper(jsonBody: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "whisper-stub-"));
  const path = join(dir, "whisper-cli");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "const of = args[args.indexOf('-of') + 1];",
      `fs.writeFileSync(of + '.json', ${JSON.stringify(jsonBody)});`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return { dir, path };
}

describe("WhisperCppTranscription", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("parses whisper.cpp's -oj output into text + per-segment timestamps", async () => {
    const stub = stubWhisper(
      JSON.stringify({
        transcription: [
          { offsets: { from: 0, to: 2000 }, text: " hello" },
          { offsets: { from: 2000, to: 4000 }, text: " world" },
        ],
      }),
    );
    dir = stub.dir;
    const t = new WhisperCppTranscription({ binaryPath: stub.path, modelPath: "fake-model" });
    const result = await t.transcribe(Uint8Array.from([1, 2, 3]));
    expect(result.text).toBe("hello world");
    expect(result.segments).toEqual([
      { text: "hello", startMs: 0, endMs: 2000 },
      { text: "world", startMs: 2000, endMs: 4000 },
    ]);
  });

  it("degrades to text-only ({ text: '' }) when the JSON is malformed", async () => {
    const stub = stubWhisper("not json");
    dir = stub.dir;
    const t = new WhisperCppTranscription({
      binaryPath: stub.path,
      modelPath: "fake-model",
      onError: () => {}, // silence the expected error log for this test
    });
    const result = await t.transcribe(Uint8Array.from([1, 2, 3]));
    expect(result).toEqual({ text: "" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/whisper-cpp.test.ts`
Expected: FAIL — `WhisperCppTranscription` still invokes `-nt`/`-otxt` and writes `<out>.txt`, not `<out>.json`, so the stub's `-of` file is never produced where the current code looks for it.

- [ ] **Step 4: Rewrite `src/represent/transcript/whisper-cpp.ts`**

Replace the whole file:

```ts
/**
 * WhisperCppTranscription — local speech-to-text by shelling out to a whisper.cpp
 * binary. Uses only node:child_process (no native addon), so like the ffmpeg /
 * Swift-AX adapters it is NOT re-exported from the barrel — import it from this
 * path. Audio never leaves the machine; no API key, no per-minute cost.
 *
 * Best-effort by contract (mirrors SwiftAxSource): a missing binary, missing
 * model, non-zero exit, or malformed output all resolve to `{ text: "" }`
 * (logged via onError), so absent/broken STT degrades to "no transcript"
 * rather than failing the represent pass.
 *
 * Contract for the binary (whisper.cpp `whisper-cli` / legacy `main`):
 *   whisper-cli -m <model> -f <audio.wav> -l <lang> -oj -of <out>
 *   → writes a JSON transcript (with per-segment offsets, in ms) to `<out>.json`.
 * The audio is written to a temp 16 kHz mono WAV first (that's what the audio
 * producer emits), transcribed, then both temp files are removed.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptionProvider, TranscriptionResult } from "../../embed/types.js";

export interface WhisperCppOptions {
  /** Path to the whisper.cpp binary (default: ERAG_WHISPER_BIN or "whisper-cli"). */
  binaryPath?: string;
  /** Path to a GGML/GGUF model (default: ERAG_WHISPER_MODEL). Required to work. */
  modelPath?: string;
  /** Language hint, e.g. "en" (default "auto"). */
  language?: string;
  /** Extra args appended before the input file. */
  args?: string[];
  /** Kill + return "" after this many ms (default 120000). */
  timeoutMs?: number;
  onError?: (msg: string) => void;
}

interface WhisperJsonEntry {
  text?: unknown;
  offsets?: { from?: unknown; to?: unknown };
}

/** Parses whisper.cpp's -oj JSON shape defensively; any mismatch degrades to
 *  `{ text: "" }` rather than throwing, the same contract a missing binary has. */
export function parseWhisperJson(
  json: string,
  onError: (msg: string) => void,
): TranscriptionResult {
  let parsed: { transcription?: WhisperJsonEntry[] };
  try {
    parsed = JSON.parse(json) as { transcription?: WhisperJsonEntry[] };
  } catch (err) {
    onError(
      `could not parse whisper JSON output: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { text: "" };
  }
  const entries = parsed.transcription;
  if (!Array.isArray(entries)) return { text: "" };

  const segments: { text: string; startMs: number; endMs: number }[] = [];
  for (const e of entries) {
    const text = typeof e.text === "string" ? e.text.trim() : "";
    const startMs = e.offsets?.from;
    const endMs = e.offsets?.to;
    if (!text || typeof startMs !== "number" || typeof endMs !== "number") continue;
    segments.push({ text, startMs, endMs });
  }
  const text = segments.map((s) => s.text).join(" ").trim();
  return segments.length > 0 ? { text, segments } : { text };
}

export class WhisperCppTranscription implements TranscriptionProvider {
  private readonly binaryPath: string;
  private readonly modelPath: string | undefined;
  private readonly language: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;
  private readonly onError: (msg: string) => void;

  constructor(opts: WhisperCppOptions = {}) {
    this.binaryPath = opts.binaryPath ?? process.env.ERAG_WHISPER_BIN ?? "whisper-cli";
    this.modelPath = opts.modelPath ?? process.env.ERAG_WHISPER_MODEL;
    this.language = opts.language ?? "auto";
    this.extraArgs = opts.args ?? [];
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.onError = opts.onError ?? ((m) => console.error(`[whisper] ${m}`));
  }

  async transcribe(
    audio: Uint8Array,
    opts?: { language?: string },
  ): Promise<TranscriptionResult> {
    if (!this.modelPath) {
      this.onError("no model path configured (set modelPath or ERAG_WHISPER_MODEL)");
      return { text: "" };
    }
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "erag-whisper-"));
      const wavPath = join(dir, "clip.wav");
      const outBase = join(dir, "clip"); // whisper appends ".json"
      await writeFile(wavPath, audio);
      const args = [
        "-m", this.modelPath,
        "-f", wavPath,
        "-l", opts?.language ?? this.language,
        "-oj", "-of", outBase,
        ...this.extraArgs,
      ];
      return await this.run(args, `${outBase}.json`);
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
      return { text: "" };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private run(args: string[], outPath: string): Promise<TranscriptionResult> {
    return new Promise((resolve) => {
      execFile(
        this.binaryPath,
        args,
        { timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (err) => {
          if (err) {
            this.onError(err.message);
            resolve({ text: "" });
            return;
          }
          readFile(outPath, "utf8").then(
            (json) => resolve(parseWhisperJson(json, this.onError)),
            () => resolve({ text: "" }),
          );
        },
      );
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/whisper-cpp.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/embed/types.ts src/represent/transcript/whisper-cpp.ts test/whisper-cpp.test.ts
git commit -m "$(cat <<'EOF'
feat(transcript): whisper.cpp emits per-segment timestamps via -oj

TranscriptionResult.segments carries offsets (ms, relative to the clip),
switching from -nt/-otxt's flat string. Nothing downstream reads it yet
— TranscriptRepresenter still joins whole-blob text — that's the next
commit.
EOF
)"
```

---

### Task 5: `TranscriptRepresenter` segment-level slicing

**Files:**
- Modify: `src/represent/transcript/transcript-representer.ts`
- Modify: `src/represent/transcript/fake.ts`
- Test: `test/transcript.test.ts`

**Interfaces:**
- Consumes: `TranscriptionResult.segments` (Task 4).

- [ ] **Step 1: Add a `withTimestamps` option to `FakeTranscription`**

Replace `src/represent/transcript/fake.ts`:

```ts
/**
 * Deterministic transcription provider for tests — no whisper, no network. The
 * text is a stable function of the audio bytes, so different chunks transcribe to
 * different strings and a query can reproduce one exactly.
 */

import type { TranscriptionProvider, TranscriptionResult } from "../../embed/types.js";

export interface FakeTranscriptionOptions {
  /** When true, also emit synthetic per-segment timestamps splitting the flat
   *  text into two halves spanning the clip — for exercising timestamp-based
   *  slicing in TranscriptRepresenter without real whisper output. */
  withTimestamps?: boolean;
  /** Clip duration in ms used to synthesize offsets (default 10_000, matching
   *  FfmpegAudioProducer's default chunkSeconds). */
  clipDurationMs?: number;
}

export class FakeTranscription implements TranscriptionProvider {
  constructor(private readonly opts: FakeTranscriptionOptions = {}) {}

  async transcribe(audio: Uint8Array): Promise<TranscriptionResult> {
    const sig = audio.reduce((n, b) => (n + b) % 100003, 0);
    const text = `speech[${audio.length}:${sig}]`;
    if (!this.opts.withTimestamps) return { text };

    const duration = this.opts.clipDurationMs ?? 10_000;
    const half = Math.max(1, Math.ceil(text.length / 2));
    return {
      text,
      segments: [
        { text: text.slice(0, half), startMs: 0, endMs: duration / 2 },
        { text: text.slice(half), startMs: duration / 2, endMs: duration },
      ],
    };
  }
}
```

- [ ] **Step 2: Write the failing test in `test/transcript.test.ts`**

Add a new `it` inside the existing `describe("TranscriptRepresenter (transcript view)", ...)` block:

```ts
  it("slices a straddling blob's text by timestamp instead of duplicating it across both segments", async () => {
    const sessionId = ulid();
    const mk = (t: number, kind: string, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind, ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    // One boundary at 5000, matching the FakeTranscription synthetic split at
    // duration/2 below — so each whisper "segment" lands entirely in ONE store
    // segment, not straddling.
    await store.putEvents([mk(0, "mouse_move"), mk(5000, "focus_change"), mk(6000, "key_down")]);
    await store.endSession(sessionId, 9000); // endTMono 8000

    // ONE 10s blob spanning BOTH action segments [0,5000) and [5000,8000).
    const blob = await blobs.write(sessionId, "mic", Uint8Array.from([1, 2, 3, 4, 5]), {
      tMonoStart: 0, tMonoEnd: 10_000, codec: "wav",
    });
    await store.putBlobs([blob]);

    await new Segmenter(store).segment(sessionId);

    const rep = new TranscriptRepresenter(store, {
      transcriber: new FakeTranscription({ withTimestamps: true, clipDurationMs: 10_000 }),
      transcriptEmbedder: fake,
      blobStore: blobs,
    });
    await rep.represent(sessionId);

    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 0)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;

    // Full text is "speech[5:<sig>]"; the synthetic split at duration/2=5000ms
    // lines up exactly with the focus_change boundary, so each store segment
    // gets only its own half — never both.
    expect(early.transcript).not.toBeNull();
    expect(late.transcript).not.toBeNull();
    expect(early.transcript).not.toBe(late.transcript);
    expect(late.transcript).not.toContain(early.transcript!);
    expect(early.transcript).not.toContain(late.transcript!);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/transcript.test.ts -t "slices a straddling blob"`
Expected: FAIL — today's code joins the WHOLE blob text into both `early` and `late` (they overlap the same blob), so `early.transcript === late.transcript`.

- [ ] **Step 4: Implement slicing in `TranscriptRepresenter.represent()`**

Replace the body of `src/represent/transcript/transcript-representer.ts` from the `represent` method's `textByBlob` construction through its end (keep the class fields, constructor, `ensureSpace`, and the trailing `overlaps` helper unchanged):

```ts
  async represent(sessionId: string): Promise<TranscriptRepresentResult> {
    await this.ensureSpace();
    const segments = this.store.getSegmentsBySession(sessionId);
    if (segments.length === 0) {
      return { segmentCount: 0, transcribedCount: 0, namespace: this.namespace };
    }

    const audioBlobs = this.store
      .getBlobsBySession(sessionId)
      .filter((b) => AUDIO_MEDIA.has(b.media));

    // Transcribe each audio blob once; cache the full result (text + optional
    // per-clip timestamps) by blob id.
    const resultByBlob = new Map<string, TranscriptionResult>();
    for (const b of audioBlobs) {
      const bytes = await this.blobStore.read(b);
      const r = await this.transcriber.transcribe(
        bytes,
        this.language !== undefined ? { language: this.language } : undefined,
      );
      const trimmed = r.text.trim();
      if (!trimmed) continue;
      resultByBlob.set(b.id, { text: trimmed, segments: r.segments });
    }

    const transcripts: string[] = [];
    const segIds: string[] = [];
    for (const seg of segments) {
      const overlappingBlobs = audioBlobs
        .filter((b) => resultByBlob.has(b.id) && overlaps(b, seg.tMonoStart, seg.tMonoEnd))
        .sort((a, b) => a.tMonoStart - b.tMonoStart);

      const pieces: string[] = [];
      for (const b of overlappingBlobs) {
        const r = resultByBlob.get(b.id)!;
        if (r.segments && r.segments.length > 0) {
          // Slice by absolute time: only the words that actually fall in this
          // store segment's window, not the blob's whole text.
          for (const s of r.segments) {
            const absStart = b.tMonoStart + s.startMs;
            const absEnd = b.tMonoStart + s.endMs;
            if (absStart < seg.tMonoEnd && absEnd > seg.tMonoStart) {
              const piece = s.text.trim();
              if (piece) pieces.push(piece);
            }
          }
        } else {
          // No timestamps for this blob (fake transcriber, or a provider that
          // can't give them): fall back to attributing its whole text to every
          // segment it overlaps — today's behavior. Duplication can return in
          // this case, but a transcript is still better than none.
          pieces.push(r.text);
        }
      }

      const transcript = pieces.join(" ").trim();
      if (!transcript) continue;

      await this.store.updateSegment(seg.id, { transcript }); // SQLite text first
      transcripts.push(transcript);
      segIds.push(seg.id);
    }

    if (transcripts.length > 0) {
      const vecs = await this.embedder.embed(transcripts);
      const rows: SegmentVectorInsert[] = segIds.map((id, i) => ({
        segmentId: id,
        sessionId,
        namespace: this.namespace,
        vector: vecs[i]!,
      }));
      await this.store.putSegmentVectors(rows);
    }

    return {
      segmentCount: segments.length,
      transcribedCount: segIds.length,
      namespace: this.namespace,
    };
  }
```

Also update the import line to bring in `TranscriptionResult`:

```ts
import type { EmbeddingProvider, TranscriptionProvider, TranscriptionResult } from "../../embed/types.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/transcript.test.ts`
Expected: PASS — the new test, and both pre-existing tests in this file (they use the default `FakeTranscription()` with no `withTimestamps`, so they exercise the unchanged fallback path).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/represent/transcript/transcript-representer.ts src/represent/transcript/fake.ts test/transcript.test.ts
git commit -m "$(cat <<'EOF'
fix(transcript): slice text by timestamp instead of joining whole blobs

A 10s audio blob straddling two adjacent action segments used to hand
its ENTIRE text to both, since action boundaries aren't aligned to the
audio clock. Now each segment gets only the words whose timestamp
actually falls in its window; a provider with no timestamps still falls
back to the old whole-blob join rather than losing the transcript.
EOF
)"
```

---

### Task 6: `segment_app_caption` store table + Store methods + reconcile wiring

**Files:**
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/store.ts`
- Test: `test/app-caption.store.test.ts` (new)

**Interfaces:**
- Produces: `Store.updateSegmentAppCaption(segmentId: string, text: string): Promise<void>`; `Store.getAppCaption(segmentId: string): string | undefined`; `reconcile()` treats the `app_caption` view the same way it treats `caption`/`digest`/`transcript`.

- [ ] **Step 1: Add the `segment_app_caption` table to the schema**

In `src/store/sqlite/schema.ts`, insert this block immediately after the `idx_segment_session` index (right after the `segment` table's own index, before the `frame` table):

```sql
-- The focused-app-window caption (app_caption view) — a SEPARATE table, not a
-- column on segment, because segment's shape is frozen: CREATE TABLE IF NOT
-- EXISTS with no migration step means a new column would never reach an
-- existing install. Same pattern as ax_snapshot/trace_node_source.
CREATE TABLE IF NOT EXISTS segment_app_caption (
  segment_id  TEXT PRIMARY KEY REFERENCES segment(id) ON DELETE CASCADE,
  text        TEXT NOT NULL
);
```

- [ ] **Step 2: Add the Store interface methods**

In `src/store/types.ts`, add these two method declarations to the `Store` interface, in the "enrich existing segments" section right after `putSegmentVectors`:

```ts
  /**
   * Attach the focused-app-window caption text to a segment. Lives in
   * segment_app_caption (a new table — see the schema comment) rather than a
   * `SegmentPatch` field, since `segment`'s columns are frozen.
   */
  updateSegmentAppCaption(segmentId: string, text: string): Promise<void>;
  /** Read back a segment's app_caption text, or undefined if none was written. */
  getAppCaption(segmentId: string): string | undefined;
```

- [ ] **Step 3: Write the failing test in `test/app-caption.store.test.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import type { EventInsert } from "../src/store/types.js";

describe("segment_app_caption (Store.updateSegmentAppCaption / getAppCaption)", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-appcap-store-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips text, and cascade-deletes with its segment's session", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.putEvents([{ id: ulid(), sessionId, tMono: 0, kind: "mouse_move" } as EventInsert]);
    await store.endSession(sessionId, 1000);
    await store.putSegments([
      { id: "seg1", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
    ]);

    expect(store.getAppCaption("seg1")).toBeUndefined();
    await store.updateSegmentAppCaption("seg1", "Calculator showing 1 + 1 = 2");
    expect(store.getAppCaption("seg1")).toBe("Calculator showing 1 + 1 = 2");

    // Overwrite, don't duplicate.
    await store.updateSegmentAppCaption("seg1", "Calculator showing 2");
    expect(store.getAppCaption("seg1")).toBe("Calculator showing 2");

    await store.deleteSession(sessionId);
    expect(store.getAppCaption("seg1")).toBeUndefined();
  });

  it("reconcile() treats app_caption like the other text views: missing vector -> re-embed candidate", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.endSession(sessionId, 1000);
    await store.putSegments([
      { id: "seg1", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
    ]);
    await store.registerVectorSpace({
      namespace: "app_caption:fake:m:8",
      view: "app_caption",
      providerId: "fake",
      model: "m",
      dimensions: 8,
      sharedTextSpace: false,
    });
    // Text written, no vector — simulating a crash between the two writes.
    await store.updateSegmentAppCaption("seg1", "hello");

    const result = await store.reconcile();
    expect(result.missing.some((m) => m.entity === "segment" && m.id === "seg1")).toBe(true);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/app-caption.store.test.ts`
Expected: FAIL — `store.updateSegmentAppCaption`/`getAppCaption` don't exist yet (TypeScript error), and even once stubbed, `reconcile()` doesn't know about `app_caption`.

- [ ] **Step 5: Implement the prepared statements and methods in `src/store/store.ts`**

Add these three prepared statements inside `prepare()`, near `updateSegment` (after its definition, before `deleteRegionFts`):

```ts
      upsertSegmentAppCaption: db.prepare(
        `INSERT INTO segment_app_caption(segment_id, text) VALUES (?, ?)
         ON CONFLICT(segment_id) DO UPDATE SET text = excluded.text`,
      ),
      selectSegmentAppCaption: db.prepare(
        "SELECT text FROM segment_app_caption WHERE segment_id = ?",
      ),
```

Add the reconciliation-scan statement in the "reconciliation" group, right after `selectSegmentIdsWithTranscript`:

```ts
      selectSegmentIdsWithAppCaption: db.prepare(
        "SELECT segment_id AS id FROM segment_app_caption",
      ),
```

Add the two methods right after `updateSegment`/`putSegmentVectors`:

```ts
  async updateSegmentAppCaption(segmentId: string, text: string): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.upsertSegmentAppCaption.run(segmentId, text);
    });
  }

  getAppCaption(segmentId: string): string | undefined {
    const row = this.stmts.selectSegmentAppCaption.get(segmentId) as
      | { text: string }
      | undefined;
    return row?.text;
  }
```

Extend `reconcile()`'s view ternary (the `else` branch that builds `expected` for a "segment view") to include `app_caption`:

```ts
        const stmt =
          space.view === "caption"
            ? this.stmts.selectSegmentIdsWithCaption
            : space.view === "digest"
              ? this.stmts.selectSegmentIdsWithDigest
              : space.view === "transcript"
                ? this.stmts.selectSegmentIdsWithTranscript
                : space.view === "app_caption"
                  ? this.stmts.selectSegmentIdsWithAppCaption
                  : null;
```

- [ ] **Step 6: Add `"app_caption"` to the `View` union (needed for `registerVectorSpace` in the test above to typecheck)**

In `src/embed/types.ts`, update `View` and `VIEWS`:

```ts
export type View =
  | "caption" // VLM visual-semantic summary text
  | "app_caption" // VLM summary of the focused app window only (crop of `caption`'s frame)
  | "digest" // templated structured-event text
  | "transcript" // STT text (mic + desktop audio)
  | "behavior" // numeric input-dynamics feature vector
  | "frame_image" // whole-frame image embedding
  | "region_image" // region-crop image embedding (the PixelRAG part)
  | "frame_patches"; // multi-vector late-interaction frame patches

export const VIEWS: readonly View[] = [
  "caption",
  "app_caption",
  "digest",
  "transcript",
  "behavior",
  "frame_image",
  "region_image",
  "frame_patches",
] as const;
```

(This is also a prerequisite for Task 8, which is the task that actually writes to this namespace — declaring it here now means Task 6's test can register the space directly, and `export * from "./embed/types.js"` in `src/index.ts` already re-exports `View`/`VIEWS`, no barrel change needed.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/app-caption.store.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full store test suite to confirm no regression**

Run: `npx vitest run test/dual-store.reconcile.test.ts test/dual-store.crash.test.ts test/dual-store.patches.test.ts`
Expected: PASS (the reconcile ternary change is additive only).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/store/sqlite/schema.ts src/store/types.ts src/store/store.ts src/embed/types.ts test/app-caption.store.test.ts
git commit -m "$(cat <<'EOF'
feat(store): segment_app_caption table + app_caption view

New table (not a column — segment's shape is frozen) for the upcoming
focused-app-window caption. Store.updateSegmentAppCaption/getAppCaption
mirror the ax_snapshot upsert pattern; reconcile() now treats app_caption
like the other three text views so a crash between the text write and
the vector write stays re-embeddable.
EOF
)"
```

---

### Task 7: Focused-window bounds resolver

**Files:**
- Create: `src/represent/caption/focus-bounds.ts`
- Test: `test/caption.test.ts`

**Interfaces:**
- Consumes: `EventRow`, `Box` (existing).
- Produces: `resolveFocusBounds(focusEvents: readonly EventRow[], tMono: number): Box | undefined`.

- [ ] **Step 1: Write the failing test in `test/caption.test.ts`**

Add near the top of the file (after the existing imports — add `import { resolveFocusBounds } from "../src/represent/caption/focus-bounds.js";` and `import type { EventRow } from "../src/store/types.js";`) a new top-level `describe` block:

```ts
describe("resolveFocusBounds", () => {
  const mkEvent = (tMono: number, bounds?: { x: number; y: number; w: number; h: number }): EventRow => ({
    id: "e", sessionId: "s", tMono, kind: "focus_change", x: null, y: null,
    data: bounds ? { app: "X", bounds } : { app: "X" },
  });

  it("returns the latest bounds at-or-before tMono", () => {
    const events = [mkEvent(0, { x: 1, y: 1, w: 1, h: 1 }), mkEvent(5000, { x: 9, y: 9, w: 9, h: 9 })];
    expect(resolveFocusBounds(events, 4999)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    expect(resolveFocusBounds(events, 5000)).toEqual({ x: 9, y: 9, w: 9, h: 9 });
  });

  it("returns undefined when no focus_change with bounds precedes tMono", () => {
    expect(resolveFocusBounds([mkEvent(5000, { x: 9, y: 9, w: 9, h: 9 })], 1000)).toBeUndefined();
    expect(resolveFocusBounds([], 1000)).toBeUndefined();
  });

  it("skips a focus_change with no bounds, keeping the last one that had them", () => {
    const events = [mkEvent(0, { x: 1, y: 1, w: 1, h: 1 }), mkEvent(2000)]; // no bounds at 2000
    expect(resolveFocusBounds(events, 3000)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });

  it("tolerates out-of-order input (sorts defensively)", () => {
    const events = [mkEvent(5000, { x: 9, y: 9, w: 9, h: 9 }), mkEvent(0, { x: 1, y: 1, w: 1, h: 1 })];
    expect(resolveFocusBounds(events, 5000)).toEqual({ x: 9, y: 9, w: 9, h: 9 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/caption.test.ts -t "resolveFocusBounds"`
Expected: FAIL — the module doesn't exist.

- [ ] **Step 3: Create `src/represent/caption/focus-bounds.ts`**

```ts
/**
 * The focused window's bounds at-or-before a given t_mono, resolved from a
 * session's `focus_change` events — the same "environment facts resolved by
 * latest at-or-before" rule display topology and keymap resolution use
 * elsewhere. `focus_change.data.bounds` is already captured today
 * (ActiveWindowProducer), in the same global screen-coordinate space as AX and
 * region bboxes, so no capture-side change is needed for this.
 *
 * Returns undefined when no focus_change with bounds precedes tMono — many
 * apps never report window bounds at all, and that must stay distinguishable
 * from "the window moved off-screen" rather than defaulting to some box.
 */

import type { Box } from "../regions/geometry.js";
import type { EventRow } from "../../store/types.js";

export function resolveFocusBounds(
  focusEvents: readonly EventRow[],
  tMono: number,
): Box | undefined {
  const ordered = [...focusEvents].sort((a, b) => a.tMono - b.tMono);
  let best: Box | undefined;
  for (const ev of ordered) {
    if (ev.tMono > tMono) break;
    const bounds = (ev.data as { bounds?: Box } | null)?.bounds;
    if (bounds !== undefined) best = bounds;
  }
  return best;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/caption.test.ts -t "resolveFocusBounds"`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/represent/caption/focus-bounds.ts test/caption.test.ts
git commit -m "$(cat <<'EOF'
feat(caption): resolve focused-window bounds at-or-before a t_mono

Pure lookup over focus_change events, reusing the bounds already
captured by ActiveWindowProducer — no capture-side change needed. Feeds
the app_caption representer (next commit).
EOF
)"
```

---

### Task 8: `AppCaptionRepresenter` + shared `sample()` extraction

**Files:**
- Create: `src/represent/sample.ts`
- Create: `src/represent/caption/app-caption-representer.ts`
- Modify: `src/represent/caption/caption-representer.ts`
- Modify: `src/index.ts`
- Test: `test/caption.test.ts`

**Interfaces:**
- Consumes: `resolveFocusBounds` (Task 7), `Store.updateSegmentAppCaption`/`getAppCaption` (Task 6), `RegionCropper` (existing), `View` including `"app_caption"` (Task 6).
- Produces: `sample<T>(arr: T[], k: number): T[]`; `AppCaptionRepresenter` (mirrors `CaptionRepresenter`'s shape).

- [ ] **Step 1: Extract `sample()` into its own module**

Create `src/represent/sample.ts`:

```ts
/** Evenly sample up to `k` items from `arr` (first..last spread). */
export function sample<T>(arr: T[], k: number): T[] {
  if (arr.length <= k) return arr;
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    out.push(arr[Math.floor((i * (arr.length - 1)) / (k - 1))]!);
  }
  return out;
}
```

In `src/represent/caption/caption-representer.ts`, remove the local `sample<T>` function definition and its comment, and add an import instead:

```ts
import { sample } from "../sample.js";
```

(Keep every call site — `sample(segFrames, this.maxFrames)` — unchanged.)

- [ ] **Step 2: Run the existing caption tests to confirm the extraction didn't break anything**

Run: `npx vitest run test/caption.test.ts`
Expected: PASS (behavior-neutral refactor).

- [ ] **Step 3: Write the failing test for `AppCaptionRepresenter` in `test/caption.test.ts`**

Add these imports at the top of the file:

```ts
import { AppCaptionRepresenter } from "../src/represent/caption/app-caption-representer.js";
import type { RegionCropper } from "../src/represent/regions/cropper.js";
import type { Box } from "../src/represent/regions/geometry.js";
```

Add a new `describe` block:

```ts
describe("AppCaptionRepresenter (app_caption view)", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-appcap-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("captions the focused window's crop (using the resolved bounds), and skips a segment with no resolvable bounds — never falling back to the full frame", async () => {
    const sessionId = ulid();
    const mk = (t: number, kind: string, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind, ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mk(0, "mouse_move"),
      // Bounds arrive with the focus_change at 5000 — the EARLY segment's
      // frame (t=1000, before this event) has no prior focus_change at all.
      mk(5000, "focus_change", { app: "Calculator", bounds: { x: 10, y: 20, w: 300, h: 200 } }),
      mk(6000, "key_down"),
    ]);
    await store.endSession(sessionId, 9000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeGate({ hammingThreshold: 1 }), blobs);
    const frame = (t: number, gray: Uint8Array, img: Uint8Array): SampledFrame => ({
      tMono: t, width: 1000, height: 1000, gray, grayW: 9, grayH: 8, image: { bytes: img, codec: "png" },
    });
    await ing.ingest(frame(1000, grad(false), Uint8Array.from([1, 2, 3])));
    await ing.ingest(frame(6000, grad(true), Uint8Array.from([9, 8, 7])));

    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder: fake }).represent(sessionId);
    await new CaptionRepresenter(store, {
      captioner: new FakeCaptionProvider(),
      captionEmbedder: fake,
      blobStore: blobs,
    }).represent(sessionId);

    const seenBoxes: Box[] = [];
    const cropper: RegionCropper = {
      async crop(_img, _fw, _fh, box) {
        seenBoxes.push(box);
        return Uint8Array.from([1, 2, 3]);
      },
    };
    const rep = new AppCaptionRepresenter(store, {
      captioner: new FakeCaptionProvider(),
      captionEmbedder: fake,
      blobStore: blobs,
      cropper,
    });
    const result = await rep.represent(sessionId);
    expect(result.namespace).toBe("app_caption:fake:m:8");

    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 0)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;

    // Early segment's only frame (t=1000) precedes any focus_change with
    // bounds -> no app_caption at all, never a copy of the whole-frame caption.
    expect(early.caption).not.toBeNull(); // the whole-frame caption still exists
    expect(store.getAppCaption(early.id)).toBeUndefined();

    // Late segment's frame (t=6000) resolves to the Calculator bounds.
    expect(store.getAppCaption(late.id)).toBeDefined();
    expect(store.getAppCaption(late.id)).not.toBe(late.caption);
    expect(seenBoxes).toContainEqual({ x: 10, y: 20, w: 300, h: 200 });

    const rec = await store.reconcile();
    expect(rec.missing).toHaveLength(0);
    expect(rec.orphansPruned).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/caption.test.ts -t "AppCaptionRepresenter"`
Expected: FAIL — the module doesn't exist.

- [ ] **Step 5: Create `src/represent/caption/app-caption-representer.ts`**

```ts
/**
 * AppCaptionRepresenter (app_caption view) — the focused-window visual summary,
 * a SECOND signal alongside the whole-desktop caption (CaptionRepresenter). For
 * each segment, sample keyframes the same way CaptionRepresenter does, crop
 * each to the focused window's bounds (resolved from focus_change events,
 * latest at-or-before the frame's t_mono), caption the crops, and persist.
 *
 * A frame with no resolvable window bounds is dropped from the sample — never
 * falls back to the full frame, which would silently turn this into a copy of
 * `caption`. If no sampled frame in a segment has bounds, that segment gets no
 * app_caption row at all, the same "absence is meaningful" rule the rest of
 * the pipeline follows.
 */

import type { CaptionProvider, EmbeddingProvider } from "../../embed/types.js";
import { namespaceFor } from "../../embed/types.js";
import type { BlobStore } from "../../store/blob-store.js";
import type { EventRow, FrameRow, SegmentVectorInsert, Store } from "../../store/types.js";
import type { RegionCropper } from "../regions/cropper.js";
import type { Box } from "../regions/geometry.js";
import { sample } from "../sample.js";
import { resolveFocusBounds } from "./focus-bounds.js";

export interface AppCaptionRepresenterOptions {
  captioner: CaptionProvider;
  captionEmbedder: EmbeddingProvider;
  blobStore: BlobStore;
  cropper: RegionCropper;
  /** Keyframes sampled per segment for captioning. */
  maxFramesPerSegment?: number;
}

export interface AppCaptionRepresentResult {
  segmentCount: number;
  captionedCount: number;
  namespace: string;
}

export class AppCaptionRepresenter {
  private readonly captioner: CaptionProvider;
  private readonly captionEmbedder: EmbeddingProvider;
  private readonly blobStore: BlobStore;
  private readonly cropper: RegionCropper;
  private readonly maxFrames: number;
  readonly namespace: string;
  private spaceReady = false;

  constructor(
    private readonly store: Store,
    opts: AppCaptionRepresenterOptions,
  ) {
    this.captioner = opts.captioner;
    this.captionEmbedder = opts.captionEmbedder;
    this.blobStore = opts.blobStore;
    this.cropper = opts.cropper;
    this.maxFrames = opts.maxFramesPerSegment ?? 3;
    this.namespace = namespaceFor("app_caption", this.captionEmbedder);
  }

  async ensureSpace(): Promise<void> {
    if (this.spaceReady) return;
    await this.store.registerVectorSpace({
      namespace: this.namespace,
      view: "app_caption",
      providerId: this.captionEmbedder.id,
      model: this.captionEmbedder.model,
      dimensions: this.captionEmbedder.dimensions,
      sharedTextSpace: false,
    });
    this.spaceReady = true;
  }

  async represent(sessionId: string): Promise<AppCaptionRepresentResult> {
    await this.ensureSpace();
    const segments = this.store.getSegmentsBySession(sessionId);
    const frames = this.store.getFramesBySession(sessionId);
    if (segments.length === 0) {
      return { segmentCount: 0, captionedCount: 0, namespace: this.namespace };
    }
    const sessionEnd = Math.max(...segments.map((s) => s.tMonoEnd), 0);
    const focusEvents = this.store
      .getEventsBySession(sessionId)
      .filter((e): e is EventRow => e.kind === "focus_change");

    const captions: string[] = [];
    const segIds: string[] = [];
    for (const seg of segments) {
      const inclusiveRight = seg.tMonoEnd === sessionEnd;
      const segFrames = frames.filter(
        (f) =>
          f.blobId &&
          f.tMono >= seg.tMonoStart &&
          (inclusiveRight ? f.tMono <= seg.tMonoEnd : f.tMono < seg.tMonoEnd),
      );
      if (segFrames.length === 0) continue;

      const withBounds: { frame: FrameRow; bounds: Box }[] = [];
      for (const frame of sample(segFrames, this.maxFrames)) {
        const bounds = resolveFocusBounds(focusEvents, frame.tMono);
        if (bounds) withBounds.push({ frame, bounds });
      }
      if (withBounds.length === 0) continue; // never fall back to the full frame

      const crops: Uint8Array[] = [];
      for (const { frame, bounds } of withBounds) {
        const blob = this.store.getBlob(frame.blobId!);
        if (!blob) continue;
        const image = await this.blobStore.read(blob);
        crops.push(await this.cropper.crop(image, frame.width, frame.height, bounds));
      }
      if (crops.length === 0) continue;

      const caption = await this.captioner.caption(crops, seg.digest ?? undefined);
      await this.store.updateSegmentAppCaption(seg.id, caption); // SQLite text first
      captions.push(caption);
      segIds.push(seg.id);
    }

    if (captions.length > 0) {
      const vecs = await this.captionEmbedder.embed(captions);
      const rows: SegmentVectorInsert[] = segIds.map((id, i) => ({
        segmentId: id,
        sessionId,
        namespace: this.namespace,
        vector: vecs[i]!,
      }));
      await this.store.putSegmentVectors(rows);
    }

    return {
      segmentCount: segments.length,
      captionedCount: segIds.length,
      namespace: this.namespace,
    };
  }
}
```

- [ ] **Step 6: Export from the barrel**

In `src/index.ts`, add right after the existing `CaptionRepresenter` export block:

```ts
export {
  AppCaptionRepresenter,
  type AppCaptionRepresenterOptions,
  type AppCaptionRepresentResult,
} from "./represent/caption/app-caption-representer.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/caption.test.ts`
Expected: PASS (all describe blocks in the file).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/represent/sample.ts src/represent/caption/app-caption-representer.ts src/represent/caption/caption-representer.ts src/index.ts test/caption.test.ts
git commit -m "$(cat <<'EOF'
feat(caption): AppCaptionRepresenter — a focused-window caption view

Crops each sampled keyframe to the focused window's bounds (already
captured on focus_change, no capture-side change needed) before
captioning, storing the result as the new app_caption view. A frame
with no resolvable bounds is dropped rather than falling back to the
full frame, which would silently duplicate the existing caption view.

Also extracts the shared sample() helper out of CaptionRepresenter so
both representers use the same evenly-spread keyframe sampling.
EOF
)"
```

---

### Task 9: App wiring — Capabilities, indexing stage, retrieval

**Files:**
- Modify: `app/src/shared/types.ts`
- Modify: `app/src/main/deskrag-service.ts`
- Modify: `app/test/capabilities.test.ts`

**Interfaces:**
- Consumes: `AppCaptionRepresenter` (Task 8).
- Produces: `Capabilities.appCaption: boolean`.

- [ ] **Step 1: Add `appCaption` to `Capabilities`**

In `app/src/shared/types.ts`:

```ts
export interface Capabilities {
  imageSearch: boolean;
  caption: boolean;
  appCaption: boolean;
  rerank: boolean;
}
```

- [ ] **Step 2: Update the failing tests in `app/test/capabilities.test.ts`**

`appCaption` is gated on the identical condition as `caption` (`p.captionProvider !== "none"`), so every expected object in this file gains an `appCaption` field matching `caption`'s value. Replace the three `toEqual` calls:

```ts
  it("reports nothing enabled by default", () => {
    expect(capabilitiesFor(base)).toEqual({
      imageSearch: false,
      caption: false,
      appCaption: false,
      rerank: false,
    });
  });

  it("enables a capability on selection alone — local models need no credential", () => {
    const c = capabilitiesFor({
      ...base,
      imageProvider: "colsmol",
      captionProvider: "ollama",
      rerankProvider: "onnx",
    });
    expect(c).toEqual({ imageSearch: true, caption: true, appCaption: true, rerank: true });
  });

  it("keeps the three provider capabilities independent", () => {
    expect(capabilitiesFor({ ...base, imageProvider: "colsmol" })).toEqual({
      imageSearch: true,
      caption: false,
      appCaption: false,
      rerank: false,
    });
  });
```

And the whisper test's key list:

```ts
      expect(Object.keys(c).sort()).toEqual(["appCaption", "caption", "imageSearch", "rerank"]);
```

- [ ] **Step 3: Run the test to verify it fails, then update `capabilitiesFor`**

Run: `npx vitest run app/test/capabilities.test.ts` (from repo root; or `cd app && npx vitest run test/capabilities.test.ts`)
Expected: FAIL — `capabilitiesFor` doesn't set `appCaption` yet.

In `app/src/main/deskrag-service.ts`, update `capabilitiesFor`:

```ts
export function capabilitiesFor(p: ProviderSettingsView): Capabilities {
  return {
    imageSearch: p.imageProvider !== "none",
    caption: p.captionProvider !== "none",
    appCaption: p.captionProvider !== "none",
    rerank: p.rerankProvider !== "none",
    // No transcript member, deliberately — see Capabilities in shared/types.ts.
  };
}
```

Run: `npx vitest run app/test/capabilities.test.ts`
Expected: PASS.

- [ ] **Step 4: Import `AppCaptionRepresenter` and add the indexing stage**

In `app/src/main/deskrag-service.ts`, add `AppCaptionRepresenter` to the existing `from "deskrag"` import block (alongside `CaptionRepresenter`):

```ts
  AppCaptionRepresenter,
  CaptionRepresenter,
```

In `index()`, right after the existing `Captions` stage (`if (prov.captioner) { stages.push({ name: "Captions", ... }); }`), add a second stage inside the SAME `if (prov.captioner)` block:

```ts
    if (prov.captioner) {
      stages.push({
        name: "Captions",
        run: () =>
          new CaptionRepresenter(this.store, {
            captioner: prov.captioner!,
            captionEmbedder: prov.textEmbedder,
            blobStore: this.blobs,
          }).represent(sessionId),
      });
      stages.push({
        name: "App captions",
        // Needs a cropper too (sharp), unlike the whole-frame caption stage —
        // skip entirely rather than write nothing useful when it's unavailable.
        run: async () => {
          const cropper = await this.loadCropper();
          if (!cropper) return;
          await new AppCaptionRepresenter(this.store, {
            captioner: prov.captioner!,
            captionEmbedder: prov.textEmbedder,
            blobStore: this.blobs,
            cropper,
          }).represent(sessionId);
        },
      });
    }
```

- [ ] **Step 5: Wire `app_caption` into retrieval**

In `buildRetriever`, extend the view tuple:

```ts
    for (const view of ["digest", "caption", "app_caption", "transcript"] as const) {
```

In `search()`, extend both view tuples the same way:

```ts
    const hasCurrentTextSpace = (["digest", "caption", "app_caption", "transcript"] as const).some((view) =>
      registered.has(new TextViewSearcher(prov.textEmbedder, view).namespace),
    );
    const hasAnyTextSpace = this.store
      .listVectorSpaces()
      .some(
        (s) =>
          s.view === "digest" ||
          s.view === "caption" ||
          s.view === "app_caption" ||
          s.view === "transcript",
      );
```

- [ ] **Step 6: Typecheck the app**

Run: `npm --prefix app run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the app test suite**

Run: `cd app && npx vitest run` (or the project's equivalent app test command)
Expected: PASS.

- [ ] **Step 8: Build the library and the app to confirm the wiring compiles end-to-end**

Run: `npm run build && npm --prefix app run typecheck`
Expected: no errors (the app imports `dist/`, not `src/`, so the library must be rebuilt for the app's typecheck to see `AppCaptionRepresenter`).

- [ ] **Step 9: Run the full root suite once more**

Run: `npm test`
Expected: PASS — full green suite across every task in this plan.

- [ ] **Step 10: Commit**

```bash
git add app/src/shared/types.ts app/src/main/deskrag-service.ts app/test/capabilities.test.ts
git commit -m "$(cat <<'EOF'
feat(app): wire app_caption into indexing and search

New "App captions" stage runs alongside the existing caption stage
(same captionProvider gate, plus a cropper), and app_caption joins
digest/caption/transcript as a 4th Tier-1 text view. Capabilities
gains appCaption, gated identically to caption.
EOF
)"
```

---

### Task 10: Validate against a real recording

**Files:** none (manual verification, per this repo's own rule: both of its worst bugs — the AX role prefix and a stale sidecar — were invisible to `npm test` and obvious within minutes of driving a real session through the pipeline).

- [ ] **Step 1: Build and launch the app**

Run: `npm run build && npm run app:dev`

- [ ] **Step 2: Record a short multi-app session**

Record ~60-90s that switches between at least two applications (e.g. a text editor and Calculator, mirroring the session that motivated this plan), speaking a short sentence at some point for the transcript.

- [ ] **Step 3: Let indexing finish, then inspect the actual rows**

Find the session's `app.db` (dev data dir: `~/Library/Application Support/deskrag-app/DeskRAG/app.db`) and run:

```bash
sqlite3 app.db "SELECT granularity, t_mono_start, t_mono_end, boundary_reason FROM segment WHERE session_id = '<id>' ORDER BY granularity, t_mono_start;"
```

Confirm: `task` segments now cut at each app-focus change instead of one segment spanning the whole recording.

```bash
sqlite3 app.db "SELECT id, transcript FROM segment WHERE session_id = '<id>' AND transcript IS NOT NULL ORDER BY t_mono_start;"
```

Confirm: adjacent segments no longer repeat the same sentence verbatim (some legitimate overlap in wording across truly adjacent speech is fine; a straddled blob's FULL text appearing twice is the bug this plan fixes).

```bash
sqlite3 app.db "SELECT s.id, s.caption, a.text FROM segment s JOIN segment_app_caption a ON a.segment_id = s.id WHERE s.session_id = '<id>';"
```

Confirm: `app_caption` text differs from the whole-desktop `caption` text for the same segment, and describes the focused app's window content specifically.

- [ ] **Step 4: Search**

In the app's search screen, run a text query matching something said or visible only in one app's window (e.g. a value shown only inside Calculator). Confirm results surface it — this exercises the new `app_caption` Tier-1 view end to end, not just its unit tests.

- [ ] **Step 5: Note findings**

If anything measured here contradicts an assumption in this plan (e.g. burst_gap firing too eagerly/rarely on real input, or the adaptive task clamp feeling wrong at real session lengths), record it — per this repo's convention, treat any number derived from one recording as provisional and adjust the relevant constant (`DEFAULT_BURST_GAP_MS`, the `[30_000, 180_000]` clamp) in a follow-up commit rather than in this validation step.

No commit for this task — it's verification, not code.
