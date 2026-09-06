# Knowledge Entity Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship cycle 1 of the Knowledge layer — a pure fold that decides when two observed payloads are one value — so the display fact stops reporting eight configurations where there are two.

**Architecture:** One leaf module, `src/knowledge/identity.ts`, holding `stableKey` and `foldByIdentity`, plus a data module `src/knowledge/identities.ts` declaring three projections. Identity is a **declared canonicalizing projection**, never a similarity measure: each fact type states the form that decides sameness, and the fold groups by a deterministic serialization of that form. `FoldedValue extends ObservedValue` and `FoldedFact extends KnowledgeFact`, so a folded fact drops into cycle 0's `currentValue` with **no change to `facts.ts`** — that structural subtyping is the entire seam. A probe renders the collapse table from the real library.

**Tech Stack:** TypeScript (strict, ESM), vitest, `tsx` for the probe. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md`

## Global Constraints

- **No table, no bucket edit, no stage, no UI, no MCP tool.** `src/store/sqlite/schema.ts` is not touched. Cycle 1 ships a fold, three declarations and a probe.
- **`src/knowledge/` is a LEAF.** No import from `store/`, `represent/`, `retrieve/`, or any adapter. No native module. No `spawn`. Barrel-safe. The only runtime import it gains is `src/trace/url.ts`, which is itself pure with no I/O and no clock.
- **`src/knowledge/facts.ts` IS NOT MODIFIED.** If a task appears to need an edit there, the seam has been built wrong — stop and re-read spec §4.
- **Nothing reads a clock.** No `Date.now()`, no `new Date()` anywhere in `src/knowledge/`.
- **Counts, never ratios.** `unidentified` is a count. Nothing in this cycle returns a fraction or a percentage — that is `FrameResult.score` under a new name.
- **NO SECOND URL RULE.** `visitedPage` calls `urlPrefix` from `src/trace/url.ts`. Writing a normalizer, a `TRACKING_PARAMS` set, or any private URL handling inside `src/knowledge/` is the specific regression `src/index.ts:506-511` exists to prevent, and it was measured: `urlPrefix` produces the same single merge the hand-written rule did.
- **The projection enumerates what it KEEPS.** A field not named by an identity is dropped, deliberately. Adding a field to `DisplayInfo` does not automatically make it discriminate.

---

## File Structure

| file | responsibility |
| --- | --- |
| `src/knowledge/identity.ts` | **create.** `stableKey`, `Identity`, `Observation`, `FoldedValue`, `FoldedFact`, `foldByIdentity`. Knows nothing about displays, apps or URLs. |
| `src/knowledge/identities.ts` | **create.** The three declarations, as data. Knows nothing about folding. |
| `src/index.ts` | **modify.** Extend the existing knowledge export block. |
| `scripts/probes/identity.ts` | **create.** Read-only, headless, renders spec §2's table from the live library. |
| `package.json` | **modify.** Add `probe:identity`. |
| `test/knowledge.identity.test.ts` | **create.** The fold and `stableKey`. |
| `test/knowledge.identities.test.ts` | **create.** The three projections, against payload shapes taken verbatim from the real library. |
| `docs/internals/persistence.md`, `CLAUDE.md`, `src/capture/env/types.ts` | **modify.** The rule, and the doc comment the measurement falsified. |

---

### Task 1: The fold and its serializer

**Files:**
- Create: `src/knowledge/identity.ts`
- Test: `test/knowledge.identity.test.ts`

**Interfaces:**
- Consumes: `KnowledgeFact`, `KnowledgeSource`, `ObservedValue` from `src/knowledge/facts.ts` (types only; that file is not modified).
- Produces: `stableKey(value: unknown): string`; `type Identity<Raw, Canon> = (value: Raw) => Canon | null`; `interface Observation<Raw> { value: Raw; source: KnowledgeSource }`; `interface FoldedValue<Raw, Canon> extends ObservedValue<Canon> { value: Canon; sources: readonly KnowledgeSource[]; variants: readonly Raw[] }`; `interface FoldedFact<Raw, Canon> extends KnowledgeFact<Canon> { values: readonly FoldedValue<Raw, Canon>[]; unidentified: number }`; `foldByIdentity<Raw, Canon>(kind: string, observations: readonly Observation<Raw>[], identity: Identity<Raw, Canon>): FoldedFact<Raw, Canon>`.

- [ ] **Step 1: Write the failing test**

Create `test/knowledge.identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { currentValue, type KnowledgeSource } from "../src/knowledge/facts.js";
import {
  foldByIdentity,
  stableKey,
  type Identity,
  type Observation,
} from "../src/knowledge/identity.js";

/** A source: which recording saw it, and how far into that recording. */
const at = (sessionId: string, tMono = 0): KnowledgeSource => ({ sessionId, tMono });

const obs = <R>(value: R, sessionId: string, tMono = 0): Observation<R> => ({
  value,
  source: at(sessionId, tMono),
});

/** A payload with a decoy: `id` is re-minted per session, `w`/`h` are not. */
interface Screen {
  id: string;
  w: number;
  h: number;
}
const geometry: Identity<Screen, { w: number; h: number }> = (s) => ({ w: s.w, h: s.h });

describe("stableKey", () => {
  it("is independent of object key order", () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
  });

  it("is sensitive to array order, because order is the identity's business", () => {
    expect(stableKey([1, 2])).not.toBe(stableKey([2, 1]));
  });

  it("omits an undefined property, so an optional field that is absent is absent", () => {
    expect(stableKey({ a: 1, b: undefined })).toBe(stableKey({ a: 1 }));
  });

  it("keeps an undefined array element positional, so a hole cannot shift its neighbours", () => {
    expect(stableKey([1, undefined, 2])).not.toBe(stableKey([1, 2]));
  });

  it("distinguishes the string \"1\" from the number 1", () => {
    expect(stableKey({ a: "1" })).not.toBe(stableKey({ a: 1 }));
  });

  it("throws rather than serializing something an identity should never return", () => {
    expect(() => stableKey({ f: () => 1 })).toThrow(/serialize/i);
    expect(() => stableKey({ n: Number.NaN })).toThrow(/finite/i);
  });
});

