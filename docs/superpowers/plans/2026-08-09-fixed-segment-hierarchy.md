# Fixed Segment Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the emergent recursive levels with exactly three composed levels — Task, Process, Session purpose — each with its own prompt and its own admission test.

**Architecture:** A fixed `LEVELS` table drives one bounded loop in place of `while (children.length > 1)`. A level that fails admission is never created and the level above adopts its children; a node that would hold one child is elided, so the tree stops being level-uniform and `composeLadder` returns an explicit node graph rather than per-level index ranges. Every measured piece of machinery — block splitting, cut-point parsing, wholesale rejection, the structural fallback, the compositional rollup — is reused untouched.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, better-sqlite3, LanceDB, Electron + React, Ollama.

**Spec:** `docs/superpowers/specs/2026-08-09-fixed-segment-hierarchy-design.md`

## Global Constraints

- **Exactly three composed levels**: `level:1` Task, `level:2` Process, `session` Session purpose. Never a fourth.
- **Level admission:** a level exists only if **≥1 node holds ≥2 children AND the level has fewer nodes than the one below**. Otherwise it is never created and the level above adopts its children.
- **Single-child nodes are ELIDED** — the grandparent adopts the child, so a `segment_tree` edge may span two levels. **The ROOT is exempt.**
- **Process is MODEL-ONLY.** No structural fallback for `level:2`. Without a summarizer the hierarchy is Action → Task → Session.
- **Reused untouched** (each cost a measurement): `splitIntoBlocks` at cap 24, `validatePartition`, wholesale rejection, the CUT-POINT contract, the compositional rollup above level 1, `think: false`, reading `message.thinking` as well as `message.content`.
- **`src/segment/` stays a leaf.** It sees only `SegEvent`; all of this lives in `src/represent/compose/`.
- **Pure cores are `.ts` and root-tested.** The root `tsconfig.json` sets no `jsx`; a root test reaching into a `.tsx` breaks `npm run typecheck`.
- **`grep` silently skips `src/store/store.ts`** (two deliberate NUL bytes). Use `grep -a`.
- **The app BUNDLES the library.** After changing library code run **both** `npm run build` and `npm --prefix app run build`, or the app runs stale code. This exact mistake produced a false "the grouping got worse" report.
- **Gates:** `npm run typecheck`, `npm test`, `npm --prefix app run typecheck`. All must pass before every commit.
- **Known-failing, not yours:** `test/ax-swift.test.ts › exits 0 and prints a walk object when run directly` fails when the runner lacks Accessibility permission. Untouched by this work.

---

## File Structure

**Modify:**
- `src/represent/compose/prompt.ts` — `TASK_SYSTEM`, `PROCESS_SYSTEM`; `composePrompt(children, kind)`.
- `src/embed/summary.ts` — `ComposeContext.kind` replaces `{ level, single }`; update `FakeSummaryProvider`.
- `src/embed/ollama-summary.ts` — map `kind` → system prompt.
- `src/represent/compose/types.ts` — `LevelKind`, `LadderChild`, `LadderNode`, `Ladder`, `ComposeFn`.
- `src/represent/compose/levels.ts` — `LEVELS`, `composeLadder`; delete `composeLevels`, `MAX_DEPTH`.
- `src/represent/compose/compose-representer.ts` — drive the ladder; `nameRoot` folds into it.
- `src/index.ts` — barrel exports.
- `app/src/main/session-tracks.ts` — `levelTitle`, the empty PROCESS lane.
- `CLAUDE.md`, the two specs.

**Test:** `test/compose.levels.test.ts` (rewritten), `test/compose.prompt.test.ts`, `test/compose.representer.test.ts`, `test/session-tracks.test.ts`, `test/summary.ollama.test.ts`.

---

### Task 1: Three prompts, one per question

**Files:**
- Modify: `src/represent/compose/prompt.ts`
- Test: `test/compose.prompt.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LevelKind = "task" | "process" | "session";   // re-exported from types.ts
  export const TASK_SYSTEM: string;
  export const PROCESS_SYSTEM: string;
  export const NAME_SYSTEM: string;                          // unchanged
  export function composePrompt(children: readonly ChildSummary[], kind: LevelKind): string;
  export function systemFor(kind: LevelKind): string;
  ```
- `COMPOSE_SYSTEM` is REMOVED — every call site now picks by `kind`.

- [ ] **Step 1: Write the failing test**

Replace the `composePrompt` describe block in `test/compose.prompt.test.ts` with:

```ts
describe("composePrompt", () => {
  it("asks for TASKS from actions — a verb and an object", () => {
    const p = composePrompt([kid(0, "clicked 7"), kid(1, "clicked +")], "task");
    expect(p).toContain("0. [Calculator] clicked 7");
    expect(p).toContain("1. [Calculator] clicked +");
    expect(p).toMatch(/action/i);
  });

  it("asks for PHASES from tasks, which is a different question", () => {
    const p = composePrompt([kid(0, "Start calculator"), kid(1, "Copy result")], "process");
    expect(p).toMatch(/phase/i);
    // The word that made every level identical must not appear.
    expect(p).not.toMatch(/already-grouped activities/i);
  });

  it("asks for ONE NAME at the session, not a split", () => {
    const p = composePrompt([kid(0, "a"), kid(1, "b")], "session");
    expect(p).toMatch(/name the session/i);
  });

  it("collapses whitespace so a multi-line caption stays ONE step", () => {
    expect(composePrompt([kid(0, "a\n\n  b")], "task")).toContain("0. [Calculator] a b");
  });

  it("omits the bracket when the app is unknown", () => {
    expect(composePrompt([kid(0, "something", null)], "task")).toContain("0. something");
  });
});

describe("systemFor", () => {
  it("gives each kind its own system prompt", () => {
    const three = [systemFor("task"), systemFor("process"), systemFor("session")];
    expect(new Set(three).size).toBe(3);
  });

  it("keeps the cut-point contract in every grouping prompt", () => {
    for (const kind of ["task", "process"] as const) {
      const s = systemFor(kind);
      expect(s).toContain('"start"');
      // Naming where a run ENDS is the one thing the model got wrong.
      expect(s).toMatch(/never state where a run ends|until the next one begins/i);
    }
  });

  it("asks the session prompt for exactly one entry", () => {
    expect(systemFor("session")).toMatch(/exactly one/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.prompt.test.ts`
Expected: FAIL — `systemFor is not exported`, and `composePrompt` still takes `(children, level, single)`.

- [ ] **Step 3: Rewrite the prompts**

In `src/represent/compose/prompt.ts`, delete `COMPOSE_SYSTEM` and add:

```ts
/** The cut-point contract, shared by every GROUPING prompt. */
const CUT_POINTS =
  'Reply with JSON only: {"groups":[{"start":0,"summary":"..."},{"start":5,"summary":"..."}]} ' +
  "where `start` is the step number a run BEGINS at. The first run must start at " +
  "0. Each run continues until the next one begins, so you never state where a " +
  "run ends. If every step belongs to ONE run, reply with a single run starting " +
  "at 0. No preamble.";

/**
 * LEVEL 1 — actions into TASKS.
 *
 * This level already works: measured across five recordings of one task it
 * produced six or seven semantically parallel tasks every time, with the
 * calculator work as one 14-19 action task in all five. The wording is the
 * former COMPOSE_SYSTEM, narrowed to actions.
 */
export const TASK_SYSTEM =
  "You group a user's recorded desktop ACTIONS into the tasks they compose. " +
  "You are given an ordered, numbered list of consecutive actions. Split it into " +
  "contiguous runs, where each run is the smallest stretch you could name as a " +
  "verb and an object — 'copy the result', 'start the calculator'. Name each run " +
  "in one short phrase stating the GOAL, not what was on screen. " +
  CUT_POINTS;

/**
 * LEVEL 2 — tasks into PHASES.
 *
 * A DIFFERENT question, which is the whole point of the fixed ladder. Asking
 * "group these into larger ones" at every altitude is what produced levels that
 * differed in size but not in kind — fan-out 1.6 by level 3, and 21 of 60
 * parents holding a single child.
 */
export const PROCESS_SYSTEM =
  "You group a user's recorded TASKS into the phases of work they form. A phase " +
  "is a stretch of tasks serving one outcome — setting something up, doing the " +
  "work, recording the result. You are given an ordered, numbered list of tasks. " +
  "Split it into contiguous phases and name each in one short phrase stating the " +
  "outcome it serves. If the tasks are all one phase, say so with a single run. " +
  CUT_POINTS;

export function systemFor(kind: LevelKind): string {
  switch (kind) {
    case "task":
      return TASK_SYSTEM;
    case "process":
      return PROCESS_SYSTEM;
    case "session":
      return NAME_SYSTEM;
  }
}
```

Replace `composePrompt`:

```ts
export function composePrompt(
  children: readonly ChildSummary[],
  kind: LevelKind,
): string {
  const lines = children.map((c, i) => {
    const app = c.app === null ? "" : `[${c.app}] `;
    // Collapse whitespace: a VLM caption can be several lines, and a step that
    // spans lines would look like several steps to the model.
    return `${i}. ${app}${c.text.replace(/\s+/g, " ").trim()}`;
  });
  if (kind === "session") {
    return `These ${children.length} activities are all part of one session.\nName the session.\n\n${lines.join("\n")}`;
  }
  const what =
    kind === "task"
      ? `These are individual actions.\nPartition these ${children.length} actions.`
      : `These are tasks the user performed.\nSplit these ${children.length} tasks into phases.`;
  return `${what}\n\n${lines.join("\n")}`;
}
```

Add the import: `import type { ChildSummary, ComposeGroup, LevelKind } from "./types.js";`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose.prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/represent/compose/prompt.ts test/compose.prompt.test.ts
git commit -m "feat(compose): one prompt per level, replacing the shared COMPOSE_SYSTEM"
```

---

### Task 2: `ComposeContext.kind`

**Files:**
- Modify: `src/represent/compose/types.ts`, `src/embed/summary.ts`, `src/embed/ollama-summary.ts`
- Test: `test/summary.ollama.test.ts`

**Interfaces:**
- Consumes: `systemFor`, `composePrompt(children, kind)` (Task 1).
- Produces:
  ```ts
  // types.ts
  export type LevelKind = "task" | "process" | "session";
  // summary.ts
  export interface ComposeContext { kind: LevelKind }
  ```
- `ComposeContext.level` and `ComposeContext.single` are REMOVED.

- [ ] **Step 1: Write the failing test**

In `test/summary.ollama.test.ts`, replace every `{ level: 1 }` with `{ kind: "task" }` and every `{ level: N, single: true }` with `{ kind: "session" }`, then add:

```ts
  it("sends the PHASE prompt for a process, not the task one", async () => {
    let body: unknown;
    const capturing = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '{"groups":[{"start":0,"summary":"x"}]}' },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    await new OllamaSummaryProvider({ model: "m", fetchImpl: capturing }).compose(kids, {
      kind: "process",
    });
    const sys = (body as { messages: { content: string }[] }).messages[0]!.content;
    expect(sys).toMatch(/phase/i);
  });

  it("sends a DIFFERENT system prompt for each kind", async () => {
    const seen: string[] = [];
    const capturing = (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).messages[0].content);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '{"groups":[{"start":0,"summary":"x"}]}' },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const p = new OllamaSummaryProvider({ model: "m", fetchImpl: capturing });
    for (const kind of ["task", "process", "session"] as const) {
      await p.compose(kids, { kind });
    }
    expect(new Set(seen).size).toBe(3);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/summary.ollama.test.ts`
Expected: FAIL — `ComposeContext` has no `kind`.

- [ ] **Step 3: Change the context**

In `src/represent/compose/types.ts`, add near the top:

```ts
/**
 * WHICH question a compose call is asking.
 *
 * Semantic rather than numeric, so the provider interface carries meaning and a
 * future adapter can phrase each kind however its model prefers. It replaced
 * `{ level: number, single?: boolean }`, which could not express three distinct
 * prompts.
 */
export type LevelKind = "task" | "process" | "session";
```

In `src/embed/summary.ts`, replace `ComposeContext` wholesale:

```ts
export interface ComposeContext {
  /** WHICH question this call asks — the adapter maps it to a system prompt. */
  kind: LevelKind;
}
```

Import it: `import type { ChildSummary, ComposeGroup, LevelKind } from "../represent/compose/types.js";`

Update `FakeSummaryProvider.compose`'s signature to `(children: readonly ChildSummary[], _ctx: ComposeContext)` — the body is unchanged.

In `src/embed/ollama-summary.ts`, replace the two prompt lines:

```ts
        messages: [
          { role: "system", content: systemFor(ctx.kind) },
          { role: "user", content: composePrompt(children, ctx.kind) },
        ],
```

and the import: `import { composePrompt, parseComposeResponse, systemFor } from "../represent/compose/prompt.js";`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/summary.ollama.test.ts && npm run typecheck`
Expected: the ollama tests PASS. `typecheck` still FAILS in `levels.ts`/`compose-representer.ts`, which Tasks 3–5 fix — that is expected at this point.

- [ ] **Step 5: Commit**

```bash
git add src/represent/compose/types.ts src/embed/summary.ts src/embed/ollama-summary.ts test/summary.ollama.test.ts
git commit -m "feat(embed): ComposeContext carries a semantic kind, not a level number"
```

