# The Knowledge Layer — Remaining Work

> **Handoff document.** Cycles 0 and 1 shipped; cycles 2 and 3 are **not designed
> yet**, so this is not a task-by-task implementation plan and must not be
> executed as one. It records the state, the decisions that are closed, the
> blockers verified against the code on 2026-09-06, and the measurement each
> remaining cycle must take before it can be designed.
>
> **A new session starts with `superpowers:brainstorming`, not
> `superpowers:executing-plans`.** See §6.

**Written:** 2026-09-06, on branch `feat/knowledge-layer-seam` at `7f9ff60`.

---

## 1 · Read these first, in this order

| file | why |
| --- | --- |
| `docs/research/persistence-layers.md` §6, §6.1, §6.2, §6.3, §7 | the argument, the three candidates, and what DeskRAG **declines** |
| `docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md` | cycle 0 — nothing is stored, supersession is computed |
| `docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md` | cycle 1 — identity is a declared projection |
| `docs/internals/persistence.md`, `### The decision, made 2026-09-04` | the durable rules both cycles wrote |
| `src/knowledge/` (3 files, 549 lines) | the whole layer |
| `CLAUDE.md`, the two bullets under *Trace IR and the executor* | the invariants, compressed |

---

## 2 · State on 2026-09-06

Shipped, on `feat/knowledge-layer-seam`, PR #90 (15 commits):

| cycle | subject | what shipped |
| --- | --- | --- |
| 0 | supersession | `facts.ts` — `currentValue`, exclusivity per fact TYPE, three refusals |
| 1 | entity identity | `identity.ts` — `foldByIdentity` + `stableKey`; `identities.ts` — three declarations; `probe:identity` |
| 2 | environment facts promoted library-wide | **not started** |
| 3 | application AX shape per version | **not started, and blocked — see §5** |

**No table, no `schema.ts` edit, no stage, no UI, no MCP tool exists for any of
this.** That is by design and is still the right state.

### The measurements both cycles rest on

Real library, 12 recordings, 2026-08-17 → 2026-08-29. Re-render any time with
`npm run probe:identity`.

| kind | occurrences | raw payloads | folded | note |
| --- | --- | --- | --- | --- |
| `display_change` | 12 | 8 | **2** | macOS re-mints `DisplayInfo.id`; 7 ids, one display |
| `focus_change` | 92 | 63 | **7** | by `bundleId`. See §4's open question |
| `url_change` | 44 | 19 | **17** | plus **3** unidentified (`chrome://new-tab-page/`) |
| `keymap_change` | 12 | 1 | — | no identity declared; a projection would buy zero |

---

## 3 · The thing that actually matters: the layer has no consumer

Verified 2026-09-06:

```bash
grep -rln "foldByIdentity\|currentValue" src/ app/src/ scripts/ test/
```

returns **only** `src/index.ts` (the barrel), `src/knowledge/*`, the three test
files, and `scripts/probes/identity.ts`. Nothing in `app/`, nothing in
`retrieve/`, nothing in `represent/`. `identities.ts` is not imported by
`identity.ts` — the declarations are read by the probe and the tests and by
nothing else.

**This is not a defect and it should not be "fixed" by wiring the layer
somewhere to justify it.** Cycles 0 and 1 deliberately shipped a contract ahead
of its first caller, because the measurement that decided the contract
(`display_change` = 8 payloads, 2 configurations) would have been baked into a
wrong table if the caller had come first. But it does mean the honest framing of
cycle 2 is:

> **Cycle 2 is the first consumer, and the design question is what a consumer
> asks for — not what the layer can compute.**

Do not start cycle 2 by extending `identities.ts`. Start it by finding the
question a person or a tool actually asks.

---

## 4 · Cycle 2 — environment facts promoted library-wide

The research doc calls this "a small step," and after cycle 1 that is close to
true mechanically: `display_change` and `keymap_change` are already
`t_mono`-stamped events resolved latest-at-or-before *within* a session, which
is supersession at session scope. `foldByIdentity` + `currentValue` already turn
them into library-scoped facts. **The code that computes the answer exists.**