describe("foldByIdentity", () => {
  it("collapses payloads that differ only in a decoy field", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "185", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.value).toEqual({ w: 1920, h: 1080 });
  });

  it("unions the sources of every observation it folded", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "185", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    expect(f.values[0]!.sources.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("keeps the distinct raw payloads as variants, in first-observed order", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "185", w: 1920, h: 1080 }, "s1"), obs({ id: "180", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    expect(f.values[0]!.variants.map((v) => v.id)).toEqual(["185", "180"]);
  });

  it("does not duplicate a raw payload observed twice, but keeps both sources", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "206", w: 1920, h: 1080 }, "s1"), obs({ id: "206", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    expect(f.values[0]!.variants).toHaveLength(1);
    expect(f.values[0]!.sources).toHaveLength(2);
  });

  it("keeps genuinely different values apart", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "1", w: 1728, h: 1117 }, "s2")],
      geometry,
    );
    expect(f.values).toHaveLength(2);
  });

  it("counts an unidentifiable observation instead of dropping it silently", () => {
    const maybe: Identity<Screen, { w: number; h: number }> = (s) =>
      s.w === 0 ? null : { w: s.w, h: s.h };
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "x", w: 0, h: 0 }, "s2")],
      maybe,
    );
    expect(f.unidentified).toBe(1);
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.sources).toHaveLength(1);
  });

  it("returns an empty fact rather than throwing on no observations", () => {
    const f = foldByIdentity("display", [], geometry);
    expect(f).toEqual({ kind: "display", values: [], unidentified: 0 });
  });

  it("IS a KnowledgeFact, so cycle 0's resolver reads it unchanged", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "185", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    const starts: Record<string, number> = { s1: 1000, s2: 2000 };
    const current = currentValue(f, "exclusive", (id) => starts[id]);
    expect(current.value).toEqual({ w: 1920, h: 1080 });
    expect(current.alternatives).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge.identity.test.ts`
Expected: FAIL — `Cannot find module '../src/knowledge/identity.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/knowledge/identity.ts`:

```ts
/**
 * Cross-recording entity identity — when two observed payloads are one value.
 *
 * ## What this is
 *
 * `facts.ts` ships the Knowledge layer's semantics and records exactly one
 * thing it refuses to do: it does not decide whether two values are the SAME
 * value. Fed the real library's 8 `display_change` payloads it reports 8, where
 * there are 2 configurations. This module is that decision. See
 * `docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md`.
 *
 * ## Why a projection and not a similarity measure
 *
 * Sameness could be measured — embed the payloads, cluster under a threshold —
 * and that is declined on evidence rather than taste. There is no ground truth
 * on a 12-recording library to sweep a threshold against, `probe:embed`'s first
 * version is this repo's standing lesson about what a metric scored without
 * ground truth measures, and it would put a model inside a module whose
 * defining property is that it has no dependency at all.
 *
 * So identity is DECLARED, per fact type, as a projection: the form that
 * decides sameness. Two payloads are one value when they project to the same
 * form. `identities.ts` holds the declarations.
 *
 * ## Why the CANONICAL form and not a surviving representative
 *
 * Keeping one observed payload per group is appealing — every value shown was
 * really seen. But the survivor still carries `id: "180"`, the exact field the
 * fold exists to declare meaningless, sitting in the value a consumer prints. A
 * projection makes the decoy STRUCTURALLY unable to reach a consumer, and the
 * canonical form is the only value true of every observation it stands for.
 *
 * The cost is that the value shown was never literally observed, and it is paid
 * for by disclosure: `variants` carries the distinct raw payloads.
 *
 * ## The seam
 *
 * `FoldedValue extends ObservedValue` and `FoldedFact extends KnowledgeFact`, so
 * a folded fact IS a fact and drops into `currentValue` with no change to
 * `facts.ts` and no change to its tests. That is deliberate and it is asserted:
 * if this file ever needs an edit there, the seam has been built wrong.
 */

import type { KnowledgeFact, KnowledgeSource, ObservedValue } from "./facts.js";

/**
 * Reduces an observed payload to the form that decides sameness.
 *
 * `null` is an observation this identity cannot place — a URL naming no site, a
 * focus event with no application name. Disclosed as a count, never dropped, on
 * `Current.undated`'s precedent.
 */
export type Identity<Raw, Canon> = (value: Raw) => Canon | null;

/** One observation: a raw payload, and the recording that saw it. */
export interface Observation<Raw> {
  value: Raw;
  source: KnowledgeSource;
}

/** One folded value: the canonical form, every source, every raw form it stands for. */
export interface FoldedValue<Raw, Canon> extends ObservedValue<Canon> {
  value: Canon;
  sources: readonly KnowledgeSource[];
  /**
   * The distinct raw payloads under this identity, in the order they arrived in
   * `observations` — which the caller controls and the fold never re-sorts.
   * Distinct by `stableKey`, so a payload observed in four recordings is one
   * variant with four sources.
   */
  variants: readonly Raw[];
}

/** A fact whose values are distinct under an identity rather than under equality. */
export interface FoldedFact<Raw, Canon> extends KnowledgeFact<Canon> {
  kind: string;
  values: readonly FoldedValue<Raw, Canon>[];
  /** Observations the identity returned `null` for. A count, never a ratio. */
  unidentified: number;
}

/**
 * A deterministic string for a canonical form.
 *
 * `JSON.stringify` alone is key-order dependent, so two identical forms built by
 * different code paths would not group. Object keys are sorted; ARRAY ORDER IS
 * PRESERVED, because whether order is meaningful is a property of the fact and
 * therefore the identity's business — `displayTopology` sorts its own list.
 *
 * The collapsing cases are pinned rather than left to `JSON.stringify`'s
 * defaults. An `undefined` property is omitted, so an absent optional field and
 * a field set to `undefined` are one key. An `undefined` inside an ARRAY becomes
 * `null` positionally, so a hole never shortens the array and silently changes
 * what its neighbours mean. Anything else — a function, a symbol, a non-finite
 * number — is a programming error in an identity function and THROWS: JSON would
 * quietly render `NaN` as `null`, folding a broken geometry into a value it is
 * not.
 */
export function stableKey(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`stableKey needs a finite number, got ${String(value)}`);
      }
      return String(value);
    case "object":
      break;
    default:
      throw new TypeError(`stableKey cannot serialize a ${typeof value}`);
  }

  if (Array.isArray(value)) {
    const parts = value.map((v) => (v === undefined ? "null" : stableKey(v)));
    return `[${parts.join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(",")}}`;
}

/**
 * Fold many raw observations into a fact whose values are distinct under
 * `identity`.
 *
 * Insertion order is preserved for both values and variants, so the output is a
 * deterministic function of the input order and nothing sorts behind the
 * caller's back.
 */
export function foldByIdentity<Raw, Canon>(
  kind: string,
  observations: readonly Observation<Raw>[],
  identity: Identity<Raw, Canon>,
): FoldedFact<Raw, Canon> {
  interface Group {
    value: Canon;
    sources: KnowledgeSource[];
    variants: Raw[];
    seen: Set<string>;
  }
  const groups = new Map<string, Group>();
  let unidentified = 0;

  for (const observation of observations) {
    const canon = identity(observation.value);
    if (canon === null) {
      unidentified += 1;
      continue;
    }
    const key = stableKey(canon);
    let group = groups.get(key);
    if (group === undefined) {
      group = { value: canon, sources: [], variants: [], seen: new Set() };
      groups.set(key, group);
    }
    group.sources.push(observation.source);
    const rawKey = stableKey(observation.value);
    if (!group.seen.has(rawKey)) {
      group.seen.add(rawKey);
      group.variants.push(observation.value);
    }
  }

  return {
    kind,
    values: [...groups.values()].map((g) => ({
      value: g.value,
      sources: g.sources,
      variants: g.variants,
    })),
    unidentified,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/knowledge.identity.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both pass. `test/knowledge.current.test.ts` must still pass **unmodified** — that is the seam holding.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/identity.ts test/knowledge.identity.test.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): the fold that decides two payloads are one value

Cycle 0 shipped a resolver that refuses to say whether two values are the
same, and reports 8 display configurations where there are 2. This is the
fold that answers it.

Identity is a DECLARED CANONICALIZING PROJECTION, not a similarity measure:
no ground truth exists on a 12-recording library to sweep a threshold
against, and probe:embed's first version is the standing lesson about what a
metric scored without ground truth measures.

The canonical form rather than a surviving representative payload, because a
survivor still carries the `id: "180"` the fold exists to declare meaningless,
in the value a consumer prints. Its cost -- a value nobody literally observed
-- is paid for by `variants`.

FoldedFact extends KnowledgeFact, so a folded fact drops into currentValue
with facts.ts unmodified and its tests unmodified. That is the whole seam.

stableKey pins the two cases JSON gets wrong for a grouping key: key order,
and NaN, which JSON renders as null and would fold a broken geometry into a
value it is not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012cDnhzgDHFW5hhifhVwGHc
EOF
)"
```

---

### Task 2: The three identities

**Files:**
- Create: `src/knowledge/identities.ts`
- Test: `test/knowledge.identities.test.ts`

**Interfaces:**
- Consumes: `Identity` from `src/knowledge/identity.ts`; `Exclusivity` from `src/knowledge/facts.ts`; `DisplayInfo` (type-only) from `src/capture/env/types.ts`; `urlPrefix` from `src/trace/url.ts`.
- Produces: `type DisplayGeometry`; `interface DisplayTopologyPayload { displays: readonly DisplayInfo[] }`; `interface FocusPayload { app?: string; bundleId?: string }`; `interface IdentityDeclaration<Raw, Canon> { kind: string; exclusivity: Exclusivity; identity: Identity<Raw, Canon> }`; and three declarations `DISPLAY_TOPOLOGY`, `FOCUSED_APP`, `VISITED_PAGE`.

- [ ] **Step 1: Write the failing test**

Create `test/knowledge.identities.test.ts`. Every payload below is taken verbatim from the author's real library on 2026-09-06.

```ts
import { describe, expect, it } from "vitest";
import { foldByIdentity, type Observation } from "../src/knowledge/identity.js";
import {
  DISPLAY_TOPOLOGY,
  FOCUSED_APP,
  VISITED_PAGE,
  type DisplayTopologyPayload,
  type FocusPayload,
} from "../src/knowledge/identities.js";

const obs = <R>(value: R, sessionId: string): Observation<R> => ({
  value,
  source: { sessionId, tMono: 0 },
});

/** The 1920x1080@2 primary, under the `id` macOS re-minted that session. */
const solo = (id: string): DisplayTopologyPayload => ({
  displays: [{ id, x: 0, y: 0, w: 1920, h: 1080, scale: 2, primary: true }],
});

/** The one genuine second configuration: docked laptop plus a 4K external. */
const docked: DisplayTopologyPayload = {
  displays: [
    { id: "1", x: 0, y: 0, w: 1728, h: 1117, scale: 2, primary: true },
    { id: "5", x: -3840, y: -797, w: 3840, h: 2160, scale: 1, primary: false },
  ],
};

describe("DISPLAY_TOPOLOGY", () => {
  it("folds the library's seven re-minted ids into one configuration", () => {
    const ids = ["180", "185", "206", "206", "206", "206", "219", "247", "247", "296", "297"];
    const f = foldByIdentity(
      "display_change",
      ids.map((id, i) => obs(solo(id), `s${i}`)),
      DISPLAY_TOPOLOGY.identity,
    );
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.sources).toHaveLength(11);
    expect(f.values[0]!.variants).toHaveLength(7);
  });

  it("keeps the docked configuration apart, because geometry discriminates", () => {
    const f = foldByIdentity(
      "display_change",
      [obs(solo("180"), "s1"), obs(docked, "s2")],
      DISPLAY_TOPOLOGY.identity,
    );
    expect(f.values).toHaveLength(2);
  });

  it("is insensitive to the order the OS reports displays in", () => {
    const reversed: DisplayTopologyPayload = { displays: [...docked.displays].reverse() };
    const f = foldByIdentity(
      "display_change",
      [obs(docked, "s1"), obs(reversed, "s2")],
      DISPLAY_TOPOLOGY.identity,
    );
    expect(f.values).toHaveLength(1);
  });

  it("discriminates on scale, which is geometry and not a decoy", () => {
    const half: DisplayTopologyPayload = {
      displays: [{ id: "180", x: 0, y: 0, w: 1920, h: 1080, scale: 1, primary: true }],
    };
    const f = foldByIdentity(
      "display_change",
      [obs(solo("180"), "s1"), obs(half, "s2")],
      DISPLAY_TOPOLOGY.identity,
    );
    expect(f.values).toHaveLength(2);
  });

  it("refuses an empty topology, which is a failed display source and not a configuration", () => {
    expect(DISPLAY_TOPOLOGY.identity({ displays: [] })).toBeNull();
  });

  it("is coexisting: a laptop is docked some days and not others", () => {
    expect(DISPLAY_TOPOLOGY.exclusivity).toBe("coexisting");
  });
});

describe("FOCUSED_APP", () => {
  it("folds every window of one app, whatever windowId, pid and bounds say", () => {
    /** The real payload, decoys included — `FocusPayload` names only what is read. */
    interface RealFocus extends FocusPayload {
      windowId: number;
      bounds: { x: number };
    }
    const calc = (windowId: number, x: number): RealFocus => ({
      app: "Calculator",
      bundleId: "com.apple.calculator",
      windowId,
      bounds: { x },
    });
    const f = foldByIdentity(
      "focus_change",
      [obs(calc(398911, 150), "s1"), obs(calc(385609, 133), "s2"), obs(calc(379910, 118), "s3")],
      FOCUSED_APP.identity,
    );
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.value).toBe("com.apple.calculator");
    expect(f.values[0]!.variants).toHaveLength(3);
  });

  it("keeps two apps apart", () => {
    const f = foldByIdentity(
      "focus_change",
      [
        obs({ app: "Calculator", bundleId: "com.apple.calculator" }, "s1"),
        obs({ app: "TextEdit", bundleId: "com.apple.TextEdit" }, "s2"),
      ],
      FOCUSED_APP.identity,
    );
    expect(f.values).toHaveLength(2);
  });

  it("falls back to the app name when bundleId is absent", () => {
    expect(FOCUSED_APP.identity({ app: "Calculator" })).toBe("Calculator");
  });

  it("treats an EMPTY bundleId as absent, the way both AX sidecars do", () => {
    expect(FOCUSED_APP.identity({ app: "Calculator", bundleId: "" })).toBe("Calculator");
  });

  it("refuses a payload that names no application at all", () => {
    expect(FOCUSED_APP.identity({})).toBeNull();
    expect(FOCUSED_APP.identity({ app: "", bundleId: "" })).toBeNull();
  });
});

describe("VISITED_PAGE", () => {
  it("merges the one pair the real library merges", () => {
    const f = foldByIdentity(
      "url_change",
      [
        obs("https://www.linkedin.com/notifications/", "s1"),
        obs(
          "https://www.linkedin.com/notifications/?skipRedirect=true&lipi=urn%3Ali%3Apage%3Ad_flagship3_feed%3BRBVWEc2ZR4eqJ1zJdf3Glw%3D%3D",
          "s2",
        ),
      ],
      VISITED_PAGE.identity,
    );
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.value).toBe("linkedin.com/notifications");
    expect(f.values[0]!.variants).toHaveLength(2);
  });

  it("keeps two pages of one site apart, because the grain is the site path", () => {
    const f = foldByIdentity(
      "url_change",
      [
        obs("https://inman-perk-coffee.vercel.app/menu", "s1"),
        obs("https://inman-perk-coffee.vercel.app/about", "s2"),
      ],
      VISITED_PAGE.identity,
    );
    expect(f.values).toHaveLength(2);
  });

  it("refuses a URL that names no site, rather than inventing a value for it", () => {
    expect(VISITED_PAGE.identity("chrome://new-tab-page/")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/knowledge.identities.test.ts`
Expected: FAIL — `Cannot find module '../src/knowledge/identities.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/knowledge/identities.ts`:

```ts
/**
 * The declared identities — which field decides sameness, per fact type.
 *
 * Data, not branches, on `src/embed/text-profiles.ts`'s precedent: a type's
 * quirks belong in a table because all of them fail silently when guessed. Each
 * declaration carries its projection, its exclusivity, and the measurement that
 * justifies it, because the measurement is what a later session needs before
 * changing one.
 *
 * A PROJECTION ENUMERATES WHAT IT KEEPS. A field a projection does not name is
 * dropped deliberately, so adding a field to `DisplayInfo` does not make it
 * discriminate — that is a decision, and it is made here.
 *
 * All measurements below are from the author's real library on 2026-09-06: 12
 * recordings, 2026-08-17 -> 2026-08-29, SQLite opened read-only. `npm run
 * probe:identity` re-renders them.
 */

import type { DisplayInfo } from "../capture/env/types.js";
import { urlPrefix } from "../trace/url.js";
import type { Exclusivity } from "./facts.js";
import type { Identity } from "./identity.js";

/** One declared identity: the fact it is for, whether its values coexist, and the projection. */
export interface IdentityDeclaration<Raw, Canon> {
  /** The `event.kind` this identity reads. */
  kind: string;
  exclusivity: Exclusivity;
  identity: Identity<Raw, Canon>;
}

/** One display's geometry, with the OS-minted `id` gone. */
export type DisplayGeometry = readonly [
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  primary: boolean,
];

/** The `display_change` payload, as `ActiveWindowProducer` emits it. */
export interface DisplayTopologyPayload {
  displays: readonly DisplayInfo[];
}

/** Lexicographic over the tuple, so the OS's report order cannot mint a second value. */
function compareGeometry(a: DisplayGeometry, b: DisplayGeometry): number {
  for (let i = 0; i < 5; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return Number(a[5]) - Number(b[5]);
}

/**
 * `display_change` -> the sorted geometry of every display, `id` dropped.
 *
 * MEASURED: 12 occurrences, 8 distinct payloads, **2** configurations. Seven of
 * the eight are the same 1920x1080@2 primary under a different `id` each session
 * (180, 185, 206, 219, 247, 296, 297) — macOS re-mints the identifier, so `id`
 * is a decoy and geometry is the discriminator. Keying a Knowledge fact on it
 * would have minted 8 facts where there are 2, on the first data it ever saw.
 *
 * COEXISTING: the two real configurations do not supersede one another. A laptop
 * is docked some days and not others, so "newer wins" would delete one that is
 * still true.
 *
 * An EMPTY list is `null`, not a configuration. `coerceDisplays` yields `[]` when
 * the display source fails, and a failed query is not a desktop with no screens.
 */
export const DISPLAY_TOPOLOGY: IdentityDeclaration<DisplayTopologyPayload, readonly DisplayGeometry[]> =
  {
    kind: "display_change",
    exclusivity: "coexisting",
    identity: (payload) => {
      if (payload.displays.length === 0) return null;
      const geometry = payload.displays.map(
        (d): DisplayGeometry => [d.x, d.y, d.w, d.h, d.scale, d.primary],
      );
      return geometry.sort(compareGeometry);
    },
  };

/** The fields of a `focus_change` payload this identity reads. */
export interface FocusPayload {
  app?: string;
  bundleId?: string;
}

/**
 * An EMPTY string is ABSENT. Both Swift sidecars already treat `AXTitle: ""`
 * that way, and the one place they disagreed cost a whole node its verification.
 */
const nonEmpty = (s: string | undefined): string | null =>
  s !== undefined && s.length > 0 ? s : null;

/**
 * `focus_change` -> the application's bundle id.
 *
 * DROPS `windowId`, `pid`, `bounds`, `title` and `url`. There are three decoys
 * here, not one: `windowId` and `pid` are re-minted per launch, and `bounds`
 * DRIFTS — the Calculator's main window was observed at (150, 231), (133, 242)
 * and (118, 253) across three recordings of the same work.
 *
 * MEASURED: 92 occurrences, 63 distinct payloads, **7** bundle ids. THE TARGET
 * NUMBER IS QUESTION-DEPENDENT and that is why the question is declared here
 * rather than inferred: by `(bundleId, title)` the answer is 28, by `windowId`
 * it is 40, and all three are correct answers to different questions. A consumer
 * that wants 28 wants a SECOND identity, not an edit to this one.
 *
 * COEXISTING: seven applications are used, and no one of them is *the* app.
 */
export const FOCUSED_APP: IdentityDeclaration<FocusPayload, string> = {
  kind: "focus_change",
  exclusivity: "coexisting",
  identity: (payload) => nonEmpty(payload.bundleId) ?? nonEmpty(payload.app),
};

/**
 * `url_change` -> `urlPrefix`, CALLED, NOT REIMPLEMENTED.
 *
 * A hand-written normalizer — lowercase, strip tracking parameters, drop the
 * trailing slash — was measured first and merged exactly one pair in nineteen.
 * `urlPrefix` merges the SAME pair. Equal results, so the tie goes to the rule
 * that already ships, and to the note `src/index.ts` carries: it is exported so
 * anything reading a recorded URL reads it the way node identity does, "rather
 * than growing a second, quietly different prefix rule." Writing one here would
 * have been that rule, and it would have looked correct.
 *
 * MEASURED: 44 occurrences, 19 distinct payloads, **17** identified plus **3**
 * unidentified. The three are `chrome://new-tab-page/`, which names no site —
 * `urlPrefix` already returns `undefined` for `file:`, `chrome:` and `about:`,
 * and passing that through as `null` discloses them instead of inventing an
 * eighteenth site.
 *
 * The grain is the SITE: `urlPrefix` caps at three path segments and drops query
 * and fragment, so two pages of one site stay apart while a scroll anchor does
 * not mint a value. Adopting it means the Knowledge layer and the trace graph
 * cannot drift on what a URL IS.
 */
export const VISITED_PAGE: IdentityDeclaration<string, string> = {
  kind: "url_change",
  exclusivity: "coexisting",
  identity: (url) => urlPrefix(url) ?? null,
};

/**
 * `keymap_change` has NO identity, and that is a finding rather than an omission:
 * 12 occurrences and ONE distinct payload on the real library, so a projection
 * would buy zero. Recorded here so it is not added for symmetry.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/knowledge.identities.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both pass, and `test/knowledge.current.test.ts` is still unmodified.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/identities.ts test/knowledge.identities.test.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): three declared identities, and the numbers behind each

Data, not branches, on text-profiles.ts's precedent. Each declaration carries
the measurement that justifies it, because the measurement is what a later
session needs before changing one.

display_change: 12 / 8 / 2. Geometry discriminates and `id` is a decoy macOS
re-mints per session. Coexisting -- a laptop is docked some days and not
others, so "newer wins" would delete a configuration that is still true. An
empty list is null: a failed display source is not a desktop with no screens.

focus_change: 92 / 63 / 7 bundle ids, and the target number is
QUESTION-DEPENDENT -- 28 by (bundleId, title), 40 by windowId. So the question
is declared, not inferred, and a consumer wanting 28 wants a second identity.
Three decoys, not one: windowId, pid, and bounds, which DRIFTS by pixels
between launches of the same window. An empty string is absent, the rule both
Swift sidecars already hold.

url_change: urlPrefix, called, not reimplemented. A hand-written normalizer
merged one pair in nineteen; urlPrefix merges the same pair. Equal results,
so the tie goes to the rule that ships -- and its `undefined` for
chrome://new-tab-page/ gives `unidentified` a real case, 3 of 44.

keymap_change gets none: 12 occurrences, 1 payload.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012cDnhzgDHFW5hhifhVwGHc
EOF
)"
```

---

### Task 3: Barrel export

**Files:**
- Modify: `src/index.ts` (the knowledge export block, currently ending at the `./knowledge/facts.js` re-export)
- Test: `test/knowledge.identity.test.ts` (append one case)

**Interfaces:**
- Consumes: the shipped `src/knowledge/identity.ts` and `src/knowledge/identities.ts`.
- Produces: `foldByIdentity`, `stableKey`, `DISPLAY_TOPOLOGY`, `FOCUSED_APP`, `VISITED_PAGE` and their types, importable from `deskrag`.

- [ ] **Step 1: Write the failing test**

Append to `test/knowledge.identity.test.ts`:

```ts
describe("the barrel", () => {
  it("exports the fold and the declarations, and loads nothing native", async () => {
    const barrel = await import("../src/index.js");
    expect(typeof barrel.foldByIdentity).toBe("function");
    expect(typeof barrel.stableKey).toBe("function");
    expect(barrel.DISPLAY_TOPOLOGY.kind).toBe("display_change");
    expect(barrel.FOCUSED_APP.kind).toBe("focus_change");
    expect(barrel.VISITED_PAGE.kind).toBe("url_change");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge.identity.test.ts -t "exports the fold"`
Expected: FAIL — `barrel.foldByIdentity is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/index.ts`, immediately after the existing block that ends `} from "./knowledge/facts.js";`, insert:

```ts
/**
 * Cross-recording entity identity — when two observed payloads are one value.
 * A projection declared per fact type, never a similarity measure, and the
 * companion of `currentValue`: a `FoldedFact` IS a `KnowledgeFact`, so the
 * resolver above reads one unchanged. Pure, a leaf, loads nothing native. See
 * `knowledge/identity.ts` and docs/internals/persistence.md.
 */
export {
  foldByIdentity,
  stableKey,
  type FoldedFact,
  type FoldedValue,
  type Identity,
  type Observation,
} from "./knowledge/identity.js";
export {
  DISPLAY_TOPOLOGY,
  FOCUSED_APP,
  VISITED_PAGE,
  type DisplayGeometry,
  type DisplayTopologyPayload,
  type FocusPayload,
  type IdentityDeclaration,
} from "./knowledge/identities.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/knowledge.identity.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Run the gates, including the build the app depends on**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three pass. The build matters because the app imports `dist/`, not `src/`.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/knowledge.identity.test.ts
git commit -m "$(cat <<'EOF'
feat(knowledge): export the fold and the declarations from the barrel

Placed directly beside currentValue, which it is the companion of: a
FoldedFact IS a KnowledgeFact, and the point of the pairing is that the
resolver reads one with no change to facts.ts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012cDnhzgDHFW5hhifhVwGHc
EOF
)"
```

---

### Task 4: `npm run probe:identity`

**Files:**
- Create: `scripts/probes/identity.ts`
- Modify: `package.json` (the `probe:*` block, alphabetically between `probe:highlight` and `probe:latency`)

**Interfaces:**
- Consumes: `foldByIdentity` and the three declarations from `src/`; `openReadOnly` and `DB_PATH` from `scripts/lib/paths.ts`; `note`, `ok`, `section`, `summary`, `padEnd`, `padStart` from `scripts/lib/report.ts`. It does **not** call `refuseBarePositionals` — that is opt-in for a probe whose entire interface is flags, and this one takes none.
- Produces: nothing importable. A measurement on stdout and an exit code.

- [ ] **Step 1: Write the probe**

There is no failing-test step here: a probe's subject is the real library, and the suite has no library. Its correctness is checked by running it in Step 2 against numbers this plan states in advance.

Create `scripts/probes/identity.ts`:

```ts
/**
 * Which observed payloads are ONE value, on the library that exists.
 *
 * The Knowledge layer's identities are projections declared per fact type, and
 * every declaration in `src/knowledge/identities.ts` carries a number from a
 * measurement. This is that measurement, so the numbers stay re-checkable
 * instead of being frozen in a doc comment: `display_change` folding 8 payloads
 * into 2 is the claim the whole cycle rests on.
 *
 * READ-ONLY: SQLite is opened `mode=ro`, the output is stdout, and nothing here
 * constructs a DualStore. HEADLESS, for probe:baseline's reason -- the app takes
 * no single-instance lock and WRITES on startup, so launching it would make a
 * second owner of SQLite.
 *
 * PRINTS THE CORPUS FIRST and refuses under two recordings, where
 * cross-recording identity is not a thing that can be measured and the table
 * would be an empty result wearing a verdict.
 */