---

### Task 3: The ladder's node graph and admission rules

**Files:**
- Modify: `src/represent/compose/types.ts`
- Create: `src/represent/compose/admission.ts`
- Test: `test/compose.admission.test.ts`

**Interfaces:**
- Consumes: `Block`, `ChildSummary` from `types.ts`.
- Produces:
  ```ts
  // types.ts
  export type LadderChild = { kind: "leaf"; index: number } | { kind: "node"; index: number };
  export interface LadderNode {
    granularity: string;            // "level:1" | "level:2" | "session"
    children: LadderChild[];
    summary: string;
    source: SummarySource;
  }
  /** Topologically ordered: a node's children always precede it. Root is last. */
  export interface Ladder { nodes: LadderNode[] }
  // admission.ts
  export function levelQualifies(groupSizes: readonly number[], below: number): boolean;
  export const LEVEL_GRANULARITY: Record<LevelKind, string>;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/compose.admission.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LEVEL_GRANULARITY, levelQualifies } from "../src/represent/compose/admission.js";

describe("levelQualifies", () => {
  it("requires at least one node holding 2+ children", () => {
    // Six tasks that each became their own process is not a level.
    expect(levelQualifies([1, 1, 1, 1, 1, 1], 6)).toBe(false);
    expect(levelQualifies([2, 1, 1], 4)).toBe(true);
  });

  it("requires strictly fewer nodes than the level below", () => {
    expect(levelQualifies([2, 2], 4)).toBe(true);
    expect(levelQualifies([2, 1, 1], 4)).toBe(true);
    // Same count as below: nothing was composed.
    expect(levelQualifies([2, 1, 1, 1], 4)).toBe(false);
  });

  it("rejects an empty level", () => {
    expect(levelQualifies([], 4)).toBe(false);
  });

  it("accepts a single node that swallows everything", () => {
    // One phase covering six tasks IS a level — it says the recording was one
    // phase, which is a real answer.
    expect(levelQualifies([6], 6)).toBe(true);
  });
});

describe("LEVEL_GRANULARITY", () => {
  it("maps each kind to the granularity stored on the row", () => {
    expect(LEVEL_GRANULARITY.task).toBe("level:1");
    expect(LEVEL_GRANULARITY.process).toBe("level:2");
    expect(LEVEL_GRANULARITY.session).toBe("session");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.admission.test.ts`
Expected: FAIL — cannot resolve `admission.js`.

- [ ] **Step 3: Add the types**

In `src/represent/compose/types.ts`, append:

```ts
/**
 * A reference from a ladder node to one of its children.
 *
 * TAGGED because the tree is NOT level-uniform: a node whose only child was
 * elided points at that child directly, so a `level:2` node may hold a
 * `level:1` node or even a leaf. `getDescendantLeaves` walks to leaves and
 * `collapseAncestors` walks children, so neither notices.
 */
export type LadderChild =
  | { kind: "leaf"; index: number }
  | { kind: "node"; index: number };

export interface LadderNode {
  /** The row's `granularity`: "level:1" | "level:2" | "session". */
  granularity: string;
  children: LadderChild[];
  summary: string;
  source: SummarySource;
}

/**
 * The composed tree as an explicit graph.
 *
 * Replaces the old per-level `ComposedLevel[]` with its index ranges, which
 * could only describe a UNIFORM tree — every node's children exactly one level
 * down. Elision breaks that, so the shape has to say which child it means.
 *
 * Topologically ordered: a node's children always precede it, and the ROOT is
 * last, so a single forward pass can mint ids.
 */
export interface Ladder {
  nodes: LadderNode[];
}
```

- [ ] **Step 4: Write `admission.ts`**

Create `src/represent/compose/admission.ts`:

```ts
/**
 * Whether a composed level earns its existence.
 *
 * Pure and separate from the ladder so the rule can be read and tested on its
 * own — it is the fix for the measured defect, where 21 of 60 parents held a
 * single child and fan-out collapsed to 1.6 by level 3.
 */

import type { LevelKind } from "./types.js";

/** The `granularity` written on a row, per level. */
export const LEVEL_GRANULARITY: Record<LevelKind, string> = {
  task: "level:1",
  process: "level:2",
  session: "session",
};

/**
 * A level exists only if it actually composed something.
 *
 * Two conditions, and both are needed. At least one node must hold 2+ children,
 * or the "level" is a relabelling of the one below. And the level must be
 * strictly smaller, or nothing was composed at all.
 *
 * A single node swallowing everything PASSES: "this recording was one phase" is
 * a real answer, not a degenerate one.
 */
export function levelQualifies(groupSizes: readonly number[], below: number): boolean {
  if (groupSizes.length === 0) return false;
  if (groupSizes.length >= below) return false;
  return groupSizes.some((n) => n >= 2);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/compose.admission.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/represent/compose/types.ts src/represent/compose/admission.ts test/compose.admission.test.ts
git commit -m "feat(compose): level admission rule and the ladder node graph"
```

---

### Task 4: `composeLadder`

**Files:**
- Modify: `src/represent/compose/levels.ts` (replaces `composeLevels`)
- Test: `test/compose.levels.test.ts` (rewritten)

**Interfaces:**
- Consumes: `splitIntoBlocks`, `structuralRanges`, `validatePartition`, `DEFAULT_BATCH_CAP` (unchanged); `rollupText`; `levelQualifies`, `LEVEL_GRANULARITY` (Task 3); `Ladder`, `LadderNode`, `LadderChild`, `LevelKind` (Task 3).
- Produces:
  ```ts
  export type ComposeFn = (
    children: readonly ChildSummary[],
    kind: LevelKind,
  ) => Promise<ComposeGroup[]>;
  export interface ComposeLadderOptions { compose?: ComposeFn; batchCap?: number }
  export function composeLadder(
    leaves: readonly ChildSummary[],
    opts?: ComposeLadderOptions,
  ): Promise<Ladder>;
  export const LEVELS: readonly { kind: LevelKind; modelOnly: boolean }[];
  ```
- `composeLevels`, `MAX_DEPTH`, `ComposeLevelsOptions`, `Partitioner` are REMOVED.

- [ ] **Step 1: Write the failing test**

Replace `test/compose.levels.test.ts` entirely:

```ts
import { describe, expect, it } from "vitest";
import { composeLadder } from "../src/represent/compose/levels.js";
import type { ChildSummary, ComposeGroup, Ladder, LevelKind } from "../src/represent/compose/types.js";

function leaves(n: number, over: (i: number) => Partial<ChildSummary> = () => ({})) {
  return Array.from(
    { length: n },
    (_, i): ChildSummary => ({
      index: i, text: `action ${i}`, app: "Calculator", url: null,
      startSec: i, endSec: i + 1, barrier: false, ...over(i),
    }),
  );
}

const grans = (l: Ladder): string[] => l.nodes.map((n) => n.granularity);
const root = (l: Ladder) => l.nodes[l.nodes.length - 1]!;

/** Groups children into runs of `size`, naming each. */
const chunk =
  (size: number) =>
  async (children: readonly ChildSummary[], kind: LevelKind): Promise<ComposeGroup[]> => {
    if (kind === "session") return [{ start: 0, end: children.length, summary: "the session" }];
    const out: ComposeGroup[] = [];
    for (let i = 0; i < children.length; i += size) {
      out.push({ start: i, end: Math.min(i + size, children.length), summary: `${kind} ${i}` });
    }
    return out;
  };

describe("composeLadder", () => {
  it("produces AT MOST three composed levels, whatever the input", async () => {
    const l = await composeLadder(leaves(200), { compose: chunk(2) });
    const kinds = new Set(grans(l));
    expect([...kinds].every((g) => ["level:1", "level:2", "session"].includes(g))).toBe(true);
  });

  it("builds Task, Process and Session when both levels qualify", async () => {
    const l = await composeLadder(leaves(16), { compose: chunk(2) });
    expect(grans(l)).toContain("level:1");
    expect(grans(l)).toContain("level:2");
    expect(root(l).granularity).toBe("session");
  });

  it("orders nodes topologically — a child always precedes its parent", async () => {
    const l = await composeLadder(leaves(16), { compose: chunk(2) });
    l.nodes.forEach((n, i) => {
      for (const c of n.children) if (c.kind === "node") expect(c.index).toBeLessThan(i);
    });
  });

  it("SKIPS a level that does not shrink, and the level above adopts its children", async () => {
    // One group per task at the process level: no shrink, so no level:2 at all.
    const noProcess = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "s" }];
      if (kind === "process")
        return children.map((_, i) => ({ start: i, end: i + 1, summary: `p${i}` }));
      return chunk(2)(children, kind);
    };
    const l = await composeLadder(leaves(8), { compose: noProcess });
    expect(grans(l)).not.toContain("level:2");
    // The root adopted the TASKS directly.
    expect(root(l).children.length).toBeGreaterThan(1);
    for (const c of root(l).children) {
      expect(c.kind === "node" && l.nodes[c.index]!.granularity === "level:1").toBe(true);
    }
  });

  it("SKIPS a level whose every node holds one child", async () => {
    const onePer = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "s" }];
      return children.map((_, i) => ({ start: i, end: i + 1, summary: `x${i}` }));
    };
    const l = await composeLadder(leaves(6), { compose: onePer });
    // Neither composed level qualifies, so the root adopts the ACTIONS.
    expect(grans(l)).toEqual(["session"]);
    expect(root(l).children.every((c) => c.kind === "leaf")).toBe(true);
  });

  it("ELIDES a single-child node — the grandparent adopts the child", async () => {
    // Level 1 pairs; level 2 leaves the last task alone.
    const lonely = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "s" }];
      if (kind === "process")
        return [
          { start: 0, end: children.length - 1, summary: "phase" },
          { start: children.length - 1, end: children.length, summary: "alone" },
        ];
      return chunk(2)(children, kind);
    };
    const l = await composeLadder(leaves(12), { compose: lonely });
    // No node anywhere holds exactly one child...
    for (const n of l.nodes) {
      if (n.granularity === "session") continue;
      expect(n.children.length).toBeGreaterThan(1);
    }
    // ...and the lone task was adopted by the root, so an edge spans two levels.
    const adopted = root(l).children.filter(
      (c) => c.kind === "node" && l.nodes[c.index]!.granularity === "level:1",
    );
    expect(adopted.length).toBe(1);
  });

  it("the ROOT is exempt from elision — one child is correct there", async () => {
    const oneProcess = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "the whole thing" }];
      if (kind === "process") return [{ start: 0, end: children.length, summary: "one phase" }];
      return chunk(2)(children, kind);
    };
    const l = await composeLadder(leaves(8), { compose: oneProcess });
    expect(root(l).granularity).toBe("session");
    expect(root(l).children).toHaveLength(1);
    expect(root(l).summary).toBe("the whole thing");
  });

  it("PROCESS IS MODEL-ONLY — no summarizer means no level:2", async () => {
    const l = await composeLadder(leaves(12));
    expect(grans(l)).toContain("level:1");
    expect(grans(l)).not.toContain("level:2");
    expect(root(l).granularity).toBe("session");
  });

  it("still builds TASKS structurally with no summarizer", async () => {
    const l = await composeLadder(leaves(12));
    const tasks = l.nodes.filter((n) => n.granularity === "level:1");
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((n) => n.source === "template")).toBe(true);
  });

  it("rejects a malformed partition WHOLESALE and falls back structurally", async () => {
    const broken = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "s" }];
      // A gap: neither the ranges nor the names may survive.
      return [
        { start: 0, end: 2, summary: "a" },
        { start: 3, end: children.length, summary: "b" },
      ];
    };
    const l = await composeLadder(leaves(8), { compose: broken });
    const tasks = l.nodes.filter((n) => n.granularity === "level:1");
    expect(tasks.every((n) => n.source === "template")).toBe(true);
    expect(tasks.map((n) => n.summary)).not.toContain("a");
  });

  it("never fails the run when the model throws", async () => {
    const boom = async (): Promise<ComposeGroup[]> => {
      throw new Error("ollama is not running");
    };
    const l = await composeLadder(leaves(8), { compose: boom });
    expect(root(l).granularity).toBe("session");
    expect(root(l).source).toBe("template");
  });

  it("returns an empty ladder for no leaves", async () => {
    expect((await composeLadder([])).nodes).toEqual([]);
  });

  it("gives a single leaf a root of its own", async () => {
    const l = await composeLadder(leaves(1), { compose: chunk(2) });
    expect(root(l).granularity).toBe("session");
    expect(root(l).children).toEqual([{ kind: "leaf", index: 0 }]);
  });

  it("never merges across a barrier", async () => {
    const kids = leaves(8, (i) => (i === 4 ? { barrier: true } : {}));
    const l = await composeLadder(kids, { compose: chunk(8) });
    const leafIdx = (n: { children: { kind: string; index: number }[] }) =>
      n.children.filter((c) => c.kind === "leaf").map((c) => c.index);
    for (const n of l.nodes) {
      if (n.granularity !== "level:1") continue;
      const idx = leafIdx(n);
      // No task may contain leaves from both sides of the bookmark.
      expect(idx.some((i) => i < 4) && idx.some((i) => i >= 4)).toBe(false);
    }
  });

  it("is translation invariant", async () => {
    const base = leaves(12);
    const shifted = base.map((c) => ({
      ...c, startSec: c.startSec + 4242.4242, endSec: c.endSec + 4242.4242,
    }));
    expect(await composeLadder(shifted)).toEqual(await composeLadder(base));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.levels.test.ts`
