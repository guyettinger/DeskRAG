# Patch highlight fidelity — what a yellow box on a search result is allowed to claim

**Date:** 2026-08-14
**Status:** proposed
**Touches:** `src/embed/types.ts`, `src/embed/onnx/{geometry,colsmol,colsmol-prompt,colmodernvbert,colmodernvbert-prompt}.ts`,
`src/retrieve/{tier2-mv,assemble,types}.ts`, `app/src/shared/types.ts`,
`app/src/main/deskrag-service.ts`, `app/src/renderer/src/screens/DetailView.tsx`,
`app/src/renderer/src/styles.css`, `scripts/highlight-probe.mjs`

## Why

On the late-interaction path — the default once `imageProvider` is `colsmol` or
`colmodernvbert` — a search result's amber boxes do not land on what matched. Reported
from the running app: a search for `probe mcp` returned the right frames, with yellow
rectangles scattered over blank document space.

They are not misplaced. They are **placed exactly where they were told to go**, and
what told them is mostly noise.

## What is NOT wrong: the geometry

`patchIndexToBox` was the obvious suspect and it is correct. Measured against the real
model and the real keyframe from the report (frame `01KZZ3KJTR6YQ7EYX2H7ZADS77`, session
`01KZZ3J82GHRZXEDP8S3SD88WQ`, stored JPEG 2560x1440):

A 320x240 rectangle was painted at (1280, 360) in the JPEG's own pixel space, both
copies were embedded with ColModernVBERT, and the patches were ranked by how much their
vectors changed. **Of the 25 most-changed grid patches, 16 map inside the painted rect**,
and every one of the 13 most-changed lies inside it or within two patches of its edge —
the spill a ViT's receptive field and an anisotropic resize both predict. The frame row
is 1920x1080 (display points) against a 2560x1440 JPEG; same aspect, so the grid, the
mapping and `DetailView`'s percentage placement all agree.

So: the mapping from a patch index to a place on the frame is sound, and this spec does
not touch it.

## Root cause: one box per query VECTOR, and most query vectors are not words

`Tier2MultiVectorRetriever.highlightsFrom` takes the argmax patch **for every query
vector**. For `"probe mcp"` that is 15 vectors, of which **12 carry no query content**:
`[CLS]`, `[SEP]`, and the ten `<end_of_utterance>` buffer tokens `buildQueryPrompt`
appends. Reproduced against the stored patch set for that frame:

| query vector | best sim | lands on |
| --- | --- | --- |
| `[CLS]` | **0.992** | blank document space |
| `" m"` / `"cp"` | 0.721 / 0.698 | the **`mcp`** tab title |
| `"probe"` | 0.634 | **`probe:mcp`** in the shell command |
| 3 x `<buffer>` | 0.414 / 0.393 / 0.299 | blank space |
| `[SEP]` | 0.249 | blank space |

Seven boxes drawn, three of them right. And the ranking is inverted: the list is sorted
by similarity with **no floor**, so `[CLS]` — a whole-sequence summary vector whose
similarity to an average patch is near 1.0 — is drawn first and can never fall off the
eight-box cap, while a real content hit can.

Three aggravating details in the same function:

- **No score threshold.** A 0.249 match is drawn exactly as boldly as a 0.721 one.
- **Dedup by patch discards agreement.** Patch 382 was the argmax for `"probe"` *and*
  three buffer tokens; patch 73 for `" m"`, `"cp"` and four buffers. Several query
  vectors converging on one patch is precisely the signal that a box is real, and the
  `best` map throws it away, keeping only the maximum.
- **The global-tile box is dropped AFTER the cap.** `slice(0, maxHighlights)` runs
  first, so a global-tile argmax silently costs a highlight slot rather than being
  excluded from consideration.

And nothing in the UI distinguishes these synthetic tiles from Tier-3's real `region`
rows: both render as the same solid amber rectangle, though one says "the model attended
to this 80x60 patch" and the other says "this control matched, and it is called *Navigate
back*".

## The fix, in one sentence

Highlighting narrows to the query's **content** vectors, becomes a **similarity map with
a floor** rather than a per-vector argmax, **merges** adjacent surviving patches into one
box, and **renders** at a weight that says how strong the claim is.

Scoring is untouched. MaxSim keeps every query vector, buffer slots included — those are
the learned expansion slots late interaction relies on, and dropping them from *scoring*
would change retrieval. This is a presentation change: no re-index, no stored data
touched, no ranking moved.

### Measured, before designing on it

Content-only, keep patches at or above `0.80 x top score`, merge 4-connected, on the
reported frame:

| query | content vectors | top | p99 | p95 | median | boxes at 0.90 / 0.80 |
| --- | --- | --- | --- | --- | --- | --- |
| `probe mcp` | 3 | 0.721 | 0.550 | 0.323 | 0.069 | 2 / 5 |
| `the macOS dock` | 4 | 0.496 | 0.434 | 0.345 | 0.146 | 4 / 10 |
| `obsidian file list` | 4 | 0.636 | 0.544 | 0.360 | 0.181 | 2 / 6 |

At 0.80, `probe mcp` boxes the **`mcp` tab title**, **`probe:mcp` inside the shell
command**, and the **`mcp` sidebar entry** — all three visually obvious answers, each as
ONE merged box — plus two junk boxes in blank space. At 0.90 it keeps two correct boxes
and loses a real answer. **The floor is a calibration target, not a taste**; see
`scripts/highlight-probe.mjs` below.

## 1. The interface: the provider declares what is content

Only the prompt builder knows which vectors came from the user's words: ColSmol's query
is `tokens + 10 buffer`, ColModernVBERT's is `[CLS] + tokens + 10 buffer + [SEP]`. The
retriever must not hard-code that — it owns neither builder, and a third adapter would
make it wrong silently.

```ts
// src/embed/types.ts
export interface QueryEmbedding {
  /** Every vector, in sequence order. SCORING uses all of them. */
  vectors: Float32Array[];
  /** Indices of the vectors that came from the user's own words. HIGHLIGHTING uses only these. */
  contentIndices: number[];
}

export interface MultiVectorProvider extends NamespacedProvider {
  readonly multiVector: true;
  embedImages(images: Uint8Array[]): Promise<Float32Array[][]>;
  embedQueries(texts: string[]): Promise<QueryEmbedding[]>;
}
```

Explicit indices rather than a count or a range: a count assumes content is a prefix
(false for ColModernVBERT, whose `[CLS]` comes first), and a range assumes contiguity,
which is true today of both builders and is not a property to depend on.

Both prompt modules gain a pure `queryContentPositions(ids: number[]): number[]`
alongside the existing `imageTokenPositions`, computed the same way — by naming the ids
the builder itself added — so the two functions are read side by side and cannot drift.

`Tier2MultiVectorRetriever.embedQuery` returns `QueryEmbedding | null`, passing
`.vectors` to `searchFramePatches` and the pair to the highlighter. An **image** query
marks every vector as content: its vectors are patches of the query image, all of which
carry content, so `contentIndices` is `[0..n)`. An empty `contentIndices` yields no
highlights rather than falling back to every vector — a fallback here is how the bug
returns.

The change is one interface, two ONNX adapters, the test fake, and `assemble.ts`'s
`queryVectors` local; the compiler finds each one.

## 2. Selection: a map, a floor, a merge

`geometry.ts` gains the cell mapping that `patchIndexToBox` is currently computing
inline, so cell coordinates have exactly one definition:

```ts
/** Token-grid cell for an image token, or null for a global-tile token. */
export function patchIndexToCell(index: number, g: TileGeometry): { col: number; row: number } | null
```

The grid is `cols * tokenGrid` by `rows * tokenGrid` cells — 32x24 for a 16:9 frame.
`patchIndexToBox` is rebuilt on top of it and keeps its current behaviour exactly,
including the whole-frame box for a global-tile token (it is still the honest answer to
"where is this token?", it is simply never a highlight).

Both highlight entry points take the embedding rather than a bare vector array, so the
content indices cannot be lost on the way in:

```ts
highlightsForFrame(frameId: string, query: QueryEmbedding, width: number, height: number): Promise<RegionHit[]>
highlightsFrom(frameId: string, query: QueryEmbedding, patches: Float32Array[], width: number, height: number): RegionHit[]
```

`highlightsFrom` becomes:

1. **Score the grid.** For each non-global patch, `score = max over content vectors of
   dot(q, patch)`. Global-tile tokens never enter the map — excluded up front, which is
   also what removes the after-the-cap drop.
2. **Cut by a floor.** Keep `score >= relativeFloor * topScore`. `relativeFloor` is a
   named constant carrying its measurement and date, as `DEFAULT_DECIMATE` does.
3. **Merge.** 4-connected components over the kept cells; each component's bbox is the
   union of its patches' boxes, its `strength` the best score inside it divided by
   `topScore`, its `distance` `1 - bestSim` (unchanged in meaning, and still inert for
   scoring — `attachPatchHighlights` runs after `assemble`).
4. **Cap.** `maxHighlights` (8) now counts merged regions, not patches.

`regionId` stays synthetic and stays derivable: `"<frameId>#p<smallest patch index in
the component>"`, so a box has a stable key across re-renders.

An absolute floor — "if nothing in this frame scores above X, draw nothing" — is a
second knob, and whether it ships non-zero is decided by the sweep in §4, not here. A
frame recalled by a weak match should probably claim nothing rather than claim its best
patch, but that is a number to measure.