import { DB_PATH, openReadOnly } from "../lib/paths.js";
import { note, ok, padEnd, padStart, section, summary } from "../lib/report.js";
import { foldByIdentity, type Observation } from "../../src/knowledge/identity.js";
import {
  DISPLAY_TOPOLOGY,
  FOCUSED_APP,
  VISITED_PAGE,
  type DisplayTopologyPayload,
  type FocusPayload,
  type IdentityDeclaration,
} from "../../src/knowledge/identities.js";

// No `refuseBarePositionals` here, deliberately: it is opt-in for a probe whose
// entire interface is flags, and this one takes none, so there is no flag npm
// could swallow.

interface EventRow {
  session_id: string;
  t_mono: number;
  data: string | null;
}

const db = openReadOnly(DB_PATH);

const sessions = db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number };
const span = db
  .prepare(
    "SELECT MIN(date(started_at/1000,'unixepoch')) AS lo, MAX(date(started_at/1000,'unixepoch')) AS hi FROM session",
  )
  .get() as { lo: string | null; hi: string | null };

section("Corpus");
note("library", DB_PATH);
note("recordings", `${sessions.n}${span.lo === null ? "" : ` (${span.lo} -> ${span.hi})`}`);

if (sessions.n < 2) {
  console.log(
    "\nRefusing: cross-recording identity needs at least two recordings. " +
      "With one, every payload is from the same session and the table below would " +
      "be an empty result wearing a verdict.",
  );
  db.close();
  process.exit(1);
}