Expected: FAIL — `composeLadder is not exported`.

- [ ] **Step 3: Write `composeLadder`**

Replace the body of `src/represent/compose/levels.ts` below the imports:

```ts
/**
 * The FIXED ladder: actions -> tasks -> phases -> one root.
 *
 * Three levels, never more, each asking its OWN question. It replaced a
 * recursion whose levels differed in SIZE but not in KIND — measured across
 * five real recordings, fan-out collapsed to 1.6 by level 3 and 21 of 60
 * parents held a single child, half of those repeating that child's name.
 *
 * Pure. The model arrives as an injected `ComposeFn`, so this file has no
 * provider, no store and no I/O.
 */

/** The ladder, in order. `modelOnly` levels do not fall back structurally. */
export const LEVELS: readonly { kind: LevelKind; modelOnly: boolean }[] = [
  { kind: "task", modelOnly: false },
  // A phase is a SEMANTIC judgment. Halving tasks into positional pairs is not
  // one, so without a model there is simply no Process level — the hierarchy is
  // Action -> Task -> Session, which is still complete.
  { kind: "process", modelOnly: true },
];

export type ComposeFn = (
  children: readonly ChildSummary[],
  kind: LevelKind,
) => Promise<ComposeGroup[]>;

export interface ComposeLadderOptions {
  compose?: ComposeFn;
  batchCap?: number;
}

export async function composeLadder(
  leaves: readonly ChildSummary[],
  opts: ComposeLadderOptions = {},
): Promise<Ladder> {
  if (leaves.length === 0) return { nodes: [] };
  const cap = opts.batchCap ?? DEFAULT_BATCH_CAP;
  const nodes: LadderNode[] = [];

  /** The current frontier: what the next level would compose. */
  let frontier: { ref: LadderChild; child: ChildSummary }[] = leaves.map((c, i) => ({
    ref: { kind: "leaf", index: i },
    child: { ...c, index: i },
  }));

  for (const level of LEVELS) {
    if (frontier.length < 2) break;
    const children = frontier.map((f, i) => ({ ...f.child, index: i }));
    const groups = await composeOneLevel(children, level, cap, opts.compose);
    if (groups === undefined) continue; // model-only level with no model

    if (!levelQualifies(groups.map((g) => g.range.end - g.range.start), frontier.length)) {
      // Never created. The level above adopts this frontier unchanged.
      continue;
    }

    const next: typeof frontier = [];
    for (const g of groups) {
      const members = frontier.slice(g.range.start, g.range.end);
      // ELIDED: a lone child is adopted by the level above rather than wrapped
      // in a node that could only restate it.
      if (members.length === 1) {
        next.push(members[0]!);
        continue;
      }
      nodes.push({
        granularity: LEVEL_GRANULARITY[level.kind],
        children: members.map((m) => m.ref),
        summary: g.summary,
        source: g.source,
      });
      next.push({
        ref: { kind: "node", index: nodes.length - 1 },
        child: liftChild(members.map((m) => m.child), children),
      });
    }
    frontier = next;
  }

  // The ROOT always exists and is exempt from elision: it answers a different
  // question from its child rather than restating it.
  nodes.push(await makeRoot(frontier, opts.compose));
  return { nodes };
}
```

Add these helpers below it:

```ts
/** A group as the ladder needs it: a range plus who named it. */
interface LevelGroup {
  range: Block;
  summary: string;
  source: SummarySource;
}

/**
 * One level's groups, or `undefined` when a model-only level has no model.
 *
 * Blocks, validation, wholesale rejection and the structural fallback are all
 * unchanged — every one of them cost a measurement.
 */
async function composeOneLevel(
  children: readonly ChildSummary[],
  level: { kind: LevelKind; modelOnly: boolean },
  cap: number,
  compose: ComposeFn | undefined,
): Promise<LevelGroup[] | undefined> {
  if (level.modelOnly && compose === undefined) return undefined;
  const out: LevelGroup[] = [];
  for (const block of splitIntoBlocks(children, cap)) {
    const size = block.end - block.start;
    let accepted: LevelGroup[] | undefined;

    if (compose !== undefined && size > 1) {
      const slice = children.slice(block.start, block.end).map((c, i) => ({ ...c, index: i }));
      let groups;
      try {
        groups = await compose(slice, level.kind);
      } catch {
        // Composing NEVER fails the run.
        groups = undefined;
      }
      const shifted = groups?.map((g) => ({
        start: g.start + block.start,
        end: g.end + block.start,
        summary: g.summary,
      }));
      if (
        shifted !== undefined &&
        validatePartition(shifted, block.start, block.end) &&
        shifted.length < size
      ) {
        accepted = shifted.map((g) => ({
          range: { start: g.start, end: g.end },
          summary:
            g.summary.trim().length > 0
              ? g.summary.trim()
              : rollupText(children, { start: g.start, end: g.end }, levelNumber(level.kind)),
          source: "llm" as const,
        }));
      }
      // Rejected WHOLESALE — not repaired. Nothing the model said survives.
    }

    if (accepted === undefined) {
      // A model-only level gets no structural groups at all: returning the
      // block unchanged means it cannot qualify, so the level is skipped.
      if (level.modelOnly) return undefined;
      accepted = structuralRanges(children, block).map((r) => ({
        range: r,
        summary: rollupText(children, r, levelNumber(level.kind)),
        source: "template" as const,
      }));
    }
    out.push(...accepted);
  }
  return out;
}

/** `rollupText` still keys on a level NUMBER: level 1 tallies, above it composes. */
function levelNumber(kind: LevelKind): number {
  return kind === "task" ? 1 : 2;
}

/** The root: one call asking what the whole recording was for. */
async function makeRoot(
  frontier: readonly { ref: LadderChild; child: ChildSummary }[],
  compose: ComposeFn | undefined,
): Promise<LadderNode> {
  const children = frontier.map((f, i) => ({ ...f.child, index: i }));
  const fallback = rollupText(children, { start: 0, end: children.length }, 2);
  if (compose !== undefined) {
    try {
      const groups = await compose(children, "session");
      const text = groups[0]?.summary.trim();
      if (text !== undefined && text.length > 0) {
        return {
          granularity: LEVEL_GRANULARITY.session,
          children: frontier.map((f) => f.ref),
          summary: text,
          source: "llm",
        };
      }
    } catch {
      // Falls through to the rollup: the root still exists and still says
      // `template`, so a root nothing named discloses it.
    }
  }
  return {
    granularity: LEVEL_GRANULARITY.session,
    children: frontier.map((f) => f.ref),
    summary: fallback,
    source: "template",
  };
}

/** Turn a composed group into a child of the level above it. */
function liftChild(members: readonly ChildSummary[], all: readonly ChildSummary[]): ChildSummary {
  void all;
  const first = members[0]!;
  const last = members[members.length - 1]!;
  // One app only when EVERY member agrees: a parent spanning two applications
  // is not "in" either, and claiming one would feed a false signal upward.
  const app = members.every((c) => c.app === first.app) ? first.app : null;
  const url = members.every((c) => c.url === first.url) ? first.url : null;
  return {
    index: 0,
    text: "",
    app,
    url,
    startSec: first.startSec,
    endSec: last.endSec,
    // A parent inherits its FIRST member's barrier, so a bookmark keeps barring
    // all the way up rather than being swallowed at level 1.
    barrier: first.barrier,
  };
}
```