What does not exist is the question. Three shapes, and they are not equivalent:

- **An MCP tool.** `search_knowledge` and `get_fact` are reserved names that
  satisfy the read-only guard's `^(search|get|list)_` rule (§6.3 of the research
  doc) — the rule that already cost `find_habit` its name. There are **11** tools
  today; adding one means the count in `README.md`, `app/README.md`,
  `docs/mcp.md` and `docs/internals/app-main.md` all move. Grep the **numeral**.
- **A UI surface.** "Your display setups" / "your keyboard layouts", somewhere in
  Settings or Library. This is the only shape that puts the *refusal* in front of
  a person — `coexisting` returning no current value is the interesting output,
  not a footnote.
- **A retrieval or digest input.** The riskiest. Anything that ranks touches
  `FrameResult.score`'s rule and `DEFAULT_RRF_K`'s precedent, and a fact that
  changes ranking wants a sweep before it ships.

### The measurement to take FIRST, before designing anything

**Time the fold on the whole real library.** `probe:identity` already reads every
event of four kinds and folds them; add a timing column, or time the probe.

This decides the one thing cycle 0 left with a tail: whether "computed per query"
survives contact with a consumer, or whether cycle 2 is where the
`DERIVED_LIBRARY_TABLES` table finally gets built. If folding 12 recordings'
events is single-digit milliseconds, computed-per-query is settled and cycle 2
needs **no table at all** — which is the cheapest possible answer and closes
§6.2 completely. If it is hundreds of milliseconds on 12 recordings, say so, and
the table becomes a real design question at 100.

`DEFAULT_RRF_K` is the precedent: the number comes before the adoption.

### The open question cycle 1 deliberately left here

`focus_change` folds to **7** by `bundleId`, **28** by `(bundleId, title)`, and
**40** by `windowId`. Cycle 1 recorded that the target number is
**question-dependent** and declared `bundleId` only. A consumer wanting 28 wants
a **second declared identity**, not an edit to `FOCUSED_APP`. Cycle 2 is where
that gets decided *by what the consumer asks*, and the answer belongs in
`identities.ts` beside the first one, with its own number.

### Constraints that carry over unchanged

- Counts, never ratios. `unidentified` is a count. No confidence, no percentage.
- A refusal is an answer and must state its reason (`Stability.reason`,
  `StageSpec.skipReason`).
- `src/knowledge/` reads no clock. Ordering is injected (`SessionStartedAt`).
- If it gets a table, the table is `DERIVED_LIBRARY_TABLES` — decided, do not
  relitigate. `AUTHORED_TABLES` and a sixth bucket are both wrong here.
- **`facts.ts` not changing is the seam.** If cycle 2 needs to edit it, stop and
  re-read — that is the signal the design is wrong, and it is written into the
  file's own header.

---

## 5 · Cycle 3 — application AX shape per version — BLOCKED

The candidate is *"App X, version v, has this AX shape at this screen,"*
superseded when the app updates. It aims at real fragility: CLAUDE.md records
that the anchor ladder was falsified **twice**, each time by recording in one
more app.

**It cannot be designed yet, and the blocker is verified, not suspected.**

### Blocker 1 — the version is not captured, anywhere

```bash
grep -rln "bundleVersion\|CFBundleShortVersion\|appVersion" src/ native/ app/src/
```

returns nothing. `ActiveWindowProducer.queryWindow`
(`src/capture/producers/active-window.ts:66-86`) reads `active-win`'s
`owner.{name,bundleId,processId}` — there is no version field — and the
`focus_change` payload it emits carries `app`, `title`, `windowId`, `pid`,
`recorder`, `bundleId`, `url`, `bounds`. No version.

So the fact's own key does not exist in the data. Cycle 3 therefore **starts with
a capture change**, most likely in `native/ax-dump.swift` (which already has the
frontmost app in hand), and that drags in CLAUDE.md's two paid-for rules:

- a **stale binary** fails silently — `ax-dump` ignored `--keymap/--displays` for
  two days and every recording lost its typed text;
- a **stale `dist/`** cannot be made to degrade — `ax-dump`'s stdout is an object,
  and a `dist/` built before that change parsed it as nothing, for one whole
  recording of 14 snapshots and 0 elements.

Rebuilding `native/` requires `npm run build:ax` **and** `npm run build` **and**
an app restart. This is a capture-layer cycle wearing a Knowledge-layer hat, and
it should be scoped as one.

### Blocker 2 — "at this screen" is a harder identity than any shipped so far

Cycle 1's three identities are projections over a **flat payload**. "This AX
shape at this screen" needs an identity over a **tree**, and the screen it is
"at" is itself a thing needing identity. `trace/predicates.ts` and the node
identity in `trace-and-replay.md` are the closest prior art and should be read
before assuming this is more of the same — it is not.

### Blocker 3 — the corpus is 12 recordings in a handful of apps

The candidate's whole value is cross-app generality, and CLAUDE.md's standing
warning is that any number derived from **one** application is provisional.
Recording in more apps is a cheaper prerequisite than any code here.

**Recommended: do not attempt cycle 3 until cycle 2 has a consumer and the corpus
is wider.** If it is attempted anyway, split the capture change into its own
cycle with its own spec, and verify it on a real recording before designing the
fact on top of it.

---

## 6 · How to start a new session

```
Continue the DeskRAG Knowledge layer. Read
docs/superpowers/plans/2026-09-06-knowledge-layer-remaining-work.md first —
it is the handoff. I want to start cycle 2 (environment facts promoted
library-wide).
```

Then:

1. **`superpowers:brainstorming`**, not `executing-plans` — there is no plan to
   execute. Cycle 2 is likely **architectural** (it is the layer's first
   consumer and may add an MCP tool or a table); cycle 3 certainly is.
2. **Take the timing measurement in §4 before the design conversation**, and
   bring the number into it. This repo's rule is that the number comes first.
3. Spec → `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, then
   `superpowers:writing-plans`.
4. Gates, every time: `npm run typecheck`, `npm test` (~75s, 171 files),
   `npm run build`, and `npm run probe:identity` if anything in `src/knowledge/`
   or `src/capture/env/` moved.

---

## 7 · Settled — do not relitigate

Each of these was decided against real data and cost something to establish.

- **Nothing is stored; supersession is computed.** "Newer wins" is *false* on
  this library — the docked and undocked display setups coexist and neither
  supersedes the other.
- **If it gets a table, the table is `DERIVED_LIBRARY_TABLES`.** The paper is
  append-only because it does not retain the evidence; `CAPTURED_TABLES` is
  exactly that evidence, so re-derivability is free here.
- **Identity is a declared projection, never a similarity measure.** Embedding
  and clustering was declined for want of ground truth on a 12-recording
  library; `probe:embed`'s first version is the standing lesson.
- **A projection enumerates what it KEEPS**, so a new field on `DisplayInfo` does
  not silently become a discriminator.
- **`visitedPage` calls `urlPrefix` and writes no rule of its own.** A
  hand-written normalizer was measured and merged the same single pair. A private
  URL rule inside `src/knowledge/` is the exact regression `src/index.ts` exports
  `urlPrefix` to prevent, and it would look correct.
- **Confidence scores, confidence damping, and contradiction *resolution* are
  declined** (research doc §7). DeskRAG's answer to a contradiction is
  disclosure. Adopting damping reintroduces the number this repo removed.
- **Storage-level decay on captured rows is non-negotiable**, now on the paper's
  own terms too.

## 8 · Known-open, and deliberately so

- `focus_change`'s second identity (28 by `(bundleId, title)`) — consumer-driven,
  §4.
- 3 of 44 `url_change` observations are `unidentified` (`chrome://new-tab-page/`
  names no site). Counted, never dropped. Correct as-is.
- No `search_knowledge` / `get_fact` MCP tool. Names reserved only.
- The layer has no consumer (§3). Cycle 2 is the first one.