/** Read every payload of one kind, parsed, in recording order. */
function observations<R>(kind: string): Observation<R>[] {
  const rows = db
    .prepare("SELECT session_id, t_mono, data FROM event WHERE kind = ? ORDER BY session_id, t_mono")
    .all(kind) as EventRow[];
  const out: Observation<R>[] = [];
  for (const row of rows) {
    if (row.data === null) continue;
    out.push({
      value: JSON.parse(row.data) as R,
      source: { sessionId: row.session_id, tMono: row.t_mono },
    });
  }
  return out;
}

/** `url_change` stores `{url}`; the identity takes the string itself. */
function urlObservations(): Observation<string>[] {
  const out: Observation<string>[] = [];
  for (const o of observations<{ url?: string }>("url_change")) {
    const url = o.value.url;
    if (typeof url === "string") out.push({ value: url, source: o.source });
  }
  return out;
}

interface Row {
  kind: string;
  occurrences: number;
  raw: number;
  folded: number;
  unidentified: number;
}

function measure<Raw, Canon>(
  decl: IdentityDeclaration<Raw, Canon>,
  obs: readonly Observation<Raw>[],
): Row {
  const folded = foldByIdentity(decl.kind, obs, decl.identity);
  const raw = new Set(obs.map((o) => JSON.stringify(o.value))).size;
  return {
    kind: decl.kind,
    occurrences: obs.length,
    raw,
    folded: folded.values.length,
    unidentified: folded.unidentified,
  };
}

