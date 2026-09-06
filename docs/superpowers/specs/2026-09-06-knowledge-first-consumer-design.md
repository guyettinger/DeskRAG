# The Knowledge layer's first consumer: environment facts promoted library-wide

**Status:** designed 2026-09-06. Cycle 2 of the Knowledge layer, following
`docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md` (cycle 0,
supersession) and `docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md`
(cycle 1, identity).

**Scope:** one pure projection in `app/src/main/`, one DTO, one nav screen, two
MCP tools, one new identity declaration and one new field on
`IdentityDeclaration`. It creates **no table** — that is a measured result, §2 —
and does **not modify `facts.ts` or `identity.ts`**, which is the seam holding
for the second cycle running.

---

## 1 · The question being answered

Cycles 0 and 1 shipped a contract ahead of its first caller, deliberately: the
measurement that decided the contract (`display_change` = 8 payloads, 2
configurations) would have been baked into a wrong table had the caller come
first. The handoff records the consequence and the correct framing:

> **Cycle 2 is the first consumer, and the design question is what a consumer
> asks for — not what the layer can compute.**

So this spec does not extend `identities.ts` and then look for somewhere to put
the result. It starts from two questions a person and an agent actually ask —
*what does my desktop consist of*, and *what is DeskRAG willing to call current*
— and works back. Everything below that is new exists because one of those two
questions needed it.

## 2 · The measurement that closes §6.2

Cycle 0 left one question with a tail: whether "computed per query" survives
contact with a consumer, or whether cycle 2 is where the
`DERIVED_LIBRARY_TABLES` table finally gets built. The handoff set the bar —
single-digit milliseconds settles it, hundreds of milliseconds makes the table a
real design question at 100 recordings.

Measured 2026-09-06 on the author's real library (12 recordings, 2026-08-17 →
2026-08-29, SQLite opened read-only), running the **whole** pipeline this spec
proposes — every session's every event read and parsed, the recorder exclusion
applied, four facts folded, `currentValue` resolved on each:

```
events read: 5079 across 12 recordings

WHOLE PIPELINE: read + parse + exclude + fold + current = 4.63 ms
  of which read/parse                                     3.77 ms
  of which fold                                        ~  0.86 ms
```

And the fold alone, against a synthetic hundredfold corpus — 9200 focus
observations, roughly what 1200 recordings would carry:

```
9200 observations -> 7 values in 34.13 ms
```

**Computed-per-query survives, and cycle 2 needs no table.** The fold is linear
and the cost is dominated by reading rows, not by folding them; a hundredfold
library still resolves inside one frame. §6.2 of
`docs/research/persistence-layers.md` closes, and the rule in
`docs/internals/persistence.md` stands unamended: *no table, no bucket.*

This follows `DEFAULT_RRF_K`'s precedent — the number comes before the adoption.

## 3 · What the library actually holds

The same read, rendered. `raw` is distinct payloads by structural equality;
`folded` is distinct under the declared identity.

| kind | occurrences | raw | folded | unidentified |
| --- | --- | --- | --- | --- |
| `display_change` | 12 | 8 | **2** | 0 |
| `keymap_change` | 12 | 1 | **1** | 0 |
| `focus_change` | 92 | 63 | **7** | 0 |
| `url_change` | 44 | 19 | **17** | 3 |

Two findings in that table drive the whole design, and neither is in the
handoff.

### 3.1 · Every declared fact refuses

All three identities declared in cycle 1 are `coexisting`, so `currentValue`
returns `null` for every one of them:

```
display_change  REFUSED  "…holds 2 values that can all be true at once,
                          so there is no current one — the answer is the set."
focus_change    REFUSED  "…holds 7 values…"
url_change      REFUSED  "…holds 17 values…"
```

A screen built on those three alone can never show DeskRAG answering — only
DeskRAG declining, three times, which teaches that the refusal is the *only*
thing the layer does. That is false, and the fix is §4.1.

### 3.2 · The library's headline values are the recorder itself

