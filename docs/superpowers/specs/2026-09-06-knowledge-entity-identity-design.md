# Cross-recording entity identity: when two observed values are one value

**Status:** design approved 2026-09-06. Cycle 1 of the Knowledge layer, and the
prerequisite `docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md`
§2 identified while settling §6.2.

**Scope:** one leaf module and a probe. It creates **no table**, stores **no
fact**, adds **no stage**, **no UI** and **no MCP tool**. Cycle 0's
`currentValue` is not modified — the whole design is arranged so it does not
have to be.

---

## 1 · The question being answered

Cycle 0 shipped the Knowledge layer's semantics as a pure function and recorded
exactly one thing it refuses to do:

> **It does not decide whether two values are the SAME value.** Fed those 8
> display payloads it reports 8, not 2 — seven of them are the same physical
> display with an `id` macOS re-mints every session.

That refusal is honest and it is also the layer's biggest defect: a fact whose
values are mis-split is wrong before any resolver runs. Cycle 0 further found
that identity is not one candidate among three but a **prerequisite of all of
them** — "is this the same display", "is this the same document", "is this the
same app version" are one question asked three times.

This cycle answers it.

## 2 · The measurement

Read off the author's real library on 2026-09-06 — 12 recordings, 2026-08-17 →
2026-08-29, SQLite opened read-only. Every environment-fact event kind in the
store, counted three ways.

| kind | occurrences | distinct raw payloads | distinct under identity |
| --- | --- | --- | --- |
| `display_change` | 12 | 8 | **2** |
| `focus_change` | 92 | 63 | **7** |
| `url_change` | 44 | 19 | **18** |
| `keymap_change` | 12 | 1 | 1 |

Three separate findings, and they do not agree with each other. That
disagreement is the design.

**`display_change` — 8 → 2, decisive.** Seven of eight payloads are the same
1920×1080@2 primary carrying a different `id` each session (180, 185, 206, 219,
247, 296, 297). The eighth is a genuine second configuration: a 1728×1117
primary plus a 3840×2160 external at (−3840, −797). Dropping `id` and sorting
the display list yields exactly two:

```
11x  [[0, 0, 1920, 1080, 2, true]]
 1x  [[-3840, -797, 3840, 2160, 1, false], [0, 0, 1728, 1117, 2, true]]
```

**`focus_change` — 63 → 7, but the target number is question-dependent.** There
are *three* decoy fields, not one: `windowId` (40 distinct), `pid` (10 distinct,
and present in only 28 of 92 payloads), and `bounds`, which drifts by a few
pixels between launches of the same window — the Calculator's main window
appears at (150, 231), (133, 242) and (118, 253) across three recordings. By
`bundleId` the answer is 7; by `(bundleId, title)` it is 28; by `windowId` it is
40. All three are correct answers to different questions, so **which question
the identity encodes has to be declared, not inferred.** `bundleId` is present
in all 92 payloads; `app` is too.

**`url_change` — 19 → 18. This is a null result.** A tracking-parameter strip
plus trailing-slash normalization merges exactly one pair on this library:

```
https://www.linkedin.com/notifications
  <- https://www.linkedin.com/notifications/
  <- https://www.linkedin.com/notifications/?skipRedirect=true&lipi=urn%3Ali%3A…
```

The case that *looks* most obviously like an identity problem is the one this
library does not justify. It ships anyway — see §5 — and it ships with that
number written next to it.

**`keymap_change` needs no identity, and that is a finding.** 12 occurrences,
one distinct payload. Its identity is the identity function, and registering one
would buy zero. Recorded so a later session does not add one for symmetry.

## 3 · The decision — identity is a declared canonicalizing projection

Two things could have been meant by "decide whether two values are the same":

- **A projection**: reduce each payload to the form that decides sameness, and
  group by it. Sameness is *declared*, per fact type, as data.
- **A similarity measure**: embed or edit-distance the payloads and cluster
  under a threshold.

The second is declined, and not on taste. There is no ground truth on a
12-recording library to sweep a threshold against; `probe:embed`'s first version
is this repo's standing lesson about what a metric scored without ground truth
actually measures (it reported a 28.6% "lift" that was noise); and it would put
a model inside a module whose defining property is that it has no dependency at
all. `DEFAULT_RRF_K` is the precedent that the number comes before the adoption,
and here there is no number to have.

So: **identity is a function from a raw payload to its canonical form, declared
per fact type, and the fold groups by that form.**