const rows: Row[] = [
  measure(DISPLAY_TOPOLOGY, observations<DisplayTopologyPayload>("display_change")),
  measure(FOCUSED_APP, observations<FocusPayload>("focus_change")),
  measure(VISITED_PAGE, urlObservations()),
];

section("What identity collapses");
console.log(
  `  ${padEnd("kind", 16)}${padStart("occurrences", 12)}${padStart("raw", 6)}${padStart("folded", 8)}${padStart("unidentified", 14)}`,
);
for (const r of rows) {
  console.log(
    `  ${padEnd(r.kind, 16)}${padStart(r.occurrences, 12)}${padStart(r.raw, 6)}${padStart(r.folded, 8)}${padStart(r.unidentified, 14)}`,
  );
}

// keymap_change is measured but has no identity, and the reason is the number.
const keymaps = observations<unknown>("keymap_change");
const keymapRaw = new Set(keymaps.map((o) => JSON.stringify(o.value))).size;
section("Declined");
note(
  "keymap_change",
  `${keymaps.length} occurrences, ${keymapRaw} distinct payload${keymapRaw === 1 ? "" : "s"} — ` +
    `${keymapRaw <= 1 ? "an identity would buy nothing" : "WORTH RE-READING: it now has more than one"}`,
);

section("Checks");
for (const r of rows) {
  ok(
    `${r.kind} folds`,
    r.folded <= r.raw,
    `${r.raw} raw -> ${r.folded} folded`,
    "a fold can never produce more values than it was given",
  );
}
ok(
  "every observation is accounted for",
  rows.every((r) => r.folded > 0 || r.occurrences === r.unidentified),
  "",
  "a kind with observations but no values and no unidentified count has lost data",
);