Before any exclusion, the most-observed application is `com.github.Electron` (10
of 12 recordings, 19 observations) and the most-visited site is `localhost` (10
of 12 recordings, 13 of 44 observations). Attributing every `url_change` to the
application focused at-or-before it confirms the second is caused by the first:

```
com.github.Electron : localhost:5173 x13, www.finout.io x1
com.google.Chrome   : www.linkedin.com x10, inman-perk-coffee.vercel.app x9,
                      news.google.com x6, new-tab-page x3, …
```

A "your applications / your sites" screen would open by telling its reader that
their most-used application is the recorder and their most-visited site is its
own dev server. `liftTrace` and `captionExclusionFor` were each taught not to do
this, and CLAUDE.md states the rule: **the recorder is not part of the work it
records.** The exclusion is §4.2.

## 4 · The design

### 4.1 · A fourth declaration, justified by the consumer

`identities.ts` declines an identity for `keymap_change` and records why: 12
occurrences, one distinct payload, *"a projection would buy zero."* On the fold
count that is correct and stays correct.

But a projection does not only merge values — it decides **what a consumer
sees**, and the raw payload is:

```
{ layoutId: "com.apple.keylayout.US", entries: { …70 keycode mappings… } }
```

Seventy entries is not a value that goes on a screen or into a tool response;
`layoutId` is. That is `DISPLAY_TOPOLOGY`'s own argument — *"a projection makes
the decoy structurally unable to reach a consumer"* — applied to bulk rather
than to a decoy, and it is an argument only a consumer could make. Cycle 1
predicted a declaration would be settled this way; it predicted `focus_change`
and it was `keymap_change` instead.

```ts
/** The fields of a `keymap_change` payload this identity reads. */
export interface KeymapPayload {
  layoutId?: string;
}

export const KEYBOARD_LAYOUT: IdentityDeclaration<KeymapPayload, string> = {
  kind: "keymap_change",
  exclusivity: "exclusive",
  attribution: "ambient",
  identity: (payload) => nonEmpty(payload.layoutId),
};
```

`nonEmpty` is the module-private helper the file already uses, reused rather
than re-spelled: an empty `layoutId` is **absent**, on the rule both Swift
sidecars hold.

`exclusive` is the load-bearing half. It makes `keymap_change` the **one fact
that returns a value** — measured, it resolves to `"com.apple.keylayout.US"`
with the reason *"The only value observed for keymap_change."* — so the screen
shows an answer beside three refusals and the contrast is legible.

### 4.2 · The recorder exclusion is scoped by fact type, and this was measured

The obvious implementation applies `excludeFocusedApps` to every event before
folding. **That is wrong, and on this library it is one coin flip from being
visibly wrong.**

Display and keymap are sampled at session start, while the recorder is still
frontmost. Measured with the settings' real `flows.excludeApps`
(`["DeskRAG", "Electron", "com.deskrag.app", "com.github.Electron"]`):

```
sessions whose display_change was ENTIRELY excluded: 6 of 12
sessions whose keymap_change  was ENTIRELY excluded: 6 of 12
```

The two display configurations survived only because the docked one
(`1728×1117 + 3840×2160`, a **single** observation) fell in the surviving half.
Had it not, the screen would have shown one display setup where there are two,
confidently, with no disclosure.

The correction is not to drop the exclusion but to scope it. **An environment
fact is not about the application that was frontmost when it was sampled** — the
display topology while the recorder is frontmost is the same display topology.
`excludeFocusedApps` exists to drop *work* attributable to the recorder, and a
display configuration is not work.

That makes exclusion a property of the fact **type**, exactly like exclusivity,
so it is declared beside it — `identities.ts` already holds per-type properties
as data rather than branches, on `text-profiles.ts`'s precedent:

```ts
export interface IdentityDeclaration<Raw, Canon> {
  kind: string;
  exclusivity: Exclusivity;
  /**
   * Whether this fact is ABOUT the focused application, and so inherits the
   * recorder exclusion.
   *
   * MEASURED 2026-09-06: applying the exclusion to the AMBIENT facts costs 6 of
   * 12 recordings their display and keymap observations outright, because both
   * are sampled at session start while the recorder is still frontmost. The two
   * display configurations survived that by luck — the docked one has a single
   * observation and was one coin flip from vanishing, which would have shown one
   * setup where there are two.
   */
  attribution: "focused-app" | "ambient";
}
```

