# Knowledge Layer Seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Knowledge layer's contract as typed semantics — a pure resolver over evidence the store already holds — settling `docs/research/persistence-layers.md` §6.2 without creating a table.

**Architecture:** One leaf module, `src/knowledge/facts.ts`, holding the fact shape and a `currentValue()` resolver. It has no store dependency, no model, and no clock of its own: ordering across recordings arrives as an injected `(sessionId) => number | undefined`, because `tMono` restarts every session and `session.started_at` is joined at query time. The resolver refuses three ways — a `coexisting` fact has no current value, a tie declines, and undatable sources are disclosed. This is the `src/trace/stability.ts` pattern exactly: the paper's semantics as a pure function, where the omission of storage *is* the design.

**Tech Stack:** TypeScript (strict, ESM), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md`

## Global Constraints

- **No table, no bucket edit, no stage, no UI, no MCP tool.** Cycle 0 ships the contract only. `src/store/sqlite/schema.ts` is not touched.
- **`src/knowledge/` is a LEAF.** No import from `store/`, `represent/`, `retrieve/`, or any adapter. No native module. No `spawn`. Barrel-safe.
- **Nothing reads a clock.** No `Date.now()`, no `new Date()` anywhere in `src/knowledge/`. Ordering is injected, on the `EdgeRecency` / `RecencyOptions` precedent.
- **Counts only — never a ratio.** No percentage, no confidence, no fraction in any returned value or any `reason` string. A stability percentage would be `FrameResult.score` under a new name, and so would this.
- **Every returned shape states a `reason`,** required and non-empty — the `Stability.reason` and `StageSpec.skipReason` precedent: a thing that does not appear must say why.
- **Values arriving in `KnowledgeFact.values` are already distinct.** Deduplicating them is cycle 1's subject. This module must not merge, normalise, or compare values for equivalence.
- **Gates:** `npm run typecheck` and `npm test` must both pass before any commit.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KNMAPpjspVHJU1kiuRpcba`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/knowledge/facts.ts` | **Create.** The whole module: `KnowledgeSource`, `ObservedValue`, `KnowledgeFact`, `Exclusivity`, `SessionStartedAt`, `Current`, and `currentValue()`. One file, following `src/trace/stability.ts`, which likewise holds its types and its function together at ~120 lines. |
| `test/knowledge.current.test.ts` | **Create.** Unit tests. No fixtures, no real data, no store. |
| `src/index.ts` | **Modify.** Barrel export block, placed immediately after the `stabilityOf` block. |
| `docs/internals/persistence.md` | **Modify.** Replace the "decision left open" section with the decision. |
| `docs/research/persistence-layers.md` | **Modify.** Mark §6.2 settled. |
| `CLAUDE.md` | **Modify.** One bullet and one table-row edit. |

---

### Task 1: The contract and the exclusive path

**Files:**
- Create: `src/knowledge/facts.ts`
- Test: `test/knowledge.current.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `KnowledgeSource {sessionId: string; tMono: number}`, `ObservedValue<V> {value: V; sources: readonly KnowledgeSource[]}`, `KnowledgeFact<V> {kind: string; values: readonly ObservedValue<V>[]}`, `Exclusivity = "exclusive" | "coexisting"`, `SessionStartedAt = (sessionId: string) => number | undefined`, `Current<V> {value: V | null; reason: string; alternatives: number; undated: number}`, and `currentValue<V>(fact: KnowledgeFact<V>, exclusivity: Exclusivity, startedAt: SessionStartedAt): Current<V>`.

- [ ] **Step 1: Write the failing test**