db.close();
process.exit(summary("probe:identity"));
```

- [ ] **Step 2: Register it and run it against the real library**

Add to `package.json`, in the `probe:*` block between `probe:highlight` and `probe:latency`:

```json
    "probe:identity": "tsx scripts/probes/identity.ts",
```

Run: `npm run probe:identity`

Expected on the author's 12-recording library (2026-08-17 → 2026-08-29) — these are the numbers spec §2 states, and a mismatch means either the library has changed or an identity is wrong:

```
  kind             occurrences   raw  folded  unidentified
  display_change            12     8       2             0
  focus_change              92    63       7             0
  url_change                44    19      17             3
```

`keymap_change` reports 12 occurrences and 1 distinct payload. All checks pass, exit 0.

**On a different library the numbers will differ and that is fine** — what must hold is the checks and the shape: `folded <= raw` for every kind, and no kind with observations reporting neither values nor unidentified. If `display_change` folds to something other than the count of genuinely different desktops, that is a finding and the identity is wrong; say so rather than editing the expectation.

- [ ] **Step 3: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both pass. `scripts/` is TypeScript under `tsx` and is covered by `typecheck` — that is the point, and it has found live bugs in probes before.

- [ ] **Step 4: Commit**

```bash
git add scripts/probes/identity.ts package.json
git commit -m "$(cat <<'EOF'
feat(knowledge): probe:identity, so the collapse numbers stay re-checkable