The canonical form — rather than a surviving representative payload — is the
load-bearing half. A representative is a real observation, which is appealing,
but the payload that survives still carries `id: "180"`: the exact field the
fold exists to declare meaningless, sitting in the value a consumer would print.
A projection makes the decoy **structurally unable to reach a consumer**, and
the canonical form is the only value that is true of every observation it stands
for.

Its one cost is that the value shown was never literally observed. That is paid
for by disclosure, not by a comment: every folded value carries the distinct raw
payloads it stands for.

## 4 · The contract — `src/knowledge/identity.ts`

A leaf beside `facts.ts`. No store, no model, no clock, no native module, no
`spawn`. Barrel-safe.

```ts
/**
 * Reduces an observed payload to the form that decides sameness.
 * `null` is an observation this identity cannot place — disclosed, not dropped.
 */
export type Identity<Raw, Canon> = (value: Raw) => Canon | null;

/** One observation: a raw payload and the recording that saw it. */
export interface Observation<Raw> {
  value: Raw;
  source: KnowledgeSource;
}

/** A folded value: the canonical form, every source, every raw form it stands for. */
export interface FoldedValue<Raw, Canon> extends ObservedValue<Canon> {
  value: Canon;
  sources: readonly KnowledgeSource[];
  /** Distinct raw payloads under this identity, in first-observed order —
   *  first-observed meaning the order they arrived in `observations`, which the
   *  caller controls and the fold never re-sorts. */
  variants: readonly Raw[];
}

export interface FoldedFact<Raw, Canon> extends KnowledgeFact<Canon> {
  values: readonly FoldedValue<Raw, Canon>[];
  /** Observations the identity returned `null` for. A count, never a ratio. */
  unidentified: number;
}

export function foldByIdentity<Raw, Canon>(
  kind: string,
  observations: readonly Observation<Raw>[],
  identity: Identity<Raw, Canon>,
): FoldedFact<Raw, Canon>;
```

**`FoldedValue extends ObservedValue<Canon>` and `FoldedFact extends
KnowledgeFact<Canon>` is the seam.** A folded fact IS a fact, so it drops into
cycle 0's `currentValue` with no change to that function and no change to its
tests. The display case stops reporting 8 values and starts reporting 2, and the
`coexisting` refusal — which already says "the answer is the set" — becomes true
instead of merely well-formed.

**Grouping key.** `stableKey(value: unknown): string`, a recursive serializer
with object keys sorted and array order preserved. `JSON.stringify` alone is
key-order dependent and two identical canonical forms built by different code
paths would not group.