Create `test/knowledge.current.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  currentValue,
  type KnowledgeFact,
  type KnowledgeSource,
  type ObservedValue,
  type SessionStartedAt,
} from "../src/knowledge/facts.js";

/** A source: which recording saw it, and how far into that recording. */
const at = (sessionId: string, tMono = 0): KnowledgeSource => ({ sessionId, tMono });

const val = <V>(value: V, ...sources: KnowledgeSource[]): ObservedValue<V> => ({ value, sources });

const fact = <V>(kind: string, ...values: ObservedValue<V>[]): KnowledgeFact<V> => ({ kind, values });

/** Session start times in wall-clock ms. A missing id is an UNDATABLE recording. */
const clock =
  (starts: Record<string, number>): SessionStartedAt =>
  (id) =>
    starts[id];

describe("currentValue — the exclusive path", () => {
  it("picks the most recently observed value", () => {
    const f = fact("keymap", val("ansi", at("s1")), val("iso", at("s2")));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000, s2: 2_000 }));
    expect(out.value).toBe("iso");
  });

  it("orders within one recording by t_mono, not just by session", () => {
    // Both observations are in s1, so session start alone cannot separate them.
    const f = fact("keymap", val("ansi", at("s1", 0)), val("iso", at("s1", 5_000)));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000 }));
    expect(out.value).toBe("iso");
  });

  it("ranks a value by its LATEST source, not its first", () => {
    const f = fact("keymap", val("ansi", at("s1"), at("s3")), val("iso", at("s2")));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000, s2: 2_000, s3: 3_000 }));
    expect(out.value).toBe("ansi");
  });

  it("discloses the alternatives rather than dropping them", () => {
    const f = fact("keymap", val("ansi", at("s1")), val("iso", at("s2")), val("dvorak", at("s3")));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000, s2: 2_000, s3: 3_000 }));
    expect(out.value).toBe("dvorak");
    expect(out.alternatives).toBe(2);
  });

  it("counts no alternatives for the only value observed", () => {
    const out = currentValue(fact("keymap", val("ansi", at("s1"))), "exclusive", clock({ s1: 1 }));
    expect(out.value).toBe("ansi");
    expect(out.alternatives).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge.current.test.ts`
Expected: FAIL — the module does not exist ("Failed to resolve import ... src/knowledge/facts.js").

- [ ] **Step 3: Write the implementation**

Create `src/knowledge/facts.ts`:

```ts
/**
 * The Knowledge layer's semantics — what is true, computed rather than stored.
 *
 * ## What this is
 *
 * `docs/research/persistence-layers.md` finds one of the paper's four layers
 * genuinely absent from DeskRAG: Knowledge, "what is true", superseded rather
 * than forgotten. Its §6.2 left one question open on purpose — whether such a
 * layer is PERSISTED append-only, which would be the first state in this store
 * that is neither rebuildable nor authored. This module is the answer, and the
 * answer is that nothing is stored. See
 * `docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md`.
 *
 * ## Why a fact is not stored
 *
 * The paper's Knowledge is append-only because its system does not RETAIN the
 * evidence: an agent learns a fact from a conversation and the conversation is
 * gone. `CAPTURED_TABLES` is exactly that retained evidence, and a re-index must
 * never touch it — so re-derivability is free here and the paper's reason does
 * not transfer. When a later cycle adds a table it is classified
 * `DERIVED_LIBRARY_TABLES`, beside the trace graph, and inherits its contract: a
 * rebuild discards everything and replays every session in order.
 *
 * ## Why supersession is COMPUTED, and exclusivity is per TYPE
 *
 * The paper updates Knowledge by supersession — newer claim wins, older marked
 * superseded. Measured on the real library, that rule produces a FALSE CLAIM:
 * `display_change` carries 12 occurrences and 8 distinct payloads but only TWO
 * configurations, and the two do not supersede one another — a laptop is docked
 * some days and not others. "Newer wins" would delete a configuration that is
 * still true.
 *
 * So every distinct value is kept with its sources, and the TYPE declares
 * whether its values can coexist. A keyboard layout is `exclusive`; a display
 * topology is `coexisting`. "Current" is then a question asked per query and
 * answered per query — a stored `superseded_by` edge would be a storage-level
 * commitment to a ranking, which is the litmus this repo already holds.
 *
 * ## What this deliberately does NOT do
 *
 * It does not decide whether two values are the SAME value. Fed those 8 display
 * payloads it reports 8, not 2 — seven of them are the same physical display
 * with an `id` macOS re-mints every session. Collapsing them is cross-recording
 * entity identity, a later cycle, and leaving it out here makes that case
 * legible AS an identity problem rather than silently mis-keying it.
 *
 * ## It is not a score
 *
 * `alternatives` and `undated` are COUNTS. Nothing here returns a fraction, and
 * a consumer that renders one has reintroduced the number `FrameResult.score`
 * established this repo does not print.
 */

/**
 * A recording that observed a value, and how far into it.
 *
 * `tMono` only — the wall clock is not in this layer to be read. `EdgeSource`
 * carries the same pair for the same reason.
 */
export interface KnowledgeSource {
  sessionId: string;
  tMono: number;
}

/**
 * One distinct value, and every recording that observed it.
 *
 * DISTINCT is the caller's guarantee. Nothing here merges two values that mean
 * the same thing — see the header.
 */
export interface ObservedValue<V> {
  value: V;
  sources: readonly KnowledgeSource[];
}

/** A fact: a kind, and the distinct values observed for it. Stored nowhere. */
export interface KnowledgeFact<V> {
  kind: string;
  values: readonly ObservedValue<V>[];
}

/**
 * Whether a fact's values can be true at the same time. Declared per TYPE,
 * never per value: a keyboard layout is `exclusive`, a display topology is not.
 */
export type Exclusivity = "exclusive" | "coexisting";

/**
 * Orders a recording against the others. `undefined` is an UNDATABLE recording,
 * which is disclosed rather than guessed.
 *
 * Injected, because `tMono` restarts at zero every session and
 * `session.started_at` is joined at query time. `EdgeRecency` and
 * `RecencyOptions` take the same shape.
 */
export type SessionStartedAt = (sessionId: string) => number | undefined;

/** What a fact resolves to right now. Counts only — never a ratio. */
export interface Current<V> {
  /** The current value, or null on every refusal. */
  value: V | null;
  /** Why this answer. Required — a thing that does not appear must say why. */
  reason: string;
  /** Distinct OTHER values still standing. A count of values. */
  alternatives: number;
  /** Sources that could not be dated, so could not be ordered. */
  undated: number;
}

/** The latest moment this value was observed, or null when nothing datable saw it. */
function observedAt(v: ObservedValue<unknown>, startedAt: SessionStartedAt): number | null {
  let latest: number | null = null;
  for (const s of v.sources) {
    const start = startedAt(s.sessionId);
    if (start === undefined) continue;
    const when = start + s.tMono;
    if (latest === null || when > latest) latest = when;
  }
  return latest;
}

/** Sources across the whole fact that no clock could place. */
function undatedSources(fact: KnowledgeFact<unknown>, startedAt: SessionStartedAt): number {
  let n = 0;
  for (const v of fact.values) {
    for (const s of v.sources) if (startedAt(s.sessionId) === undefined) n += 1;
  }
  return n;
}

/**
 * Which value of this fact is current.
 *
 * Refuses three ways, and each refusal is an answer rather than an error: a
 * `coexisting` fact has no current value, a tie declines on `bindHabit`'s
 * precedent, and a fact nothing can date says so.
 */
export function currentValue<V>(
  fact: KnowledgeFact<V>,
  exclusivity: Exclusivity,
  startedAt: SessionStartedAt,
): Current<V> {
  const undated = undatedSources(fact, startedAt);
  const total = fact.values.length;

  let best: { value: V; when: number } | null = null;
  let tied = false;
  for (const v of fact.values) {
    const when = observedAt(v, startedAt);
    if (when === null) continue;
    if (best === null || when > best.when) {
      best = { value: v.value, when };
      tied = false;
    } else if (when === best.when) {
      tied = true;
    }
  }

  if (best === null || tied) {
    // Task 2 fills in the refusals. Until then, an unranked fact is not current.
    return { value: null, reason: `Nothing is current for ${fact.kind}.`, alternatives: total, undated };
  }

  return {
    value: best.value,
    reason:
      total === 1
        ? `The only value observed for ${fact.kind}.`
        : `Most recently observed of ${total} values for ${fact.kind}; ${total - 1} other${total === 2 ? "" : "s"} still stand.`,
    alternatives: total - 1,
    undated,
  };
}
```

Note: `exclusivity` is accepted but not yet branched on — Task 2 adds the `coexisting` refusal. Leaving it unread here is deliberate so Task 1's tests drive only the ranking.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/knowledge.current.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both pass. `exclusivity` is accepted but not read yet, which is fine: `tsconfig.json` sets `strict: true` and does **not** set `noUnusedParameters`, so an unread parameter is not an error. Do not suppress anything and do not drop the parameter — Task 2 branches on it.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/facts.ts test/knowledge.current.test.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): the fact contract, and the value that is current

The Knowledge layer as typed semantics: a fact is a kind and its distinct
observed values, each carrying the recordings that saw it. Ordering across
recordings is INJECTED, because t_mono restarts every session and
session.started_at is joined at query time -- the same shape EdgeRecency
takes, and for the same reason. Nothing here reads a clock.