Every identity declaration carries a number, and 8 display payloads folding
into 2 is the claim the whole cycle rests on. A number in a doc comment is
frozen; this re-renders it from the library that exists.

Read-only (SQLite mode=ro, stdout, no DualStore) and HEADLESS for
probe:baseline's reason: the app takes no single-instance lock and writes on
startup, so launching it would make a second owner of SQLite.

Prints the corpus first and REFUSES under two recordings, where every payload
is from one session and the table would be an empty result wearing a verdict.
It also reports keymap_change, which has no identity -- the reason it has none
IS the number, so the number is printed rather than asserted from memory.

Measured 2026-09-06 over 12 recordings: display_change 12/8/2, focus_change
92/63/7, url_change 44/19/17 with 3 unidentified.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012cDnhzgDHFW5hhifhVwGHc
EOF
)"
```

---

### Task 5: Make the rule findable, and correct the comment the measurement falsified

**Files:**
- Modify: `docs/internals/persistence.md` (the `### The decision, made 2026-09-04` section — append, do not rewrite)
- Modify: `CLAUDE.md` (one bullet under *Trace IR and the executor*, and the `probe:*` block under *Commands*)
- Modify: `src/capture/env/types.ts` (the `DisplayInfo.id` doc comment)
- Modify: `docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md` (the status line)

**Interfaces:**
- Consumes: the shipped modules and the probe's output.
- Produces: nothing in code. This is what stops a future session relitigating the decision or re-adding a URL rule.

- [ ] **Step 1: Correct the `DisplayInfo.id` comment**

`src/capture/env/types.ts` currently says:

```ts
  /** Stable for the boot; the NSScreen display id as a string. */
  id: string;
```

That is what the measurement falsified — it reads as a stability promise, and a Knowledge fact keyed on it would mint eight configurations where there are two. Replace with:

```ts
  /**
   * The NSScreen display id as a string. STABLE FOR THE BOOT AND NO LONGER:
   * measured across 12 recordings, the same 1920x1080@2 primary carried seven
   * different ids (180, 185, 206, 219, 247, 296, 297) because macOS re-mints it.
   * Safe to correlate WITHIN a session — which is all `displayIdAt` does — and
   * never across recordings. `DISPLAY_TOPOLOGY` in `src/knowledge/identities.ts`
   * drops it for exactly this reason.
   */
  id: string;
```

- [ ] **Step 2: Append the identity rule to `docs/internals/persistence.md`**

Find the paragraph in `### The decision, made 2026-09-04` beginning `**It does not decide whether two values are the same value.**` and, immediately after that paragraph (leaving it intact — it is the record of what cycle 0 refused), insert:

```markdown
**Cycle 1 answered it, 2026-09-06, and identity is a DECLARED PROJECTION.**
`src/knowledge/identity.ts` folds many observations into values that are
distinct under an identity rather than under equality; a `FoldedFact` **is** a
`KnowledgeFact`, so `currentValue` reads one with `facts.ts` unmodified. Each
fact type declares the form that decides sameness — `displayTopology` drops the
re-minted `id` and sorts the list, `focusedApp` keeps `bundleId`, `visitedPage`
**calls `urlPrefix`**. Sameness could instead have been *measured*, by embedding
the payloads and clustering under a threshold, and that was declined on
evidence: there is no ground truth on a 12-recording library to sweep a
threshold against, and `probe:embed`'s first version is the standing lesson
about what a metric scored without ground truth measures.

Three things it does not do, each deliberate. **It enumerates what it keeps**, so
a new field on `DisplayInfo` does not silently become a discriminator. **It
writes no URL rule**: a hand-written normalizer was measured against `urlPrefix`
and merged the same single pair, so the tie went to the rule that ships and the
two layers cannot drift on what a URL is. And **an observation it cannot place is
counted, never dropped** — `chrome://new-tab-page/` names no site, and 3 of 44
`url_change` observations land in `unidentified` rather than inventing a value.