| declaration | attribution | exclusivity | folded | after exclusion |
| --- | --- | --- | --- | --- |
| `DISPLAY_TOPOLOGY` | `ambient` | coexisting | 2 | **2** (12 obs kept) |
| `KEYBOARD_LAYOUT` *(new)* | `ambient` | exclusive | 1 | **1** (12 obs kept) |
| `FOCUSED_APP` | `focused-app` | coexisting | 7 | **6** |
| `VISITED_PAGE` | `focused-app` | coexisting | 17 (+3 unid.) | **15** (+3 unid.) |

The exclusion drops **253 of 5079** events. `localhost` and the single
`finout.io` hit both leave with `com.github.Electron`.

### 4.3 · `focus_change` keeps one identity, and §8's open question closes

Cycle 1 left the second focus identity to be decided by what the consumer asks.
The consumer asks for **7** (6 after exclusion), and the 28 is declined on
evidence rather than deferred again.

Folding by `(bundleId, title)` does yield 28, but the list is app × **content**,
not app × identity:

```
com.google.Chrome :: Google News          com.apple.TextEdit :: Open
com.google.Chrome :: Feed | LinkedIn      com.apple.TextEdit :: Save
com.apple.calculator ::                   com.google.Chrome ::
```

Two things are wrong with it. Six of the 28 carry an **empty** title, which
`identities.ts`'s own `nonEmpty` rule calls *absent*, not a value — so a
declaration written to the file's existing standard would not produce 28 anyway.
And the Chrome half of the list is a set of pages, which `url_change` already
answers **better**, normalized through `urlPrefix` at site grain rather than
through whatever the tab happened to be titled.

`FOCUSED_APP` stays exactly as declared. No second identity.

### 4.4 · The pipeline — `app/src/main/knowledge-view.ts`, pure

```
listSessions()  ─┬─> events per session (store.getEventsBySession)
                 │
                 ├─ focused-app facts ─> excludeFocusedApps(events, isExcluded) ─┐
                 │                                                               ├─> observations
                 └─ ambient facts ─────> events, unfiltered ────────────────────-┘        │
                                                                                          v
                                                        foldByIdentity(kind, obs, identity)
                                                                                          │
                                          stabilityOf(value.sources) ───────────────────---┤
                                          currentValue(folded, exclusivity, startedAt) ────┘
                                                                                          v
                                                                                   KnowledgeDTO
```

A pure projection, mirroring `graph-view.ts`, with `DeskRagService.knowledge()`
doing the I/O and nothing else, mirroring `flows()`. One pass over the session
list; one `excludeFocusedApps` per session, reused by both focused-app
declarations rather than recomputed per fact — `flows()` carries the same note
about not scanning the list once per source.

**Why `app/src/main/` and not `src/knowledge/`.** The inputs are app-shaped:
`TraceEvent`s, a settings-held exclusion list, and session start times. The
policy of which applications to exclude belongs to the app, and pushing it into
the library runs against the direction this repo holds (`store/` never depends
on `represent/`; `segment/` stays a leaf). The objection that would have
defeated this — that a pure module in `app/` is unreachable from the root suite
and the probes — does not hold: 10+ test files and 9 probe imports already reach
into `app/src/main/`, `scripts/lib/flows.ts` importing `graph-view.js` among
them.

**Why not inline in `DeskRagService`.** `deskrag-service.ts` imports electron, so
the root suite cannot construct it — the fold, the exclusion and all three
refusals would be testable only by launching the app. That is the exact bind
`probe:merge` and `probe:reflect` exist to work around.

### 4.5 · Evidence uses the shipped vocabulary

A folded value's evidence is `COUNT(DISTINCT session_id)` over its own sources,
which is precisely what `stabilityOf` (`src/trace/stability.ts`) computes for the
trace graph — and `FoldedValue.sources` is structurally already its input, since
`KnowledgeSource` is `{ sessionId, tMono }`. No adapter, and no second
vocabulary for one idea. `stabilityOf`'s own header calls it *"the Knowledge
layer's stability tier."*