Fix `liftChild` to carry the summary: the caller must pass it. Change the call site to
`child: { ...liftChild(members.map((m) => m.child), children), text: g.summary }`.

Delete `composeLevels`, `MAX_DEPTH`, `ComposeLevelsOptions`, `composeBlock`, `rollupNode`, `liftNode`, and the `Partitioner` type from `types.ts`. Update the imports at the top of `levels.ts` to:

```ts
import { DEFAULT_BATCH_CAP, splitIntoBlocks, structuralRanges, validatePartition } from "./agglomerate.js";
import { LEVEL_GRANULARITY, levelQualifies } from "./admission.js";
import { rollupText } from "./rollup.js";
import type { SummarySource } from "../../store/types.js";
import type { Block, ChildSummary, ComposeGroup, Ladder, LadderChild, LadderNode, LevelKind } from "./types.js";
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose.levels.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/represent/compose/levels.ts src/represent/compose/types.ts test/compose.levels.test.ts
git commit -m "feat(compose): composeLadder — three fixed levels, admission and elision"
```

---

### Task 5: Drive the ladder from `ComposeRepresenter`

**Files:**
- Modify: `src/represent/compose/compose-representer.ts`
- Test: `test/compose.representer.test.ts`

**Interfaces:**
- Consumes: `composeLadder`, `ComposeFn` (Task 4); `Ladder`, `LadderChild` (Task 3).
- Produces: `ComposeResult` unchanged in shape — `{ levels, nodes, llmNodes, rootSummary }`, where `levels` is now the count of DISTINCT granularities written (1–3).

- [ ] **Step 1: Write the failing test**

Add to `test/compose.representer.test.ts`, and delete the three `nameRoot` tests (`NAMES THE ROOT…`, `leaves the rollup standing…`, `does not ask for a root name…`) — root naming is now inside the ladder and is covered by `test/compose.levels.test.ts`:

```ts
  it("writes at most three composed granularities", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 40);
    await new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) })
      .represent(sessionId);

    const grans = new Set(
      store.getSegmentsBySession(sessionId).map((s) => s.granularity),
    );
    expect([...grans].sort()).toEqual(["action", "level:1", "level:2", "session"].filter((g) => grans.has(g)).sort());
    expect(grans.has("level:3")).toBe(false);
  });

  it("writes NO level:2 without a summarizer — Process is model-only", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 12);
    await new ComposeRepresenter(store).represent(sessionId);

    const grans = new Set(store.getSegmentsBySession(sessionId).map((s) => s.granularity));
    expect(grans.has("level:1")).toBe(true);
    expect(grans.has("level:2")).toBe(false);
    expect(grans.has("session")).toBe(true);
  });

  it("writes an edge that SPANS two levels when a node was elided", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 12);
    // Pairs at level 1; at the process level the last task is left alone.
    const lonely = {
      id: "t", model: "t",
      compose: async (kids: readonly { text: string }[], ctx: { kind: string }) => {
        if (ctx.kind === "session") return [{ start: 0, end: 1, summary: "the session" }];
        if (ctx.kind === "process")
          return [
            { start: 0, end: kids.length - 1, summary: "phase" },
            { start: kids.length - 1, end: kids.length, summary: "alone" },
          ];
        const out = [];
        for (let i = 0; i < kids.length; i += 2)
          out.push({ start: i, end: Math.min(i + 2, kids.length), summary: `task ${i}` });
        return out;
      },
    };
    await new ComposeRepresenter(store, { summarizer: lonely }).represent(sessionId);

    const root = store.getSegmentsBySession(sessionId).find((s) => s.granularity === "session")!;
    const kidGrans = store.getSegmentChildren(root.id)
      .map((id) => store.getSegment(id)!.granularity);
    // The root holds a process AND the elided task — two different levels.
    expect(new Set(kidGrans).size).toBeGreaterThan(1);
  });

  it("has NO single-child composed node except the root", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 20);
    await new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) })
      .represent(sessionId);

    for (const s of store.getSegmentsBySession(sessionId)) {
      if (s.granularity === "action" || s.granularity === "session") continue;
      expect(store.getSegmentChildren(s.id).length).toBeGreaterThan(1);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose.representer.test.ts`
Expected: FAIL — `ComposeRepresenter` still calls `composeLevels`.

- [ ] **Step 3: Rewrite the write path**

In `compose-representer.ts`, replace the body of `represent` between `const children = …` and `await this.store.putSegments(segments)`:

```ts
    const ladder = await composeLadder(children, {
      ...(this.summarizer !== undefined ? { compose: this.composeFn() } : {}),
      ...(this.batchCap !== undefined ? { batchCap: this.batchCap } : {}),
    });

    // ONE forward pass: the ladder is topologically ordered, so every child
    // already has an id by the time its parent is written.
    const leafIds = leaves.map((s) => s.id);
    const leafSpan = leaves.map((s) => ({ start: s.tMonoStart, end: s.tMonoEnd }));
    const nodeIds: string[] = [];
    const nodeSpan: { start: number; end: number }[] = [];
    const segments: SegmentInsert[] = [];
    const edges: SegmentTreeInsert[] = [];
    const summaries: SegmentSummaryInsert[] = [];
    let llmNodes = 0;

    const resolve = (c: LadderChild): { id: string; start: number; end: number } =>
      c.kind === "leaf"
        ? { id: leafIds[c.index]!, ...leafSpan[c.index]! }
        : { id: nodeIds[c.index]!, ...nodeSpan[c.index]! };

    for (const node of ladder.nodes) {
      const kids = node.children.map(resolve);
      const nodeId = this.mintId();
      // A parent's span IS its children's union — never computed another way,
      // or a node could claim time nothing was recorded in.
      const tMonoStart = Math.min(...kids.map((k) => k.start));
      const tMonoEnd = Math.max(...kids.map((k) => k.end));
      segments.push({
        id: nodeId,
        sessionId,
        granularity: node.granularity,
        tMonoStart,
        tMonoEnd,
        boundaryReason: "window",
      });
      for (const k of kids) edges.push({ sessionId, parentId: nodeId, childId: k.id });
      summaries.push({ segmentId: nodeId, text: node.summary, source: node.source });
      if (node.source === "llm") llmNodes += 1;
      nodeIds.push(nodeId);
      nodeSpan.push({ start: tMonoStart, end: tMonoEnd });
    }

    const rootSummary = summaries[summaries.length - 1]?.text ?? null;
    const levels = new Set(segments.map((s) => s.granularity)).size;
```