## 3. Rendering: two kinds of claim, two weights

`RegionHit` (`src/retrieve/types.ts`) and `HighlightDTO` (`app/src/shared/types.ts`) gain:

```ts
/** Confidence WITHIN this frame's highlight set: 1 = the strongest box here.
 *  null for a hit with no similarity behind it — an AX-label FTS match. */
strength: number | null;
```

Required, nullable — the `showLabels` pattern, so the compiler finds every builder and
every fixture, and `null` stays a meaning rather than a default. **Every Tier-3 region
hit is `null`**, ANN and FTS alike: a region hit's claim is its label, it renders solid
either way, and normalizing ANN distances into a confidence would invent a number that
tier does not compute. Only patch highlights carry one.

`DetailView` renders them differently, because they claim different things:

- **A labelled region** (`label !== null`) keeps today's solid 1.5px amber rect with its
  label. It says: this control matched, and here is its name.
- **A synthetic patch box** (`label === null`) renders as a strength-scaled translucent
  amber wash with a soft border and no label. It says: the model attended here, this
  strongly.

Both stay amber — amber already means "this matched your search", and inventing a second
hue would say they are different *kinds* of match rather than different *strengths* of
evidence. Nothing truncates and nothing gains a tooltip; the box is the whole statement.

## 4. Calibration: `scripts/highlight-probe.mjs`

Read-only, in the manner of `replay-probe`/`decimate-probe`, and structurally incapable
of writing: it opens the store, reads stored patch sets and blobs, and writes only PNGs
under a scratch path.

- Takes a set of known-answer queries against real frames (`--frame`, `--query`, or a
  built-in set drawn from the user's own store).
- Sweeps `relativeFloor` and the absolute floor, reporting per setting: boxes drawn,
  boxes containing the known answer, boxes on blank space, and the score distribution.
- Writes an overlay PNG per setting so the numbers can be looked at, which is how the
  0.80-vs-0.90 trade above was seen at all.

The shipped constants carry whatever this measures, with the date and the corpus. The
three-query table above is a starting point from ONE frame and is explicitly not enough
to ship on — the sweep runs across several frames and several applications before the
constant is fixed, for the same reason the anchor ladder was falsified twice by
recording in one more app.

## 5. Testing

Root suite, TDD, no model and no store:

- `patchIndexToCell`: cell round-trip against `patchIndexToBox` for every index of a
  real geometry; `null` for global-tile tokens; out-of-range stays `null`.
- `highlightsFrom`: a non-content vector's argmax produces NO box (the reported bug, as a
  test); a patch below the floor is cut; two adjacent kept patches merge into one box
  whose bbox is their union; two separated patches stay two boxes; the cap counts merged
  boxes; a global-tile token never appears; empty `contentIndices` yields `[]`.
- `strength`: monotone in similarity, 1.0 for the best box, `null` on an FTS hit.
- Prompt builders: `queryContentPositions` returns exactly the tokenized query's span for
  both ColSmol and ColModernVBERT, including the `[CLS]`/`[SEP]` difference.
- `test/onnx.smoke.test.ts` (real weights, `ONNX_SMOKE=1`): `embedQueries` returns
  `contentIndices` matching the tokenizer's own encode of the query string.
- The app's typecheck covers the DTO change; `DetailView` has no test today and gains
  none — it is verified by driving the app, below.

## 6. Verification

`npm run typecheck`, `npm test`, `npm --prefix app run typecheck`, then **drive the real
app**: run the reported query against the real store and confirm the boxes land on the
`mcp` tab, the shell command and the sidebar entry, with the junk gone. The suite cannot
see any of this — it has no renderer, and every existing highlight test uses a fake
provider whose query vectors are all content, which is exactly why the bug survived.

## 7. What this does not change

- `patchIndexToBox`'s geometry (measured correct above) and `DetailView`'s percentage
  mapping.
- MaxSim scoring, frame ranking, and the Tier-1/2/3 structure. `attachPatchHighlights`
  still runs last, after `assemble` and after any rerank.
- Tier-3's labelled region highlights, on either path.
- Stored data: patch sets, `region` rows and the FTS tables are untouched, so no
  re-index is required and an existing library improves the moment the app is rebuilt.

## 8. Derived requirements, not solved here

- **An image query's highlights are a different regime.** Its 832 query vectors all count
  as content, so the map is a max over 832 similarities and the floor calibrated for a
  3-vector text query may not suit it. The sweep should report it; changing it is out of
  scope.
- **ColSmol is unmeasured.** Every number here comes from ColModernVBERT, the configured
  provider on the machine where this was reported. The interface change covers both
  adapters; the floor may not.