So each value carries `{ tier, sessions, reason }`, the same words the Flows
graph shows, and the screen's evidence column is a **word and a count of
recordings** — printable exactly where `FrameResult.score` is not.

### 4.6 · The DTO — `app/src/shared/types.ts`

```ts
export interface KnowledgeValueDTO {
  /** Rendered ONCE, here, so both faces are byte-identical. */
  label: string;
  /** `stabilityOf(...)` assigned straight in, as GraphNodeDTO does. */
  stability: StabilityDTO;
  observations: number;
  /** Distinct raw payloads folded into this value. A count. */
  variants: number;
}

export interface KnowledgeFactDTO {
  kind: string;
  title: string;
  attribution: "focused-app" | "ambient";
  values: KnowledgeValueDTO[];
  /** Observations the identity could not place. A count, never a ratio. */
  unidentified: number;
  /** The current value's label, or null on every refusal. */
  current: string | null;
  /** Why this answer. Required — a thing that does not appear must say why. */
  reason: string;
  undated: number;
}

export interface KnowledgeDTO {
  facts: KnowledgeFactDTO[];
  recordings: number;
  excludedApps: string[];
  excludedEvents: number;
  /** Recordings with no `focus_change`, where the exclusion is a no-op. */
  unattributable: number;
}
```

`label` is rendered once in the projection rather than in each face. This repo
already checks that a habit's clipboard string and `get_habit`'s are
byte-identical (`probe:habits`); two renderers is how they would come to
disagree.

Three of the four canonical forms are already strings — `layoutId`, `bundleId`,
`urlPrefix` — and pass through verbatim. Only `DISPLAY_TOPOLOGY`'s
`readonly DisplayGeometry[]` needs rendering, into `1920×1080 @2× primary`,
joined with ` + ` in the tuple's own sorted order so the string is as
deterministic as the key. **`title` and the label renderers live in
`knowledge-view.ts`, keyed by `kind` — not in the declaration.**
`src/knowledge/identities.ts` is a library file and holds what decides sameness;
"Display setups" is UI copy, and putting it there would make the library the
owner of a screen's wording.

`shared/types.ts` imports nothing from `deskrag` and declares `StabilityDTO`
structurally — that convention is followed, not amended.

Nothing here is a ratio, a percentage or a confidence.

### 4.7 · The UI — an eighth nav screen

```
Record → Indexing → Library → Flows → Habits → Knowledge → Search → Settings
```

**After Habits, not between Flows and Habits.** `App.tsx` documents that
adjacency — *"After Flows: a habit is made FROM a flow, which is the order the
work happens in"* — and a new screen should not sever a stated relationship.
Knowledge sits in the same derived-from-the-whole-library band without doing so.

Four cards, one per fact, each leading with its answer **or its refusal in the
same slot**:

```
Keyboard layouts                                          ambient
com.apple.keylayout.US
The only value observed for keymap_change.
    core · 12 recordings

Display setups                                            ambient
No current value — 2 values can all be true at once; the answer is the set.
    1920×1080 @2× primary                 core · 11 recordings · 7 variants
    3840×2160 @1× + 1728×1117 @2× primary prediction · 1 recording

Applications                          focused-app · recorder excluded
No current value — 6 values can all be true at once; the answer is the set.
    com.google.Chrome                     core · 4 recordings
    …

Sites                                 focused-app · recorder excluded
No current value — 15 values can all be true at once; the answer is the set.
    …                                     3 unidentified
```

Rules inherited from `app-ui.md`, and the one at risk named: **nothing
truncates** — the docked geometry label is the longest string on the screen and
either fits or is withheld via `labelFits`; there is no ellipsis. No invented
numbers. The footer carries the corpus — 12 recordings, 253 events excluded, the
four excluded names — on `flows()`'s stated reasoning: *a reader who finds their
own app gone is entitled to that answer without opening Settings.*

`attribution` is what lets a card say the recorder exclusion **does not apply**
to it, which after §4.2 is a claim the screen has to be able to make.