`npm run probe:identity` re-renders every number above from the live library.
Measured 2026-09-06 over 12 recordings: `display_change` 12 occurrences / 8 raw
/ **2**, `focus_change` 92 / 63 / **7**, `url_change` 44 / 19 / **17** plus 3
unidentified. `keymap_change` gets no identity — 12 occurrences and one payload,
so a projection would buy zero. See
`docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md`.
```

- [ ] **Step 3: Update `CLAUDE.md`**

First, add the probe. In the `probe:*` block under *Commands*, immediately after the `npm run probe:highlight` line, insert:

```
npm run probe:identity        # which observed payloads are ONE value. The Knowledge layer's
                              # identities are projections declared per fact type and every
                              # declaration carries a number; this is where the number comes
                              # from, so it stays re-checkable instead of frozen in a doc
                              # comment. Read-only (SQLite readonly, stdout) and HEADLESS for
                              # probe:baseline's reason: the app takes no single-instance lock
                              # and WRITES on startup. PRINTS THE CORPUS FIRST and refuses
                              # under two recordings, where every payload is from one session
                              # and the table would be an empty result wearing a verdict.
                              # Measured 2026-09-06 over 12 recordings: display_change 12
                              # occurrences / 8 raw / 2 folded, focus_change 92 / 63 / 7,
                              # url_change 44 / 19 / 17 with 3 unidentified. It also reports
                              # keymap_change, which has NO identity -- 12 occurrences and one
                              # payload -- because the reason it has none is the number.
```

Then, under *### Trace IR and the executor*, immediately after the bullet beginning `- **SUPERSESSION IS COMPUTED, AND "NEWER WINS" IS FALSE ON THE REAL LIBRARY.**`, insert:

```markdown
- **IDENTITY IS A DECLARED PROJECTION, AND THE FIELD THE OS RE-MINTS IS THE DECOY.** `currentValue` deliberately does not decide whether two values are the same value; `foldByIdentity` (`src/knowledge/identity.ts`) does, and a `FoldedFact` **is** a `KnowledgeFact`, so the resolver reads one with `facts.ts` unmodified — if that file needs an edit, the seam is wrong. Each fact type declares the form that decides sameness (`src/knowledge/identities.ts`), and a projection **enumerates what it KEEPS**, so a new field on `DisplayInfo` does not silently become a discriminator. Measured 2026-09-06: `display_change` 12 occurrences / 8 raw / **2** — `DisplayInfo.id` is stable for the BOOT and no longer, and the same primary carried seven ids; `focus_change` 92 / 63 / **7** bundle ids, where the target number is QUESTION-DEPENDENT (28 by `(bundleId, title)`, 40 by `windowId`) so a consumer wanting 28 wants a second identity, not an edit; `url_change` 44 / 19 / **17** plus **3** unidentified. **`visitedPage` CALLS `urlPrefix` and writes no rule of its own** — a hand-written normalizer merged the same single pair, so the tie went to the rule that ships, and a private URL rule in `src/knowledge/` is the exact regression `src/index.ts` exports `urlPrefix` to prevent. Sameness as a MEASURE (embed and cluster) was declined for want of ground truth on a 12-recording library — `probe:embed`'s first version is why. `npm run probe:identity` re-renders all of it. `keymap_change` has no identity: 12 occurrences, one payload.
```

- [ ] **Step 4: Mark the spec shipped**

In `docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md`, change the status line

```markdown
**Status:** design approved 2026-09-06. Cycle 1 of the Knowledge layer, and the
```

to

```markdown
**Status:** shipped 2026-09-06. Cycle 1 of the Knowledge layer, and the
```

- [ ] **Step 5: Verify no stale claim was left behind**

Run:
```bash
grep -rn "does not decide whether two values" docs/ CLAUDE.md src/
```
Expected: hits in `src/knowledge/facts.ts` and `docs/internals/persistence.md` that describe what **cycle 0** refuses — those stay, they are the record. Any hit that reads as a claim about the layer *as it now ships* must be corrected.

Then run:
```bash
grep -rn "Stable for the boot" src/
grep -rn "TRACKING_PARAMS" src/ scripts/
```
Expected: no matches for either. The first is the falsified comment; the second is the URL rule that must not exist.

Finally, confirm the counts in prose agree with the code — a count in prose is duplicated prose:
```bash
grep -rn "probe:identity" CLAUDE.md package.json docs/ | head
```

- [ ] **Step 6: Run the gates**

Run: `npm run typecheck && npm test && npm run probe:identity`
Expected: all three pass. The probe is included because Step 1 edits a file in `src/capture/` and this is the cheapest confirmation that a comment edit was only a comment edit.

- [ ] **Step 7: Commit**

```bash
git add docs/internals/persistence.md CLAUDE.md src/capture/env/types.ts docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md
git commit -m "$(cat <<'EOF'
docs(knowledge): identity is a declared projection, and one comment was wrong

persistence.md's cycle-0 section gains the answer to what it recorded as
refused, CLAUDE.md carries the rule with its measurement, and probe:identity
is registered beside the other probes.

DisplayInfo.id's comment said "Stable for the boot" and read as a stability
promise. The measurement falsified it across recordings -- the same
1920x1080@2 primary carried seven ids -- and a fact keyed on it would have
minted 8 configurations where there are 2. It now says which correlations it
is safe for, and names the identity that drops it.

The load-bearing prohibition is written down twice on purpose: a private URL
rule inside src/knowledge/ is the exact regression src/index.ts exports
urlPrefix to prevent, and it would look correct.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012cDnhzgDHFW5hhifhVwGHc
EOF
)"
```

---

## Done when

- `src/knowledge/identity.ts` and `src/knowledge/identities.ts` exist, are leaves, read no clock, and are exported from the barrel.
- **`src/knowledge/facts.ts` and `test/knowledge.current.test.ts` are byte-identical to their state before this plan** — verify with `git diff 65284af..HEAD -- src/knowledge/facts.ts test/knowledge.current.test.ts` returning nothing (`65284af` is the commit this plan was written on). That is the seam, asserted.
- `test/knowledge.identity.test.ts` (15 tests) and `test/knowledge.identities.test.ts` (14 tests) pass.
- `npm run typecheck`, `npm test` and `npm run build` all pass.
- `npm run probe:identity` runs read-only against the real library and reports `display_change` folding 8 raw payloads to **2**.
- No `TRACKING_PARAMS`, no URL normalizer, and no second URL rule anywhere in `src/knowledge/`.
- `docs/internals/persistence.md` and `CLAUDE.md` carry the rule and its measurement; the spec is marked shipped.
- No table, no `schema.ts` edit, no stage, no UI, no MCP tool.
