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