A value ranks by its LATEST source, not its first, and the composite is
started_at + t_mono so two observations inside one recording still order.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNMAPpjspVHJU1kiuRpcba
EOF
)"
```

---

### Task 2: The three refusals

**Files:**
- Modify: `src/knowledge/facts.ts` (the `currentValue` body)
- Test: `test/knowledge.current.test.ts` (append a second `describe`)

**Interfaces:**
- Consumes: everything Task 1 produced — `currentValue`, `KnowledgeFact`, `ObservedValue`, `KnowledgeSource`, `SessionStartedAt`, `Current`, `Exclusivity`.
- Produces: no new exports. `currentValue` gains its `coexisting`, tie, undatable and empty behaviour.

- [ ] **Step 1: Write the failing tests**

Append to `test/knowledge.current.test.ts`:

```ts
describe("currentValue — what it refuses", () => {
  it("refuses to name a current value for a coexisting fact", () => {
    // Docked and undocked are BOTH true. Newer-wins would delete a real one.
    const f = fact("display", val("one-up", at("s1")), val("docked", at("s2")));
    const out = currentValue(f, "coexisting", clock({ s1: 1_000, s2: 2_000 }));
    expect(out.value).toBeNull();
    expect(out.alternatives).toBe(2);
    expect(out.reason).toMatch(/at once|set/i);
  });

  it("declines on a tie rather than picking one", () => {
    const f = fact("keymap", val("ansi", at("s1")), val("iso", at("s2")));
    // Same absolute moment: s1 starts at 1000+500, s2 at 1500+0.
    const out = currentValue(f, "exclusive", clock({ s1: 1_000, s2: 1_500 }));
    const tie = currentValue(
      fact("keymap", val("ansi", at("s1", 500)), val("iso", at("s2", 0))),
      "exclusive",
      clock({ s1: 1_000, s2: 1_500 }),
    );
    expect(out.value).toBe("iso"); // control: not a tie
    expect(tie.value).toBeNull();
    expect(tie.reason).toMatch(/same|neither|declin/i);
  });

  it("discloses sources it cannot date without discarding the ranking", () => {
    const f = fact("keymap", val("ansi", at("s1")), val("iso", at("gone")));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000 }));
    expect(out.value).toBe("ansi");
    expect(out.undated).toBe(1);
  });

  it("refuses when no recording can be dated at all", () => {
    const f = fact("keymap", val("ansi", at("gone")), val("iso", at("also-gone")));
    const out = currentValue(f, "exclusive", clock({}));
    expect(out.value).toBeNull();
    expect(out.undated).toBe(2);
    expect(out.reason).toMatch(/dated|order/i);
  });

  it("answers for a fact with no values at all", () => {
    const out = currentValue(fact<string>("keymap"), "exclusive", clock({}));
    expect(out.value).toBeNull();
    expect(out.alternatives).toBe(0);
    expect(out.undated).toBe(0);
    expect(out.reason.length).toBeGreaterThan(0);
  });

  it("always states a reason, on every path", () => {
    const outs = [
      currentValue(fact<string>("k"), "exclusive", clock({})),
      currentValue(fact("k", val("a", at("s1"))), "exclusive", clock({ s1: 1 })),
      currentValue(fact("k", val("a", at("s1"))), "coexisting", clock({ s1: 1 })),
      currentValue(fact("k", val("a", at("gone"))), "exclusive", clock({})),
    ];
    for (const out of outs) expect(out.reason.length).toBeGreaterThan(0);
  });

  it("returns no fraction anywhere — counts, never a ratio", () => {
    const f = fact("k", val("a", at("s1")), val("b", at("s2")), val("c", at("gone")));
    for (const ex of ["exclusive", "coexisting"] as const) {
      const out = currentValue(f, ex, clock({ s1: 1_000, s2: 2_000 }));
      expect(Number.isInteger(out.alternatives)).toBe(true);
      expect(Number.isInteger(out.undated)).toBe(true);
      expect(out.reason).not.toMatch(/\d+(\.\d+)?%|0\.\d+/);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/knowledge.current.test.ts`
Expected: FAIL — the `coexisting` test fails first (it currently returns `"iso"` rather than null, because `exclusivity` is not branched on), and the reason-text assertions fail against the Task 1 placeholder string.

- [ ] **Step 3: Write the implementation**

In `src/knowledge/facts.ts`, replace the body of `currentValue` from `const undated = ...` to the end of the function with:

```ts
  const undated = undatedSources(fact, startedAt);
  const total = fact.values.length;

  if (total === 0) {
    return {
      value: null,
      reason: `Nothing has been observed for ${fact.kind}.`,
      alternatives: 0,
      undated,
    };
  }

  if (exclusivity === "coexisting") {
    return {
      value: null,
      reason:
        `${fact.kind} holds ${total} value${total === 1 ? "" : "s"} that can all be true at once, ` +
        `so there is no current one — the answer is the set.`,
      alternatives: total,
      undated,
    };
  }

  let best: { value: V; when: number } | null = null;
  let tied = false;
  for (const v of fact.values) {
    const when = observedAt(v, startedAt);
    if (when === null) continue;
    if (best === null || when > best.when) {
      best = { value: v.value, when };
      tied = false;
    } else if (when === best.when) {
      tied = true;
    }
  }

  if (best === null) {
    return {
      value: null,
      reason:
        `No recording that observed ${fact.kind} can be dated, so its values cannot be ordered ` +
        `and none of them is later than the others.`,
      alternatives: total,
      undated,
    };
  }

  if (tied) {
    return {
      value: null,
      reason:
        `Two values for ${fact.kind} were last observed at the same moment, so neither is later. ` +
        `Declining rather than picking one.`,
      alternatives: total,
      undated,
    };
  }

  return {
    value: best.value,
    reason:
      total === 1
        ? `The only value observed for ${fact.kind}.`
        : `Most recently observed of ${total} values for ${fact.kind}; ${total - 1} other${total === 2 ? "" : "s"} still stand.`,
    alternatives: total - 1,
    undated,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/knowledge.current.test.ts`
Expected: PASS, 12 tests across both `describe` blocks.

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/facts.ts test/knowledge.current.test.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): three refusals, because the paper's rule is wrong on real data

A coexisting fact has NO current value and says so. Measured on the real
library: display_change is 12 occurrences and 8 distinct payloads but only
TWO configurations, and the two do not supersede one another -- a laptop is
docked some days and not others, so "newer wins" would delete a
configuration that is still true. The answer is the set.

A tie DECLINES, on bindHabit's precedent. A fact no recording can date says
that rather than guessing, and undatable sources are counted beside a
ranking that still stands -- stabilityOf's undefined-vs-[] rule.

Every path states a reason and returns counts. No fraction anywhere.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNMAPpjspVHJU1kiuRpcba
EOF
)"
```

---

### Task 3: Barrel export

**Files:**
- Modify: `src/index.ts` (immediately after the `stabilityOf` export block, which currently ends `} from "./trace/stability.js";`)
- Test: `test/knowledge.current.test.ts` (one added case)

**Interfaces:**
- Consumes: every export from Task 1 and Task 2.
- Produces: the same names, reachable as `import { currentValue } from "deskrag"`. The app imports `dist/`, so nothing in `app/` can use this until `npm run build` runs.

- [ ] **Step 1: Write the failing test**

Append to `test/knowledge.current.test.ts`:

```ts
describe("the barrel", () => {
  it("exports the Knowledge contract", async () => {
    const barrel = await import("../src/index.js");
    expect(typeof barrel.currentValue).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge.current.test.ts -t "exports the Knowledge contract"`
Expected: FAIL — `expected "undefined" to be "function"`.

- [ ] **Step 3: Write the implementation**

In `src/index.ts`, immediately after the block ending `} from "./trace/stability.js";`, insert:

```ts
/**
 * The Knowledge layer's semantics: which of a fact's observed values is
 * current. Computed on every call and stored NOWHERE — see the header of
 * `knowledge/facts.ts` and docs/internals/persistence.md. Pure, a leaf, loads
 * nothing native.
 */
export {
  currentValue,
  type Current,
  type Exclusivity,
  type KnowledgeFact,
  type KnowledgeSource,
  type ObservedValue,
  type SessionStartedAt,
} from "./knowledge/facts.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/knowledge.current.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run the gates, including the build the app depends on**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three pass. `npm run build` matters here specifically: the app imports `dist/`, not `src/`, so a barrel export that does not survive the build is invisible until a later cycle tries to use it.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/knowledge.current.test.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): export the contract from the barrel

Placed beside stabilityOf, which it is the companion of: both are the
paper's semantics as a pure function over evidence the store already holds,
and neither stores anything.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNMAPpjspVHJU1kiuRpcba
EOF
)"
```

---

### Task 4: Settle §6.2 in the docs

**Files:**
- Modify: `docs/internals/persistence.md` (the `### The decision left open, on purpose` section)
- Modify: `docs/research/persistence-layers.md` (§6.2's closing paragraph)
- Modify: `CLAUDE.md` (the `persistence.md` table row, and one bullet under *Trace IR and the executor*)

**Interfaces:**
- Consumes: the shipped `src/knowledge/facts.ts`.
- Produces: nothing in code. This task is what makes the decision findable by a future session that has not read the spec.

- [ ] **Step 1: Replace the open-decision section in `docs/internals/persistence.md`**

Find the section beginning `### The decision left open, on purpose` and replace it entirely (heading and both paragraphs, through `...as a side effect of the first table.`) with:

```markdown
### The decision, made 2026-09-04

Persisted Knowledge in the paper's sense — append-only, superseded, **not
recomputed** — would be the first state in this store that is neither
rebuildable nor authored. **It is not built, and when Knowledge does get a
table that table is `DERIVED_LIBRARY_TABLES`.**

**The paper's reason for append-only does not transfer.** Roynard's Knowledge
is append-only because his system does not retain the evidence — an agent
learns a fact from a conversation and the conversation is gone.
`CAPTURED_TABLES` is exactly that retained evidence, and its defining property
is that a re-index must never touch it. So re-derivability is free here, and
taking the expensive side would have bought a property this store does not
need at the price of the re-index invariant.

A fact outliving the deletion of its evidence needs no new rule either:
`removeSession` does not rebuild the trace graph today, `observations` survives
while `sources` thins, and the discrepancy is disclosed rather than repaired.

**Supersession is COMPUTED, and exclusivity is declared per fact TYPE.** The
paper updates Knowledge by supersession — newer claim wins, older marked
superseded — and §7's decline of contradiction *resolution* collides with it.
On the real library the paper's rule loses. Measured 2026-09-04 over 12
recordings: `keymap_change` is 12 occurrences and **one** distinct payload, so
nothing supersedes anything; `display_change` is 12 occurrences and **eight**
distinct payloads but only **two** configurations. Seven of the eight are the
same 1920×1080@2 primary with a **different `id` every session** (180, 185,
206, 219, 247, 296, 297), because macOS re-mints the identifier — `id` is a
decoy and geometry discriminates. Keying supersession on it would have minted
eight facts where there are two, and the two real configurations do not
supersede one another: a laptop is docked some days and not others, so "newer
wins" would delete a configuration that is still true.

So every distinct value is kept with its sources, each fact TYPE declares
whether its values can coexist, and "current" is answered per query and stored
nowhere — the storage/query litmus applied to itself, since a stored
`superseded_by` edge is a storage-level commitment to a ranking.

`src/knowledge/facts.ts` is that contract: `currentValue()` returns the latest
value of an `exclusive` fact and **refuses three ways** — a `coexisting` fact
has no current value, a tie declines on `bindHabit`'s precedent, and a fact no
recording can date says so. Counts only; a percentage would be
`FrameResult.score` renamed.

**It does not decide whether two values are the same value.** Fed those eight
display payloads it reports eight. That is the seam, not a defect:
cross-recording entity identity is its own cycle, and it is a **prerequisite of
every Knowledge candidate** rather than one of them — "is this the same
display", "is this the same document", "is this the same app version" are one
question. Leaving it out makes the display case legible *as* an identity
problem instead of silently mis-keying it, which is what a stored edge would
have done while looking correct.

What would reopen this: a fact type whose evidence is genuinely not retained; a
rebuild that cannot reproduce a fact in session order; or a measured need for a
stored edge. See
`docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md` §8.
```

- [ ] **Step 2: Mark §6.2 settled in `docs/research/persistence-layers.md`**

In §6.2, replace the final sentence — `**This should be decided deliberately if Knowledge is ever built, not settled as a side effect of the first table.**` — with:

```markdown
**Decided 2026-09-04, deliberately and against real data rather than against
the paper.** Knowledge is `DERIVED_LIBRARY_TABLES` when it has a table, and
supersession is computed rather than stored, with exclusivity declared per fact
type. The measurement that decided it — `display_change` carrying eight
distinct payloads for two real configurations, because macOS re-mints the
display `id` every session — also reordered the candidates: entity identity is
a **prerequisite** of the other two, not the second of three. See
[`docs/internals/persistence.md`](../internals/persistence.md) and
[the spec](../superpowers/specs/2026-09-04-knowledge-layer-seam-design.md).
```

Then update the header note at the top of the file: after the sentence ending `§6.2 is recorded as still open, deliberately.`, append ` **§6.2 was settled 2026-09-04 — see §6.2.**`

- [ ] **Step 3: Update `CLAUDE.md`**

First, the internals table row. Find:

```
| [persistence.md](docs/internals/persistence.md) | what may fade and where a time preference belongs; the `schema.ts` buckets; the stability tier | adding a TABLE or a BUCKET, any recency/decay/freshness term, anything that ranks by a lifetime count |
```

Replace with:

```
| [persistence.md](docs/internals/persistence.md) | what may fade and where a time preference belongs; the `schema.ts` buckets; the stability tier; the Knowledge decision | adding a TABLE or a BUCKET, any recency/decay/freshness term, anything that ranks by a lifetime count, anything that calls a value superseded |
```

Then, under *### Trace IR and the executor*, immediately after the bullet beginning `- **A STABILITY TIER IS A WORD AND A COUNT OF RECORDINGS...`, insert:

```markdown
- **SUPERSESSION IS COMPUTED, AND "NEWER WINS" IS FALSE ON THE REAL LIBRARY.** Knowledge — "what is true" — is not a store and not a sixth bucket: when it gets a table that table is `DERIVED_LIBRARY_TABLES`, because the paper is append-only only since its system does not RETAIN the evidence, and `CAPTURED_TABLES` is exactly that evidence. `currentValue` (`src/knowledge/facts.ts`) keeps every distinct value with its sources, takes exclusivity as a property of the fact TYPE, and answers "current" per query. Measured 2026-09-04: `keymap_change` is 12 occurrences and **1** distinct payload, so nothing supersedes anything; `display_change` is 12 occurrences and **8** distinct payloads but **2** configurations — seven share one geometry with a different `id` each session, because macOS re-mints it. A stored `superseded_by` keyed on the observed identifier would have minted 8 facts where there are 2, and "newer wins" would delete the docked setup, **which is still true**. It refuses three ways (`coexisting` has no current value, a tie declines, an undatable fact says so) and it does **not** decide whether two values are the same value — that is entity identity, and it is a PREREQUISITE of every Knowledge candidate rather than one of them.
```

- [ ] **Step 4: Verify no stale count or claim was left behind**

Run:
```bash
grep -rn "left open, on purpose\|decided deliberately if Knowledge" docs/ CLAUDE.md
```
Expected: no matches. Then run `grep -rn "still open" docs/internals/persistence.md docs/research/persistence-layers.md` and confirm any remaining hit refers to something other than §6.2.

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both pass. (Docs-only, but `test/brand.assets.test.ts` and the purge-derived guard are cheap insurance that nothing was edited by accident.)

- [ ] **Step 6: Commit**

```bash
git add docs/internals/persistence.md docs/research/persistence-layers.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(knowledge): §6.2 is settled, and the measurement that settled it

persistence.md's "decision left open, on purpose" becomes the decision:
DERIVED_LIBRARY_TABLES when Knowledge has a table, supersession computed
rather than stored, exclusivity declared per fact type. The reasoning that
matters is the measurement, so it travels with the rule -- 8 display
payloads for 2 real configurations, because macOS re-mints the display id
every session.

That measurement also reordered the remaining cycles: entity identity is a
PREREQUISITE of every Knowledge candidate, not the second of three.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNMAPpjspVHJU1kiuRpcba
EOF
)"
```

---

## Done when

- `src/knowledge/facts.ts` exists, is a leaf, reads no clock, and is exported from the barrel.
- `test/knowledge.current.test.ts` passes with 13 tests covering the exclusive path and all four refusals.
- `npm run typecheck`, `npm test` and `npm run build` all pass.
- `docs/internals/persistence.md` states the decision rather than deferring it; `CLAUDE.md` carries the rule and its measurement; §6.2 is marked settled.
- No table, no `schema.ts` edit, no UI, no MCP tool.