### 4.8 · The MCP tools — eleven to thirteen

| tool | returns |
| --- | --- |
| `list_facts` | every fact: values with tier and counts, `unidentified`, `current` or the refusal reason, and the corpus disclosure |
| `get_fact` | one fact, plus its **variants** — the raw payloads behind each folded value |

`get_fact` earns its place on the variants: they are the only place the seven
re-minted `DisplayInfo.id`s are visible, which is what makes the fold believable
to an agent rather than merely asserted.

Both satisfy the read-only guard's `^(search|get|list)_` rule. Reader methods are
`listFacts()` and `getFact(kind)`, with every DTO declared in `shared/types.ts`
and none inline — `test/mcp.readonly.test.ts` matches the `ExperienceReader` body
against `/record\(|delete|remove|start|stop|arm|execute|write|put|set/i` with
**no word boundaries**, the trap that already cost `inputs` and `startedAt` their
names.

`search_knowledge` is **not** built. It implies a ranking this layer does not do,
and would drag `RANKING_MIN_HABITS`-style disclosure onto a four-row corpus. The
name stays reserved.

**The numeral moves in five places** (`grep -rn eleven`): `README.md:120`,
`docs/mcp.md:24`, `docs/mcp.md:345`, `scripts/probes/mcp.ts:9`, `CLAUDE.md:53`.
`docs/internals/app-main.md:94` stays at eleven — *"Re-confirmed 2026-08-23 at
eleven tools"* is a dated record of what was true then, not a live count.

## 5 · Testing

- **Unit, root suite** (`test/knowledge-view.test.ts`), reaching into
  `app/src/main/` as 10+ files already do: the ambient/focused-app split
  (an ambient fact keeps its observations when the recorder is excluded, a
  focused-app fact loses them); all three refusals; the `exclusive` singleton
  returning a value; `unattributable` as a true no-op; `unidentified` counted
  and never dropped.
- **`probe:identity` extended** to call the real gatherer instead of keeping its
  own copy of the observation-gathering, and to print the exclusion's cost. This
  is the point: the probe reimplementing it would be two readers of one rule,
  the drift hazard this repo names after `ax-dump`/`ax-exec`.
- **`probe:mcp`** gains the two tools.
- **Gates:** `npm run typecheck`, `npm test`, `npm run build`,
  `npm --prefix app run typecheck`, `npm run probe:identity`.
- **The screen is read in the running app** via the `run-app` skill.
  `app-ui.md`'s standing rule is that nearly every layout defect in this repo was
  found by driving the app and reading `getBoundingClientRect()`, never by
  reading CSS.

## 6 · What this deliberately does not do

- **No table, no `schema.ts` edit, no bucket.** §2 is the reason, and it is a
  measurement rather than a preference.
- **No change to `facts.ts` or `identity.ts`.** Cycle 1 wrote the test of the
  seam into `facts.ts`'s own header: *if identity ever needs an edit HERE, the
  seam is wrong.* The same test applies to the first consumer, and it passes —
  everything new is a declaration, a projection, a DTO or a face.
- **No second `focus_change` identity** (§4.3), on evidence.
- **No retrieval or digest input.** Anything that ranks touches
  `FrameResult.score`'s rule and `DEFAULT_RRF_K`'s precedent and wants a sweep
  first. Out of scope.
- **No `search_knowledge`** (§4.8).
- **Nothing about cycle 3.** It stays blocked on the three verified blockers in
  the handoff, and the corpus is still 12 recordings in a handful of
  applications.

## 7 · Open, and deliberately so

- 3 of 44 `url_change` observations remain `unidentified`
  (`chrome://new-tab-page/` names no site). Counted, never dropped.
- `CORE_SESSIONS = 3` is unswept, and inherits that disclosure from
  `stabilityOf` unchanged. This cycle does not sweep it.
- The 28-value `(bundleId, title)` question is closed for *this* consumer, not
  forever. A consumer that genuinely wants windows wants a second declared
  identity written to the `nonEmpty` standard — not an edit to `FOCUSED_APP`.