It is total over what a canonical form may contain, and the two collapsing cases
are pinned rather than left to `JSON.stringify`'s defaults: an `undefined`
property is **omitted** (so `{a: 1}` and `{a: 1, b: undefined}` are one key,
which is what a projection with an optional field means) and `undefined` inside
an array serializes as `null` positionally (so a hole never shortens the array
and changes its neighbours' meaning). Numbers, strings, booleans and `null`
serialize as JSON; anything else is a programming error in an identity function
and throws rather than stringifying to `{}`.

**`variants` is distinct under the same serializer.** Two observations whose raw
payloads are byte-identical are one variant; the eleven single-display
recordings fold to one value carrying **seven** variants, not eleven, because
`206` was observed in four recordings and `247` in two. Its `sources` still
number **eleven** — one per recording — which is what makes a later stability
count over a folded fact correct.

**Array order is the identity's business, not the serializer's.** Whether order
is meaningful is a property of the fact: the display projection sorts its list
because the OS may report displays in any order; a URL normalizer sorts its
query parameters for the same reason. A serializer that sorted arrays for
everyone would silently equate two different orderings where order matters.

**`unidentified` mirrors `undated`.** An observation the identity cannot place
is counted and disclosed, never dropped — the discipline `Current.undated`
already established, and the reason `pid` being present in 28 of 92 payloads is
a fact about the data rather than a crash.

## 5 · The identities — `src/knowledge/identities.ts`

Data, not branches, on `src/embed/text-profiles.ts`'s precedent: a type's quirks
are a table, because all of them fail silently when guessed. Each entry carries
its projection, its exclusivity, and the measurement that justifies it.

**`displayTopology`** — drops `id`, sorts the display list by geometry, keeps
`x, y, w, h, scale, primary`. `coexisting`: a laptop is docked some days and not
others, so both configurations are true. Measured 12 → 8 → **2**.

**`focusedApp`** — keeps `bundleId` (falling back to `app`, though nothing in
this library needs the fallback); drops `windowId`, `pid`, `bounds`, `title` and
`url`. `coexisting`: seven apps are used, and no one of them is *the* app.
Measured 92 → 63 → **7**. §2's three candidate answers are recorded in the
declaration so the choice of question is visible where the choice is made.

**`visitedPage`** — lowercases scheme and host, drops the fragment, drops a
single trailing slash, removes parameters in a declared `TRACKING_PARAMS` set,
and sorts the survivors. `coexisting`. Measured 44 → 19 → **18**.

> **`visitedPage` ships ahead of its evidence, deliberately and on the author's
> call.** One merge in nineteen is not a measurement that justifies a rule; it
> was adopted because the rule is expected to earn its place on a larger or more
> tracking-heavy library, and the number is written beside the declaration so
> that expectation stays falsifiable. `npm run probe:identity` is what would
> confirm or retire it.

`TRACKING_PARAMS` is deliberately small and every entry is sourced. Google
News's `hl`, `gl` and `ceid` are **excluded**: they merge nothing on this
library and they are content parameters, so including them would be both
unmeasured and arguably wrong. Growing this set without a probe run that shows
the merge is the regression this note exists to prevent.

No identity is registered for `keymap_change` — see §2.

## 6 · What this deliberately does not do

- **No table, no bucket edit, no `index-plan.ts` stage, no UI, no MCP tool.**
  §6.3 still reserves `search_knowledge` and `get_fact`; neither is built here.
- **No identity across fact *types*.** Whether the `focus_change` payload naming
  Chrome and the `url_change` payload it visited are one entity is a join, not
  an identity.
- **No promotion of a fact library-wide, and no per-version AX shape.** Those
  are the two remaining candidates, and both are now unblocked by this cycle
  rather than competing with it.
- **No merging of two canonical forms.** Identity is a projection, so two forms
  that project differently are two values, full stop. A rule that said
  1920×1080@2 and 1920×1080@1 are "the same display at a different scale" would
  be a similarity measure wearing a projection's clothes.

## 7 · Testing

**Unit, no fixtures** (`test/knowledge.identity.test.ts`): two payloads
differing only in a decoy collapse to one value; sources union across
recordings; `variants` preserves distinct raw forms in first-observed order and
does not duplicate identical ones; a `null` identity increments `unidentified`
and drops no source from the others; `stableKey` is key-order independent and
array-order sensitive; an empty observation list yields an empty fact rather
than throwing; and a folded fact resolves through `currentValue` unchanged,
which is the seam asserted rather than assumed.

**Real data** (`scripts/probes/identity.ts`, `npm run probe:identity`):
read-only twice over — SQLite opened `mode=ro`, output to stdout only, no
`DualStore`, no app launch. Headless, for `probe:baseline`'s reason: the app
takes no single-instance lock and writes on startup, so launching it would make
a second owner of SQLite. It **prints the corpus first** and renders §2's table
from the live library: occurrences, distinct raw, distinct folded, and
`unidentified` per identity. It **refuses under two recordings**, where
cross-recording identity is not a thing that can be measured and the table would
be an empty result wearing a verdict.

The probe is the point of this section. §2's numbers are true of one library on
one day; the probe is what makes them re-checkable next month, and it is what
would retire `visitedPage` if the rule never earns its merge.

## 8 · What would reopen this

- **A fact type where the decoy is not a field but a value** — a title that
  drifts, a version string that increments. A projection cannot express that,
  and a measured case would be the first real argument for §3's declined
  similarity measure.
- **A probe run where `focusedApp`'s 7 is the wrong answer** to a question the
  layer actually asks. The number is question-dependent by construction and the
  declaration says so; a consumer wanting 28 wants a second identity, not an
  edit to this one.
- **`visitedPage` still merging one in nineteen on a much larger library.** That
  is the retirement condition, and it is written down here so retiring it is a
  measurement rather than an argument.

## 9 · Sources

- `docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md` §2, §6 —
  the measurement that made identity a prerequisite, and the refusal this cycle
  answers.
- `docs/research/persistence-layers.md` §6.2, §6.3 — the candidate list and the
  reserved MCP names.
- `docs/internals/persistence.md` — the durable rules.
- In-repo precedents relied on: `src/knowledge/facts.ts` (`Current.undated`, the
  counts-not-ratios rule), `src/embed/text-profiles.ts` (quirks as data),
  `src/trace/predicates.ts` (`canonicalRole` — normalization as a tiny pure
  function, after matching prefixed literals produced zero predicates from every
  real recording), `scripts/probes/baseline.ts` (headless and read-only, prints
  the corpus first, refuses when the corpus cannot support the claim).