Then the existing writes follow unchanged, and the return becomes
`return { levels, nodes: segments.length, llmNodes, rootSummary };`.

Replace the old `partitioner()` with:

```ts
  /** Adapts the provider to the ladder's contract. */
  private composeFn(): ComposeFn {
    const summarizer = this.summarizer;
    if (summarizer === undefined) throw new Error("composeFn() with no summarizer");
    return async (children, kind) => summarizer.compose(children, { kind });
  }
```

Delete `nameRoot` entirely — the ladder owns root naming now. Update imports: drop `ComposedLevel`, `Partitioner`; add `composeLadder`, `type ComposeFn`, `type LadderChild`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/compose.representer.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/represent/compose/compose-representer.ts test/compose.representer.test.ts
git commit -m "feat(represent): write the fixed ladder, with edges that may span a level"
```

---

### Task 6: Barrel, rail, and the empty PROCESS lane

**Files:**
- Modify: `src/index.ts`, `app/src/main/session-tracks.ts`
- Test: `test/session-tracks.test.ts`

**Interfaces:**
- Consumes: `LEVEL_GRANULARITY` (Task 3).
- Produces: `levelTitle` and `levelIndex` unchanged in signature; `levelLanes` gains an empty `level:2` lane when the recording has no Process.

- [ ] **Step 1: Write the failing test**

Add to the `levelLanes` describe block in `test/session-tracks.test.ts`:

```ts
  it("shows an EMPTY process lane when the recording has no phases", () => {
    const lanes = levelLanes(
      input([], {
        segments: [
          seg("a1", "action", 0, 1000),
          seg("t1", "level:1", 0, 1000),
          seg("r1", "session", 0, 1000),
        ],
        summaries: new Map([
          ["t1", { text: "a task", source: "llm" as const }],
          ["r1", { text: "the session", source: "llm" as const }],
        ]),
      }),
    );
    const process = lanes.find((l) => l.title === "process");
    // A MISSING lane says "this build does not know about processes"; an EMPTY
    // one says "this recording did not have any". Different facts.
    expect(process).toBeDefined();
    expect(process!.emptyReason).toMatch(/no distinct phases/i);
    expect(process!.spans).toEqual([]);
  });

  it("keeps the process lane ordered between session and task", () => {
    const lanes = levelLanes(
      input([], {
        segments: [
          seg("a1", "action", 0, 1000),
          seg("t1", "level:1", 0, 1000),
          seg("r1", "session", 0, 1000),
        ],
        summaries: new Map([
          ["t1", { text: "a task", source: "llm" as const }],
          ["r1", { text: "the session", source: "llm" as const }],
        ]),
      }),
    );
    expect(lanes.map((l) => l.title)).toEqual(["session", "process", "task", "action"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: FAIL — there is no `process` lane when no `level:2` rows exist.

- [ ] **Step 3: Always emit the three composed lanes**

In `app/src/main/session-tracks.ts`, replace the `LEVEL_NAMES` constant and `levelTitle`'s generic branch:

```ts
/**
 * The ladder is FIXED at three composed levels, so there is no generic
 * `level N` any more — `levelTitle` cannot be handed a `level:3`.
 */
const LEVEL_NAMES: Record<string, string> = {
  action: "action",
  "level:1": "task",
  "level:2": "process",
  session: "session",
};

export function levelTitle(granularity: string): string | null {
  return LEVEL_NAMES[granularity] ?? null;
}
```

`levelIndex` is unchanged.

In `levelLanes`, after building `byGranularity`, seed the composed levels so an
absent one still gets a row:

```ts
  // A recording with no phases still gets a PROCESS lane, empty. The rail's
  // rule is that absence is the payload: a MISSING lane says this build does
  // not know about processes, an EMPTY one says this recording had none.
  if (byGranularity.size > 0) {
    for (const g of ["level:1", "level:2"]) {
      if (!byGranularity.has(g)) byGranularity.set(g, []);
    }
  }
```

and give an empty composed lane its reason, inside the `.map`:

```ts
        emptyReason:
          composed && sorted.length === 0
            ? granularity === "level:2"
              ? "no distinct phases in this recording — its tasks all served one outcome"
              : "no tasks composed — the model declined to group these actions"
            : null,
```

Guard the `deepest` computation against the seeded empty entries by using the
granularity keys as before; `levelIndex("level:2")` is 2 whether or not rows exist.

- [ ] **Step 4: Export from the barrel**

In `src/index.ts`, replace the compose exports:

```ts
export {
  ComposeRepresenter,
  LEAF_GRANULARITY,
  LEVEL_PREFIX,
  ROOT_GRANULARITY,
  type ComposeRepresenterOptions,
  type ComposeResult,
} from "./represent/compose/compose-representer.js";
export { LEVELS, composeLadder, type ComposeFn } from "./represent/compose/levels.js";
export { LEVEL_GRANULARITY, levelQualifies } from "./represent/compose/admission.js";
export type {
  ChildSummary,
  ComposeGroup,
  Ladder,
  LadderChild,
  LadderNode,
  LevelKind,
} from "./represent/compose/types.js";
```

Remove `ComposedLevel` and `ComposedNode` from the barrel — both types are gone.

- [ ] **Step 5: Run every gate**

```bash
npm run typecheck && npm test && npm run build && npm --prefix app run typecheck && npm --prefix app run build
```
Expected: all clean except the known `ax-swift` permission failure.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts app/src/main/session-tracks.ts test/session-tracks.test.ts
git commit -m "feat(app): fixed level vocabulary and an empty PROCESS lane"
```

---

### Task 7: Validate against the five real recordings

**Files:** none — this is measurement. Record the numbers in the commit message and in Task 8's docs.

**Interfaces:** consumes the built `dist/`.

- [ ] **Step 1: Rebuild BOTH packages**

```bash
npm run build && npm --prefix app run build
```

The app BUNDLES the library. Skipping the second command is what produced a false "the grouping got worse" report — verify with:

```bash
grep -c "composeLadder" app/out/main/index.js
```
Expected: ≥1.

- [ ] **Step 2: Re-compose every recording**

Write `/tmp/recompose.mjs`:

```js
import { DualStore, ComposeRepresenter, OllamaTextEmbedding, OllamaSummaryProvider }
  from "<REPO>/dist/index.js";
const DIR = `${process.env.HOME}/Library/Application Support/deskrag-app/DeskRAG`;
const store = await DualStore.open(`${DIR}/app.db`, `${DIR}/lance`);
for (const s of store.listSessions()) {
  const r = await new ComposeRepresenter(store, {
    summarizer: new OllamaSummaryProvider({ model: "qwen3-vl:4b" }),
    summaryEmbedder: new OllamaTextEmbedding({ model: "nomic-embed-text" }),
  }).represent(s.id);
  process.stdout.write(`${s.id.slice(-6)} ${JSON.stringify(r)}\n`);
}
store.close();
```

Run it with `node`, substituting the repo path.

- [ ] **Step 3: Fill in the validation table**

```bash
DB=~/Library/Application\ Support/deskrag-app/DeskRAG/app.db
sqlite3 "$DB" "SELECT granularity, COUNT(*) FROM segment GROUP BY granularity;"
sqlite3 "$DB" "SELECT ss.source, COUNT(*) FROM segment_summary ss GROUP BY ss.source;"
```

And for the structural counts, adapt the probe used to produce the before-numbers:
count composed parents, single-child parents, parents whose summary equals their
only child's summary, and mean fan-out per granularity.

| | before | after |
| --- | --- | --- |
| single-child parents | 21 of 60 | **must be 0** |
| …duplicating the child's name | 11 | **must be 0** |
| mean fan-out, `level:2` | 2.1 | ≥2 by construction |
| depth per recording | 4,3,4,4,4 | ≤3 composed |
| recordings where Process qualifies | n/a | **report it** |

**The last row is the open question and must not be prejudged.** If Process
qualifies on none of the five, the honest reading is that a 30-second recording
has one phase — a finding about the data, not a bug.

- [ ] **Step 4: Look at one tree**

Print a session's tree (parent → children with summaries) and read it. The
defect this work removes looked like `Start recording session` stacked over
`Start recording session`; confirm no level repeats its child.

- [ ] **Step 5: Drive the app**

Follow the `run-app` skill: open the Library, confirm the rail shows
`SESSION · PROCESS · TASK · ACTION` top to bottom, that an absent PROCESS lane
renders empty with its reason rather than vanishing, and that no label truncates.

- [ ] **Step 6: Commit the measurements**

```bash
git commit --allow-empty -m "measure: fixed ladder on five real recordings

<paste the filled table here>"
```

---

### Task 8: Update CLAUDE.md and both specs

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-08-09-fixed-segment-hierarchy-design.md`, `docs/superpowers/specs/2026-08-09-compositional-segment-hierarchy-design.md`

- [ ] **Step 1: Replace the stale hierarchy invariants in CLAUDE.md**

The section beginning `### The compositional hierarchy (src/represent/compose/) — height is COMPOSED, never windowed` describes the recursion. Rewrite it for the fixed ladder, keeping every invariant that still holds (cut points, wholesale rejection, the thinking-channel facts, the compositional rollup, `source` as disclosure) and replacing the rest with:

- three fixed levels, each with its OWN prompt, and why: measured fan-out 1.6 by level 3, 21 of 60 single-child parents, 11 duplicating their child's name;
- the admission rule, and that a skipped level means the level above adopts its children;
- elision, and that `segment_tree` edges may therefore span two levels — with the note that `getDescendantLeaves` and `collapseAncestors` both still work because they walk to leaves and to children respectively;
- **Process is model-only**, and what a default install therefore produces;
- the Task 7 numbers.

- [ ] **Step 2: Mark the superseded spec**

At the top of `2026-08-09-compositional-segment-hierarchy-design.md`, add:

```markdown
> **Superseded in part** by `2026-08-09-fixed-segment-hierarchy-design.md`
> (2026-08-09): the "recursive until one root" decision is reversed there, on
> measured evidence. Everything else in this document — the storage model, the
> cut-point contract, the compositional rollup, retrieval at altitude, and the
> Flows and Library readers — still stands.
```

- [ ] **Step 3: Fill the validation table in the fixed-hierarchy spec**

Replace the `target` column in §5 with the measured `after` column from Task 7,
including the Process-qualification count whatever it turns out to be.

- [ ] **Step 4: Run the gates and commit**

```bash
npm run typecheck && npm test && npm --prefix app run typecheck
git add CLAUDE.md docs/superpowers/specs/
git commit -m "docs: record the fixed ladder's invariants and measurements"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
| --- | --- |
| §1 level table, three levels, own prompts | 1, 4 |
| §1 admission rule | 3, 4 |
| §1 elision; root exempt | 3, 4, 5 |
| §1 `level:1` may itself fail admission | 4 (test: "SKIPS a level whose every node holds one child") |
| §1 root keeps its own call | 4 (`makeRoot`) |
| §1 deleted: MAX_DEPTH, shrinkage guard, wrap-into-root | 4 |
| §2 `ComposeContext.kind` | 2 |
| §2 prompts stay in `prompt.ts` | 1 |
| §2 unchanged machinery | 4 (reused, asserted by the rejection and barrier tests) |
| §2 Process model-only | 3, 4 |
| §3 storage unchanged | 5 |
| §3 rail: `levelTitle`, empty PROCESS lane | 6 |
| §3 `nameRoute` unchanged | — (no change needed; noted in the spec) |
| §3 retrieval unchanged | — (no change needed) |
| §4 testing | 1–6 |
| §5 validation | 7 |
| Build order | Task order 1→8 |

**Placeholder scan:** no TBD/TODO. Task 7's `<REPO>` is a path the executor substitutes, and the "report it" row is a deliberate open measurement, stated as such.

**Type consistency:** `LevelKind` is defined once in `types.ts` (Task 2) and used by `prompt.ts`, `summary.ts`, `admission.ts`, `levels.ts`. `LadderChild`/`LadderNode`/`Ladder` are defined once (Task 3) and consumed by Tasks 4–5. `ComposeFn` is defined in `levels.ts` (Task 4) and used in `compose-representer.ts` (Task 5). `LEVEL_GRANULARITY` is defined in `admission.ts` (Task 3) and used in Tasks 4 and 6.

**One known rough edge, flagged rather than hidden:** Task 4's `liftChild` needs the group's summary, which the helper cannot see — the plan patches it at the call site (`{ ...liftChild(...), text: g.summary }`). An implementer may prefer to pass the summary as a parameter instead; either is fine, but the resulting `ChildSummary.text` must be the group's summary or the next level composes from empty strings.
