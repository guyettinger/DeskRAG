# Patch Highlight Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the amber boxes on a search result land on what actually matched, by narrowing highlighting to the query's content vectors and replacing the per-vector argmax with a floored, merged similarity map.

**Architecture:** The late-interaction retriever (`src/retrieve/tier2-mv.ts`) currently draws one box per query VECTOR — and for a two-word query 12 of 15 vectors are `[CLS]`, `[SEP]` and buffer padding. The provider (which builds the prompt) starts declaring which vectors came from the user's words; the retriever scores every grid patch by max-over-content, cuts at a floor, merges 4-connected survivors into one box each, and reports a `strength` the renderer uses to draw a weaker claim than a labelled AX region. Scoring is untouched — MaxSim keeps every vector.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, onnxruntime-node, React + Electron (electron-vite), sharp.

**Spec:** `docs/superpowers/specs/2026-08-14-patch-highlight-fidelity-design.md`

## Global Constraints

- **Root suite only for pure modules.** `src/embed/onnx/geometry.ts`, both prompt modules and `src/retrieve/*` are tested by `npx vitest run test/<file>` at the repo root. No store, no Electron, no model.
- **`npm run typecheck` is the primary gate**, and `npm --prefix app run typecheck` is the app's separate gate. The app imports `dist/`, so run `npm run build` before any app-side check.
- **`grep -a` / `rg -a`** when searching `src/store/store.ts` — it contains NUL bytes and plain grep silently prints nothing.
- **Do not change scoring.** `searchFramePatches` keeps receiving every query vector, buffer slots included. This plan changes presentation only: no re-index, no stored data touched.
- **Do not touch** `patchIndexToBox`'s arithmetic (measured correct: a painted-rect probe put 16 of the 25 most-changed patches inside the rect), `DetailView`'s percentage mapping, or Tier-3's labelled region highlights.
- **Constants carry their measurement.** Any threshold shipped in Task 7 is written with the number, the corpus and the date in its comment, as `DEFAULT_DECIMATE` is.
- **Commit style:** conventional commits, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/embed/onnx/geometry.ts` | token-grid cell mapping (`patchIndexToCell`, `cellToBox`, `gridTokenCount`); `patchIndexToBox` rebuilt on them | 1 |
| `src/embed/onnx/colsmol-prompt.ts` | `queryContentPositions` for the ColSmol query layout | 2 |
| `src/embed/onnx/colmodernvbert-prompt.ts` | `queryContentPositions` for the `[CLS]`-wrapped layout | 2 |
| `src/embed/types.ts` | `QueryEmbedding`; `MultiVectorProvider.embedQueries` returns it | 3 |
| `src/embed/onnx/colsmol.ts`, `.../colmodernvbert.ts` | adapters return `QueryEmbedding` | 3 |
| `src/embed/fake.ts` | fake declares one content vector, the rest padding | 3 |
| `src/retrieve/types.ts` | `RegionHit.strength: number \| null` | 4 |
| `src/retrieve/tier3.ts` | labelled region hits are `strength: null` | 4 |
| `app/src/shared/types.ts` | `HighlightDTO.strength: number \| null` | 4 |
| `app/src/main/deskrag-service.ts` | carry `strength` into the DTO | 4 |
| `app/src/renderer/src/screens/DetailView.tsx`, `styles.css` | a synthetic patch box renders as a strength-scaled wash | 4 |
| `src/retrieve/tier2-mv.ts` | content-only similarity map, floor, merge, cap | 5, 6 |
| `scripts/highlight-probe.mjs` | read-only floor sweep against the real store + model | 7 |
| `CLAUDE.md` | the invariant: scoring keeps every vector, highlighting keeps content | 8 |

---

### Task 1: Token-grid cells in `geometry.ts`

`patchIndexToBox` computes a cell position inline. The highlighter needs the same cell coordinates to decide adjacency, so they get one definition and the box mapping is rebuilt on top of it — no arithmetic changes.

**Files:**
- Modify: `src/embed/onnx/geometry.ts:112-153`
- Test: `test/onnx.geometry.test.ts` (exists — check with `ls test/onnx.geometry.test.ts`; if absent, create it with the imports shown below)

**Interfaces:**
- Consumes: nothing.
- Produces: `patchIndexToCell(index: number, g: TileGeometry): TileCell | null`, `cellToBox(cell: TileCell, g: TileGeometry): Box`, `gridTokenCount(g: TileGeometry): number`, `interface TileCell { col: number; row: number }`. `patchIndexToBox(index, g): Box | null` keeps its exact current signature and behaviour.

- [ ] **Step 1: Write the failing test**

Append to `test/onnx.geometry.test.ts` (if the file is new, prepend `import { describe, expect, it } from "vitest";` and `import { cellToBox, computeTileGeometry, expectedTokenCount, gridTokenCount, patchIndexToBox, patchIndexToCell } from "../src/embed/onnx/geometry.js";`; if it exists, extend its import list with the new names):

```ts
describe("token-grid cells", () => {
  // 1920x1080 -> 2048x1536 -> 4x3 tiles of 8x8 tokens = a 32x24 cell grid.
  const g = computeTileGeometry(1920, 1080);

  it("counts only grid tokens, excluding the global tile", () => {
    expect(gridTokenCount(g)).toBe(4 * 3 * 64);
    // The global tile is the difference between the two counts.
    expect(expectedTokenCount(g)).toBe(gridTokenCount(g) + 64);
  });

  it("maps the first and last grid tokens to the corners of the cell grid", () => {
    expect(patchIndexToCell(0, g)).toEqual({ col: 0, row: 0 });
    expect(patchIndexToCell(gridTokenCount(g) - 1, g)).toEqual({ col: 31, row: 23 });
  });

  it("advances one cell per token within a tile and one tile per 64 tokens", () => {
    expect(patchIndexToCell(1, g)).toEqual({ col: 1, row: 0 });
    expect(patchIndexToCell(8, g)).toEqual({ col: 0, row: 1 });
    // Tile 1 is the second tile of the top row: its first token is at col 8.
    expect(patchIndexToCell(64, g)).toEqual({ col: 8, row: 0 });
    // Tile 4 is the first tile of the second tile-row: row 8.
    expect(patchIndexToCell(4 * 64, g)).toEqual({ col: 0, row: 8 });
  });

  it("returns null for a global-tile token and for an out-of-range index", () => {
    expect(patchIndexToCell(gridTokenCount(g), g)).toBeNull();
    expect(patchIndexToCell(-1, g)).toBeNull();
    expect(patchIndexToCell(10_000, g)).toBeNull();
    expect(patchIndexToCell(1.5, g)).toBeNull();
  });

  it("agrees with patchIndexToBox for every grid token", () => {
    for (let i = 0; i < gridTokenCount(g); i++) {
      expect(cellToBox(patchIndexToCell(i, g)!, g)).toEqual(patchIndexToBox(i, g));
    }
  });

  it("still maps a global-tile token to the whole frame", () => {
    expect(patchIndexToBox(gridTokenCount(g), g)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onnx.geometry.test.ts`
Expected: FAIL — `patchIndexToCell is not a function` (or a TS error that it is not exported).

- [ ] **Step 3: Write the implementation**

In `src/embed/onnx/geometry.ts`, add above `patchIndexToBox`:

```ts
/** A cell in the whole-frame token grid: `cols * tokenGrid` by `rows * tokenGrid`. */
export interface TileCell {
  col: number;
  row: number;
}

/** Image tokens belonging to the tile GRID — i.e. excluding the global tile. */
export function gridTokenCount(g: TileGeometry): number {
  return g.cols * g.rows * g.tokensPerTile;
}

/**
 * The token-grid cell an image token occupies, or null when it has no cell:
 * a global-tile token (it covers the whole frame) or an out-of-range index.
 *
 * Callers that need to tell those two apart range-check first, as
 * `patchIndexToBox` does.
 */
export function patchIndexToCell(index: number, g: TileGeometry): TileCell | null {
  if (!Number.isInteger(index) || index < 0 || index >= expectedTokenCount(g)) return null;
  const tileIndex = Math.floor(index / g.tokensPerTile);
  if (g.hasGlobalTile && tileIndex === g.cols * g.rows) return null;
  const within = index % g.tokensPerTile;
  return {
    col: (tileIndex % g.cols) * g.tokenGrid + (within % g.tokenGrid),
    row: Math.floor(tileIndex / g.cols) * g.tokenGrid + Math.floor(within / g.tokenGrid),
  };
}

/**
 * Frame-space box for one cell. Scaled space -> source space with SEPARATE
 * factors: the resize to a whole number of tiles does not preserve aspect.
 */
export function cellToBox(cell: TileCell, g: TileGeometry): Box {
  const size = g.tileSize / g.tokenGrid;
  const x = cell.col * size * g.scaleX;
  const y = cell.row * size * g.scaleY;
  return {
    x,
    y,
    w: Math.max(0, Math.min(size * g.scaleX, g.srcWidth - x)),
    h: Math.max(0, Math.min(size * g.scaleY, g.srcHeight - y)),
  };
}
```

Then replace the body of `patchIndexToBox` (keeping its existing doc comment) with:

```ts
export function patchIndexToBox(index: number, g: TileGeometry): Box | null {
  if (!Number.isInteger(index) || index < 0 || index >= expectedTokenCount(g)) {
    return null;
  }
  const cell = patchIndexToCell(index, g);
  // In range and cell-less means the global tile, which covers everything.
  if (!cell) return { x: 0, y: 0, w: g.srcWidth, h: g.srcHeight };
  return cellToBox(cell, g);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/onnx.geometry.test.ts test/onnx.colsmol.test.ts test/onnx.colmodernvbert.test.ts test/tier2-mv.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/embed/onnx/geometry.ts test/onnx.geometry.test.ts
git commit -m "$(cat <<'EOF'
refactor(geometry): give the token grid one definition

patchIndexToBox computed a cell position inline; the highlighter needs the
same coordinates to decide which patches are adjacent. patchIndexToCell +
cellToBox are that definition and patchIndexToBox is rebuilt on them, with
its arithmetic and its whole-frame answer for a global-tile token unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `queryContentPositions` in both prompt modules

The retriever must not hard-code which vectors are padding: ColSmol's query is `tokens + 10 buffer`, ColModernVBERT's is `[CLS] + tokens + 10 buffer + [SEP]`. Each prompt module states its own layout, beside the `buildQueryPrompt` that creates it.

**Files:**
- Modify: `src/embed/onnx/colsmol-prompt.ts` (after `buildQueryPrompt`), `src/embed/onnx/colmodernvbert-prompt.ts` (after `buildQueryPrompt`)
- Test: `test/onnx.colsmol.test.ts`, `test/onnx.colmodernvbert.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `queryContentPositions(queryTokenIds: number[]): number[]` in BOTH modules — same name, same signature, same input as `buildQueryPrompt` (the tokenizer's raw ids for the query text). Returns positions into the sequence `buildQueryPrompt` builds from those ids.

- [ ] **Step 1: Write the failing tests**

Append to `test/onnx.colmodernvbert.test.ts` (inside the existing top-level `describe` for the prompt, or as a new `describe` — check the file's structure and match it):

```ts
describe("queryContentPositions (colmodernvbert)", () => {
  it("names exactly the positions holding the query's own tokens", () => {
    const queryIds = [111, 222, 333];
    const ids = buildQueryPrompt(queryIds);
    const positions = queryContentPositions(queryIds);
    expect(positions).toEqual([1, 2, 3]); // after [CLS]
    expect(positions.map((p) => ids[p])).toEqual(queryIds);
  });

  it("excludes the wrapper and every buffer token", () => {
    const ids = buildQueryPrompt([111, 222]);
    const positions = new Set(queryContentPositions([111, 222]));
    for (let i = 0; i < ids.length; i++) {
      const special =
        ids[i] === MV_TOK.cls || ids[i] === MV_TOK.sep || ids[i] === MV_TOK.endOfUtterance;
      expect(positions.has(i)).toBe(!special);
    }
  });

  it("strips a wrapper the tokenizer already added, like buildQueryPrompt does", () => {
    expect(queryContentPositions([MV_TOK.cls, 111, 222, MV_TOK.sep])).toEqual([1, 2]);
  });

  it("returns nothing for an empty query", () => {
    expect(queryContentPositions([])).toEqual([]);
  });
});
```

Add `queryContentPositions` to that file's import from `../src/embed/onnx/colmodernvbert-prompt.js`.

Append to `test/onnx.colsmol.test.ts` (importing `buildQueryPrompt`, `queryContentPositions`, `TOK`, `QUERY_BUFFER_TOKENS` from `../src/embed/onnx/colsmol-prompt.js` as needed):

```ts
describe("queryContentPositions (colsmol)", () => {
  it("names the query's own tokens, which start at position 0 — there is no wrapper", () => {
    const queryIds = [111, 222, 333];
    const ids = buildQueryPrompt(queryIds);
    const positions = queryContentPositions(queryIds);
    expect(positions).toEqual([0, 1, 2]);
    expect(positions.map((p) => ids[p])).toEqual(queryIds);
    expect(ids.length).toBe(queryIds.length + QUERY_BUFFER_TOKENS);
  });

  it("excludes every buffer token", () => {
    const ids = buildQueryPrompt([111, 222]);
    const positions = new Set(queryContentPositions([111, 222]));
    for (let i = 0; i < ids.length; i++) {
      expect(positions.has(i)).toBe(ids[i] !== TOK.endOfUtterance);
    }
  });

  it("returns nothing for an empty query", () => {
    expect(queryContentPositions([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/onnx.colsmol.test.ts test/onnx.colmodernvbert.test.ts`
Expected: FAIL — `queryContentPositions` is not exported by either module.

- [ ] **Step 3: Write the implementation**

In `src/embed/onnx/colmodernvbert-prompt.ts`, after `buildQueryPrompt`:

```ts
/**
 * Positions in `buildQueryPrompt(queryTokenIds)` that hold the user's OWN words.
 *
 * Derived from the layout rather than by filtering ids, so a query that happens
 * to contain a special id is still reported honestly: content is everything
 * between the [CLS] and the buffer run, which is exactly what buildQueryPrompt
 * puts there.
 *
 * Scoring uses every vector — the buffer slots are the learned expansion slots
 * late interaction relies on. HIGHLIGHTING uses only these, because a buffer or
 * wrapper vector's best-matching patch is not an answer to anything the user
 * typed. Measured: for "probe mcp", 12 of 15 vectors are wrapper or buffer, and
 * [CLS] alone scored 0.992 against a patch of blank document space.
 */
export function queryContentPositions(queryTokenIds: number[]): number[] {
  const n = stripWrapper(queryTokenIds).length;
  // Position 0 is the [CLS] buildQueryPrompt prepends.
  return Array.from({ length: n }, (_, i) => i + 1);
}
```

In `src/embed/onnx/colsmol-prompt.ts`, after `buildQueryPrompt`:

```ts
/**
 * Positions in `buildQueryPrompt(queryTokenIds)` that hold the user's OWN words.
 *
 * This tokenizer's prompt has NO [CLS]/[SEP] wrapper — the query's tokens start
 * at 0 and the buffer run is appended after them. Same contract as the
 * ColModernVBERT module's function of this name; the layouts differ, which is
 * exactly why each module states its own.
 */
export function queryContentPositions(queryTokenIds: number[]): number[] {
  return Array.from({ length: queryTokenIds.length }, (_, i) => i);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/onnx.colsmol.test.ts test/onnx.colmodernvbert.test.ts` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/embed/onnx/colsmol-prompt.ts src/embed/onnx/colmodernvbert-prompt.ts test/onnx.colsmol.test.ts test/onnx.colmodernvbert.test.ts
git commit -m "$(cat <<'EOF'
feat(prompt): each query prompt states which vectors are the user's words

ColSmol's query is tokens + 10 buffer; ColModernVBERT's is [CLS] + tokens +
10 buffer + [SEP]. Only the module that builds the prompt knows that, so each
one now says so beside its builder rather than leaving a consumer to guess.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `QueryEmbedding` on the provider interface

**Files:**
- Modify: `src/embed/types.ts:91-97`, `src/embed/onnx/colsmol.ts:210-227`, `src/embed/onnx/colmodernvbert.ts:224-243`, `src/embed/fake.ts:138-140`, `src/retrieve/tier2-mv.ts:52-62`
- Test: `test/onnx.colsmol.test.ts`, `test/onnx.colmodernvbert.test.ts`, `test/onnx.smoke.test.ts`, `test/tier2-mv.test.ts` (call-site updates)

**Interfaces:**
- Consumes: `queryContentPositions` from both prompt modules (Task 2).
- Produces: `interface QueryEmbedding { vectors: Float32Array[]; contentIndices: number[] }` exported from `src/embed/types.ts`; `MultiVectorProvider.embedQueries(texts: string[]): Promise<QueryEmbedding[]>`; `Tier2MultiVectorRetriever.embedQuery(q: Query): Promise<QueryEmbedding | null>`.

- [ ] **Step 1: Write the failing tests**

In `test/onnx.colmodernvbert.test.ts`, replace the existing `it("keeps every query position, buffer tokens and wrapper included", ...)` body's first assertion and add a content assertion:

```ts
  it("keeps every query position, buffer tokens and wrapper included", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    const [q] = await p.embedQueries(["abc"]);
    expect(q!.vectors.length).toBe(3 + QUERY_BUFFER_TOKENS + 2);
    const ids = Array.from(seen[0]!.input_ids!.data as BigInt64Array).map(Number);
    expect(ids[0]).toBe(MV_TOK.cls);
    expect(ids[ids.length - 1]).toBe(MV_TOK.sep);
    expect(ids.slice(-1 - QUERY_BUFFER_TOKENS, -1).every((t) => t === MV_TOK.endOfUtterance)).toBe(
      true,
    );
  });

  it("reports which query vectors are the user's own words", async () => {
    const p = new ColModernVBertMultiVector(opts(stubSession([])));
    const [q] = await p.embedQueries(["abc"]);
    // The stub tokenizer in this file yields 3 ids for "abc"; they sit after [CLS].
    expect(q!.contentIndices).toEqual([1, 2, 3]);
    expect(q!.contentIndices.length).toBeLessThan(q!.vectors.length);
  });
```

(Read the file's `opts`/`stubSession`/stub tokenizer first and match the id count it produces — adjust `[1, 2, 3]` to `queryContentPositions(<the stub's ids>)` if it differs.)

In `test/onnx.colsmol.test.ts`, update the two `embedQueries` assertions to read `q!.vectors` and add:

```ts
  it("reports the query's own token positions, which start at 0", async () => {
    const p = new ColSmolMultiVector(opts(stubSession([])));
    const [q] = await p.embedQueries(["abc"]);
    expect(q!.contentIndices[0]).toBe(0);
    expect(q!.contentIndices.length).toBe(q!.vectors.length - QUERY_BUFFER_TOKENS);
  });
```

In `src/embed/fake.ts`, the fake's new behaviour needs a test too — add to `test/tier2-mv.test.ts`:

```ts
it("the fake provider marks one content vector and pads the rest", async () => {
  const [q] = await mv.embedQueries(["x"]);
  expect(q!.vectors.length).toBe(4);
  expect(q!.contentIndices).toEqual([0]);
});
```

And in `test/onnx.smoke.test.ts` (real weights, skipped without `ONNX_SMOKE=1`), add to the ColModernVBERT live describe — the spec asks for this assertion against the real tokenizer, where a stub cannot catch a drifted wrapper:

```ts
  it("names the query's own token positions, inside the wrapper", { timeout: 600_000 }, async () => {
    const p = provider();
    const [q] = await p.embedQueries(["sign in button"]);
    // [CLS] + tokens + 10 buffer + [SEP]: content is everything between the
    // wrapper and the buffer run, and never the first or last position.
    expect(q!.contentIndices.length).toBe(q!.vectors.length - QUERY_BUFFER_TOKENS - 2);
    expect(q!.contentIndices[0]).toBe(1);
    expect(q!.contentIndices.at(-1)).toBe(q!.vectors.length - QUERY_BUFFER_TOKENS - 2);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/onnx.colsmol.test.ts test/onnx.colmodernvbert.test.ts test/tier2-mv.test.ts`
Expected: FAIL — `q.vectors` is undefined / `contentIndices` does not exist.

- [ ] **Step 3: Write the implementation**

`src/embed/types.ts`, replacing the `MultiVectorProvider` block:

```ts
/**
 * One embedded query: every vector, plus which of them came from the user's
 * own words.
 *
 * SCORING uses `vectors` whole — the buffer/padding slots are the learned
 * expansion slots late interaction relies on, and dropping them would change
 * retrieval. HIGHLIGHTING uses only `contentIndices`, because a padding or
 * wrapper vector's best-matching patch answers nothing the user asked.
 *
 * INDICES rather than a count or a range: content is not a prefix for every
 * prompt (ColModernVBERT puts [CLS] first), and contiguity is true of both
 * adapters today without being a property to depend on.
 */
export interface QueryEmbedding {
  vectors: Float32Array[];
  contentIndices: number[];
}

export interface MultiVectorProvider extends NamespacedProvider {
  readonly multiVector: true;
  /** Per image: N vectors of `dimensions` each. */
  embedImages(images: Uint8Array[]): Promise<Float32Array[][]>;
  /** Per query: M vectors of `dimensions` each, with the content ones named. */
  embedQueries(texts: string[]): Promise<QueryEmbedding[]>;
}
```

`src/embed/onnx/colmodernvbert.ts` — import `queryContentPositions` from `./colmodernvbert-prompt.js` and `type QueryEmbedding` from `../types.js`, then:

```ts
  async embedQueries(texts: string[]): Promise<QueryEmbedding[]> {
    if (texts.length === 0) return [];
    const tokenize = await this.tokenizer();
    const side = this.tileConfig.tileSize;
    // The graph declares pixel inputs as required, but a query carries no image.
    // ONE zero tile satisfies the signature — verified against the real export,
    // which returned [1, 8, 128] for it — and with no <image> token in the
    // prompt its vision output is never merged into the sequence. fastembed
    // instead pads to seq_length, ~1.4GB of zeros for a 30-token query.
    const dummy = new Float32Array(3 * side * side);

    const results: QueryEmbedding[] = [];
    for (const text of texts) {
      const queryIds = tokenize(text).ids;
      const ids = buildQueryPrompt(queryIds);
      // Every query position is kept, buffer tokens included: those are the
      // learned expansion slots late interaction relies on. Which of them are
      // the user's WORDS is reported separately, for highlighting.
      results.push({
        vectors: await this.runAndSelect(ids, dummy, 1, null),
        contentIndices: queryContentPositions(queryIds),
      });
    }
    return results;
  }
```

`src/embed/onnx/colsmol.ts` — the same shape, importing `queryContentPositions` from `./colsmol-prompt.js`:

```ts
  async embedQueries(texts: string[]): Promise<QueryEmbedding[]> {
    if (texts.length === 0) return [];
    const tokenize = await this.tokenizer();
    const side = this.tileConfig.tileSize;
    // The graph declares pixel inputs as required, but a query carries no image.
    // One zero tile satisfies the signature; with no <image> tokens in the
    // prompt its vision output is never merged into the sequence.
    const dummy = new Float32Array(3 * side * side);

    const results: QueryEmbedding[] = [];
    for (const text of texts) {
      const queryIds = tokenize(text).ids;
      const ids = buildQueryPrompt(queryIds);
      // Every query position is kept, buffer tokens included: those are the
      // learned expansion slots late interaction relies on.
      results.push({
        vectors: await this.runAndSelect(ids, dummy, 1, null),
        contentIndices: queryContentPositions(queryIds),
      });
    }
    return results;
  }
```

`src/embed/fake.ts`:

```ts
  async embedQueries(texts: string[]): Promise<QueryEmbedding[]> {
    return texts.map((t) => ({
      vectors: this.setFor(`txt:${t}`),
      // The fake builds no prompt, so it declares the smallest honest shape: the
      // FIRST vector stands for the query's words and the rest for padding. A
      // fake where every vector is content is what let the highlight bug ship.
      contentIndices: [0],
    }));
  }
```

`src/retrieve/tier2-mv.ts` — `embedQuery` and its two callers-of-the-vectors:

```ts
  /**
   * Query vectors for either modality, or null when the query carries neither.
   * Call ONCE per retrieval: this is the expensive step.
   */
  async embedQuery(q: Query): Promise<QueryEmbedding | null> {
    if (q.image) {
      const [v] = await this.provider.embedImages([q.image]);
      if (!v || v.length === 0) return null;
      // An image query's vectors ARE patches of the query image, so all of them
      // carry content — there is no prompt padding on this branch.
      return { vectors: v, contentIndices: v.map((_, i) => i) };
    }
    if (q.text && q.text.length > 0) {
      const [e] = await this.provider.embedQueries([q.text]);
      return e && e.vectors.length > 0 ? e : null;
    }
    return null;
  }
```

`retrieveFrames`/`retrieveFramesUnscoped` keep taking `Float32Array[]`, and `highlightsForFrame`/`highlightsFrom` keep their current `Float32Array[]` signatures for now (Task 5 changes them). **So every existing test call site that passed `q!` into a highlight method now passes `q!.vectors`** — `test/tier2-mv.test.ts` lines ~116, ~139, ~165, ~172 — and `test/onnx.smoke.test.ts` reads `q!.vectors` in its six MaxSim/argmax spots (~187, ~204, ~216, ~332, ~349, ~361). Task 5 turns the tier2-mv ones back into `q!`.

In `src/retrieve/assemble.ts`, change the local type and the two uses:

```ts
    const queryVectors = this.tier2mv ? await this.tier2mv.embedQuery(query) : null;
    const frameHits = await this.recallFrames(query, segScope, queryVectors);
```

with `recallFrames`'s parameter typed `queryVectors: QueryEmbedding | null` and its body passing `queryVectors.vectors` to `retrieveFrames`/`retrieveFramesUnscoped`, and `attachPatchHighlights(frames, queryVectors)` typed the same way, passing `queryVectors.vectors` to `highlightsForFrame` until Task 5.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. The typecheck is the point of this task — it names every call site. `test/onnx.smoke.test.ts` needs `q!` → `q!.vectors` in four places (lines ~187, ~204, ~216, ~332, ~349, ~361); it is skipped without `ONNX_SMOKE=1` but must still compile.

- [ ] **Step 5: Commit**

```bash
git add src/embed/types.ts src/embed/onnx/colsmol.ts src/embed/onnx/colmodernvbert.ts src/embed/fake.ts src/retrieve/tier2-mv.ts src/retrieve/assemble.ts test/
git commit -m "$(cat <<'EOF'
feat(embed): embedQueries reports which vectors are the query's words

QueryEmbedding carries the vectors and the content indices together. Scoring
still uses every vector; highlighting is about to stop doing so. The fake now
marks one content vector and pads the rest — a fake whose every vector was
content is what let the highlight bug through the suite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `strength` through the DTO to the renderer

**Files:**
- Modify: `src/retrieve/types.ts:84-106`, `src/retrieve/tier3.ts:66-75`, `src/retrieve/tier2-mv.ts:127-148`, `app/src/shared/types.ts:166-172`, `app/src/main/deskrag-service.ts:758-764`, `app/src/renderer/src/screens/DetailView.tsx:112-117`, `app/src/renderer/src/styles.css:846-851`
- Test: `test/tier3.test.ts`, `test/assemble.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RegionHit.strength: number | null` and `HighlightDTO.strength: number | null`. `null` = no similarity behind this hit (every Tier-3 region hit). A number = confidence WITHIN this frame's highlight set, where 1 is the strongest box on the frame.

- [ ] **Step 1: Write the failing test**

Append to `test/tier3.test.ts` (inside its existing describe, reusing its store fixture — read the file for the helper it uses to seed a region and a query):

```ts
  it("reports no strength: a region hit's claim is its label, not a confidence", async () => {
    const hits = await tier3.retrieveRegions({ text: "Publish" }, [frameId]);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.strength).toBeNull();
  });
```

Append to `test/tier2-mv.test.ts`, in the `MaxSim highlights` describe:

```ts
  it("scores the strongest box on the frame at strength 1", async () => {
    const [patches] = await mv.embedImages([Uint8Array.from([1, 2, 3])]);
    const [q] = await mv.embedQueries(["x"]);
    // Still `.vectors` here: highlightsFrom takes the QueryEmbedding in Task 5.
    const hl = t2().highlightsFrom("f1", q!.vectors, patches!, 1280, 800);
    expect(hl.length).toBeGreaterThan(0);
    expect(hl[0]!.strength).toBeCloseTo(1, 6);
    for (const h of hl) {
      expect(h.strength).not.toBeNull();
      expect(h.strength!).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tier3.test.ts test/tier2-mv.test.ts`
Expected: FAIL — `strength` does not exist on `RegionHit`.

- [ ] **Step 3: Write the implementation**

`src/retrieve/types.ts`, inside `RegionHit` after `matchedBy`:

```ts
  /**
   * Confidence WITHIN this frame's highlight set: 1 is the strongest box on the
   * frame, and the renderer scales the box's weight by it.
   *
   * NULL means there is no similarity behind this hit, which is every Tier-3
   * region hit — ANN and FTS alike. A region hit's claim is its LABEL and it
   * draws solid either way; normalizing an ANN distance into a confidence would
   * invent a number that tier does not compute. Only synthetic patch highlights
   * carry one.
   */
  strength: number | null;
```

`src/retrieve/tier3.ts`, in `add()`'s `hits.set(...)` object, after `matchedBy: [how],`:

```ts
        strength: null,
```

`src/retrieve/tier2-mv.ts` — in the current `highlightsFrom`, compute the top similarity before mapping and set `strength` on each hit. Replace the return block's `.flatMap(...)` body's object with one carrying:

```ts
            strength: sim / top,
```

where `top` is `Math.max(...best.values())` computed once above the `return`. (Task 5 replaces this whole function; this step keeps the field honest in the meantime.)

`app/src/shared/types.ts`:

```ts
export interface HighlightDTO {
  regionId: string;
  bbox: Bbox;
  role: string | null;
  label: string | null;
  matchedBy: string[];
  /**
   * Confidence within this frame's highlight set (1 = strongest), or null when
   * there is no similarity behind the hit — every labelled AX region is null
   * and draws solid. See RegionHit.strength.
   */
  strength: number | null;
}
```

`app/src/main/deskrag-service.ts`, in the `fr.highlights.map` at line ~758, add `strength: h.strength,` after `matchedBy: h.matchedBy,`.

`app/src/renderer/src/screens/DetailView.tsx` — replace the highlight map:

```tsx
              {locatable &&
                detail.highlights.map((h) => (
                  <div
                    key={h.regionId}
                    // A LABELLED region says "this control matched, and here is
                    // its name"; a synthetic patch box says only "the model
                    // attended here, this strongly". Different claims, drawn at
                    // different weights.
                    className={`bbox${h.label === null ? " bbox--patch" : ""}`}
                    style={
                      {
                        ...boxStyle(h.bbox, detail.width, detail.height),
                        ...(h.strength !== null ? { "--strength": h.strength } : {}),
                      } as React.CSSProperties
                    }
                  >
                    {h.label && <span className="bbox__label">{h.label}</span>}
                  </div>
                ))}
```

`app/src/renderer/src/styles.css`, after the `.bbox` rule:

```css
/* A synthetic patch box is a WEAKER claim than a labelled region: the model
   attended to this cell, this strongly. Washed and faded by strength rather
   than outlined solid, so a reader can tell evidence from identification at a
   glance. `--strength` is set inline by DetailView; the fallback keeps a box
   visible if it is ever absent. */
.bbox--patch {
  border-width: 1px;
  border-color: color-mix(in srgb, var(--amber) 70%, transparent);
  background: color-mix(in srgb, var(--amber) 16%, transparent);
  opacity: calc(0.45 + 0.55 * var(--strength, 1));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run build && npm --prefix app run typecheck`
Expected: PASS. The app typecheck fails until `deskrag-service.ts` carries the field — that is the required-field pattern working.

- [ ] **Step 5: Commit**

```bash
git add src/retrieve/types.ts src/retrieve/tier3.ts src/retrieve/tier2-mv.ts app/src/shared/types.ts app/src/main/deskrag-service.ts app/src/renderer/src/screens/DetailView.tsx app/src/renderer/src/styles.css test/
git commit -m "$(cat <<'EOF'
feat(highlights): a synthetic patch box says how strong its claim is

strength is required and nullable, so the compiler finds every builder:
null for a labelled AX region (its claim is its label, and it keeps the solid
amber rect), a number for a patch highlight, which now renders as a wash
faded by how well it matched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Content-only similarity map, floored and merged

The behaviour change. Everything before this was plumbing.

**Files:**
- Modify: `src/retrieve/tier2-mv.ts:24-46, 83-149`, `src/retrieve/assemble.ts:248-276`
- Test: `test/tier2-mv.test.ts:110-174`

**Interfaces:**
- Consumes: `patchIndexToCell`, `cellToBox`, `gridTokenCount` (Task 1); `QueryEmbedding` (Task 3); `RegionHit.strength` (Task 4).
- Produces: `highlightsFrom(frameId: string, query: QueryEmbedding, patches: Float32Array[], width: number, height: number): RegionHit[]` and `highlightsForFrame(frameId: string, query: QueryEmbedding, width: number, height: number): Promise<RegionHit[]>`; options `relativeFloor` and `minScore` on `Tier2MultiVectorOptions`.

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe("MaxSim highlights", ...)` block in `test/tier2-mv.test.ts` with:

```ts
describe("MaxSim highlights", () => {
  const W = 1280;
  const H = 800;
  const geo = computeTileGeometry(W, H);
  const DIM = 16;

  /** A unit vector pointing along `axis`, so similarity is exactly controllable. */
  const axis = (a: number, scale = 1): Float32Array => {
    const v = new Float32Array(DIM);
    v[a] = scale;
    return v;
  };
  /** A patch set where every grid patch is `filler` except the named indices. */
  const patchSet = (special: Map<number, Float32Array>): Float32Array[] => {
    const out: Float32Array[] = [];
    for (let i = 0; i < gridTokenCount(geo) + geo.tokensPerTile; i++) {
      out.push(special.get(i) ?? axis(15, 0.01));
    }
    return out;
  };
  const cellIndex = (col: number, row: number): number => {
    for (let i = 0; i < gridTokenCount(geo); i++) {
      const c = patchIndexToCell(i, geo);
      if (c && c.col === col && c.row === row) return i;
    }
    throw new Error(`no patch at ${col},${row}`);
  };

  it("ignores a non-content vector, however well it matches", () => {
    // THE REPORTED BUG: [CLS] scored 0.992 against a patch of blank space and
    // was drawn first. Vector 1 here is that vector; only vector 0 is content.
    const contentTarget = cellIndex(0, 0);
    const paddingTarget = cellIndex(20, 20);
    const patches = patchSet(
      new Map([
        [contentTarget, axis(0)],
        [paddingTarget, axis(1)],
      ]),
    );
    const hl = new Tier2MultiVectorRetriever(store, mv, { relativeFloor: 0.5 }).highlightsFrom(
      "f1",
      { vectors: [axis(0), axis(1)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(1);
    expect(hl[0]!.bbox).toEqual(cellToBox({ col: 0, row: 0 }, geo));
  });

  it("merges adjacent patches into ONE box spanning them", () => {
    const a = cellIndex(3, 4);
    const b = cellIndex(4, 4);
    const patches = patchSet(new Map([[a, axis(0)], [b, axis(0)]]));
    const hl = new Tier2MultiVectorRetriever(store, mv, { relativeFloor: 0.5 }).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(1);
    const left = cellToBox({ col: 3, row: 4 }, geo);
    const right = cellToBox({ col: 4, row: 4 }, geo);
    expect(hl[0]!.bbox.x).toBeCloseTo(left.x, 6);
    expect(hl[0]!.bbox.w).toBeCloseTo(right.x + right.w - left.x, 6);
    expect(hl[0]!.bbox.h).toBeCloseTo(left.h, 6);
  });

  it("keeps separated patches as separate boxes", () => {
    const patches = patchSet(
      new Map([[cellIndex(2, 2), axis(0)], [cellIndex(20, 15), axis(0)]]),
    );
    const hl = new Tier2MultiVectorRetriever(store, mv, { relativeFloor: 0.5 }).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl.length).toBe(2);
  });

  it("cuts a patch below the relative floor", () => {
    const strong = cellIndex(1, 1);
    const weak = cellIndex(10, 10);
    const patches = patchSet(new Map([[strong, axis(0)], [weak, axis(0, 0.5)]]));
    const q = { vectors: [axis(0)], contentIndices: [0] };
    const r = (relativeFloor: number) =>
      new Tier2MultiVectorRetriever(store, mv, { relativeFloor }).highlightsFrom(
        "f1",
        q,
        patches,
        W,
        H,
      );
    expect(r(0.4).length).toBe(2); // 0.5 of the top survives a 0.4 floor
    expect(r(0.8).length).toBe(1); // and not a 0.8 one
  });

  it("draws nothing when the best patch is below the absolute floor", () => {
    const patches = patchSet(new Map([[cellIndex(1, 1), axis(0, 0.2)]]));
    const hl = new Tier2MultiVectorRetriever(store, mv, { minScore: 0.5 }).highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    expect(hl).toEqual([]);
  });

  it("never highlights the global tile, and does not let it cost a slot", () => {
    const globalIdx = gridTokenCount(geo);
    const patches = patchSet(new Map([[globalIdx, axis(0)], [cellIndex(5, 5), axis(0, 0.9)]]));
    const hl = new Tier2MultiVectorRetriever(store, mv, {
      relativeFloor: 0.5,
      maxHighlights: 1,
    }).highlightsFrom("f1", { vectors: [axis(0)], contentIndices: [0] }, patches, W, H);
    expect(hl.length).toBe(1);
    expect(hl[0]!.bbox).toEqual(cellToBox({ col: 5, row: 5 }, geo));
  });

  it("caps at maxHighlights, keeping the strongest boxes", () => {
    const patches = patchSet(
      new Map([
        [cellIndex(1, 1), axis(0, 1.0)],
        [cellIndex(10, 1), axis(0, 0.9)],
        [cellIndex(20, 1), axis(0, 0.8)],
      ]),
    );
    const hl = new Tier2MultiVectorRetriever(store, mv, {
      relativeFloor: 0.5,
      maxHighlights: 2,
    }).highlightsFrom("f1", { vectors: [axis(0)], contentIndices: [0] }, patches, W, H);
    expect(hl.length).toBe(2);
    expect(hl[0]!.strength).toBeCloseTo(1, 6);
    expect(hl[1]!.strength!).toBeLessThan(1);
  });

  it("returns [] when the query has no content vectors", () => {
    const patches = patchSet(new Map([[cellIndex(1, 1), axis(0)]]));
    expect(
      t2().highlightsFrom("f1", { vectors: [axis(0)], contentIndices: [] }, patches, W, H),
    ).toEqual([]);
  });

  it("keeps every box inside the frame and carries the synthetic shape", () => {
    const patches = patchSet(new Map([[cellIndex(31, 24 - 1), axis(0)]]));
    const hl = t2().highlightsFrom(
      "f1",
      { vectors: [axis(0)], contentIndices: [0] },
      patches,
      W,
      H,
    );
    for (const h of hl) {
      expect(h.frameId).toBe("f1");
      expect(h.matchedBy).toEqual(["ann"]);
      expect(h.regionId).toMatch(/^f1#p\d+$/);
      expect(h.role).toBeNull();
      expect(h.label).toBeNull();
      expect(h.bbox.x + h.bbox.w).toBeLessThanOrEqual(W + 1e-9);
      expect(h.bbox.y + h.bbox.h).toBeLessThanOrEqual(H + 1e-9);
    }
  });

  it("reads stored patches when given a frame id", async () => {
    await seedFrames();
    const [q] = await mv.embedQueries(["x"]);
    expect((await t2().highlightsForFrame("f1", q!, 1280, 800)).length).toBeGreaterThanOrEqual(0);
  });

  it("returns [] for a frame with no stored patches", async () => {
    const [q] = await mv.embedQueries(["x"]);
    expect(await t2().highlightsForFrame("nope", q!, 1280, 800)).toEqual([]);
  });
});
```

Add to the file's imports: `cellToBox`, `gridTokenCount`, `patchIndexToCell` from `../src/embed/onnx/geometry.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tier2-mv.test.ts`
Expected: FAIL — `highlightsFrom` takes `Float32Array[]`, not a `QueryEmbedding`; no `relativeFloor`/`minScore` options.

- [ ] **Step 3: Write the implementation**

In `src/retrieve/tier2-mv.ts`, extend the options and replace both highlight methods:

```ts
export interface Tier2MultiVectorOptions {
  topN?: number;
  hydrate?: boolean;
  /** Upper bound on highlight boxes per frame, counted AFTER merging. */
  maxHighlights?: number;
  /** Keep patches scoring at least this fraction of the frame's best patch. */
  relativeFloor?: number;
  /** Draw nothing at all when the frame's best patch scores below this. */
  minScore?: number;
}

/**
 * Keep a patch scoring at least this fraction of the frame's best.
 *
 * Measured 2026-08-14 on a real ColModernVBERT library (see
 * scripts/highlight-probe.mjs): at 0.80 the query "probe mcp" boxes the `mcp`
 * tab title, `probe:mcp` inside a shell command and the `mcp` sidebar entry —
 * the three obvious answers — plus two boxes on blank space. At 0.90 it keeps
 * two correct boxes and LOSES a real answer.
 */
const DEFAULT_RELATIVE_FLOOR = 0.8;

/**
 * A frame whose best patch scores at or below this claims nothing rather than
 * outlining its least-bad cell. Zero also handles a negative best similarity,
 * where a relative floor is meaningless (0.8 x a negative number is LARGER).
 */
const DEFAULT_MIN_SCORE = 0;
```

Constructor: `this.maxHighlights = opts.maxHighlights ?? 8; this.relativeFloor = opts.relativeFloor ?? DEFAULT_RELATIVE_FLOOR; this.minScore = opts.minScore ?? DEFAULT_MIN_SCORE;` with matching `private readonly` fields.

```ts
  /**
   * Highlight boxes for one frame: a similarity map over the frame's GRID
   * patches, cut at a floor and merged into contiguous regions.
   *
   * Only the query's CONTENT vectors score the map. One box per query vector's
   * argmax was the shipped rule, and for "probe mcp" that drew seven boxes from
   * fifteen vectors of which twelve were [CLS], [SEP] and buffer padding —
   * [CLS] scoring 0.992 against blank document space and therefore ranking
   * first. Scoring still uses every vector; see QueryEmbedding.
   */
  async highlightsForFrame(
    frameId: string,
    query: QueryEmbedding,
    width: number,
    height: number,
  ): Promise<RegionHit[]> {
    if (query.contentIndices.length === 0 || width <= 0 || height <= 0) return [];
    const patches = await this.store.getFramePatches(this.namespace, frameId);
    if (!patches || patches.length === 0) return [];
    return this.highlightsFrom(frameId, query, patches, width, height);
  }

  /** Pure part of the above, separated so it is testable without a store. */
  highlightsFrom(
    frameId: string,
    query: QueryEmbedding,
    patches: Float32Array[],
    width: number,
    height: number,
  ): RegionHit[] {
    if (width <= 0 || height <= 0) return [];
    const content = query.contentIndices
      .map((i) => query.vectors[i])
      .filter((v): v is Float32Array => v !== undefined);
    if (content.length === 0) return [];

    const geo = computeTileGeometry(width, height);
    // GRID patches only. A global-tile token covers the whole frame — true, and
    // useless as a highlight — so it is excluded from the map rather than
    // dropped after the cap, where it silently cost a box.
    const gridCount = Math.min(gridTokenCount(geo), patches.length);
    if (gridCount === 0) return [];

    const score = new Float64Array(gridCount);
    let top = -Infinity;
    for (let p = 0; p < gridCount; p++) {
      let best = -Infinity;
      for (const q of content) best = Math.max(best, dot(q, patches[p]!));
      score[p] = best;
      if (best > top) top = best;
    }
    if (!Number.isFinite(top) || top <= this.minScore) return [];

    const floor = this.relativeFloor * top;
    // Cell key -> patch index, walked in index order so components and their
    // ids are discovered deterministically.
    const kept = new Map<string, number>();
    for (let p = 0; p < gridCount; p++) {
      if (score[p]! < floor) continue;
      const cell = patchIndexToCell(p, geo);
      if (cell) kept.set(`${cell.col},${cell.row}`, p);
    }

    const seen = new Set<string>();
    const hits: RegionHit[] = [];
    for (const [key, index] of kept) {
      if (seen.has(key)) continue;
      seen.add(key);
      const stack = [key];
      const members = [index];
      while (stack.length > 0) {
        const [col, row] = stack.pop()!.split(",").map(Number) as [number, number];
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nk = `${col + dc},${row + dr}`;
          const ni = kept.get(nk);
          if (ni === undefined || seen.has(nk)) continue;
          seen.add(nk);
          stack.push(nk);
          members.push(ni);
        }
      }

      const boxes = members.map((m) => cellToBox(patchIndexToCell(m, geo)!, geo));
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      const bestSim = Math.max(...members.map((m) => score[m]!));
      hits.push({
        // Synthetic: no `region` row backs a patch. AX-label FTS still
        // contributes real, labelled regions on the cloud path.
        regionId: `${frameId}#p${Math.min(...members)}`,
        frameId,
        bbox: {
          x,
          y,
          w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
          h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
        },
        role: null,
        label: null,
        matchedBy: ["ann"],
        distance: 1 - bestSim,
        strength: bestSim / top,
      });
    }

    return hits
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
      .slice(0, this.maxHighlights);
  }
```

Update the imports at the top of the file:

```ts
import type { MultiVectorProvider, QueryEmbedding } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import {
  cellToBox,
  computeTileGeometry,
  gridTokenCount,
  patchIndexToCell,
} from "../embed/onnx/geometry.js";
```

In `src/retrieve/assemble.ts`, `attachPatchHighlights` passes the embedding straight through:

```ts
      const patches = await this.tier2mv!.highlightsForFrame(
        f.frameId,
        queryVectors,
        frame.width,
        frame.height,
      );
```

with its parameter typed `queryVectors: QueryEmbedding`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tier2-mv.test.ts test/assemble.test.ts && npm run typecheck`
Expected: PASS. `assemble.test.ts`'s "attaches MaxSim highlights" may now return fewer boxes — if it asserts an exact count, relax it to `toBeGreaterThan(0)`; do NOT relax an assertion about WHICH frame ranks first.

- [ ] **Step 5: Commit**

```bash
git add src/retrieve/tier2-mv.ts src/retrieve/assemble.ts test/tier2-mv.test.ts test/assemble.test.ts
git commit -m "$(cat <<'EOF'
fix(highlights): score a content-only map, floor it, merge it

One argmax per query vector drew a box for [CLS], [SEP] and every buffer
token — 12 of 15 vectors for "probe mcp", with [CLS] ranking first at 0.992
over blank document space. Highlighting now scores each grid patch by
max-over-content-vectors, keeps what clears 0.8 of the frame's best, and
merges 4-connected survivors into one box each. The global tile leaves the
map up front instead of costing a slot after the cap.

Scoring is untouched: MaxSim still sees every query vector.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full suite and app typecheck green

A checkpoint task: the interface change reaches several suites that Task 3–5 touched only through the compiler.

**Files:**
- Modify: whatever the runs below name.
- Test: the whole suite.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing new.

- [ ] **Step 1: Run the full library gate**

Run: `npm run typecheck && npm test`
Expected: PASS. Fix any fixture that constructs a `RegionHit`/`HighlightDTO` without `strength` (the compiler names them) and any test that calls `embedQueries` and reads the array directly.

- [ ] **Step 2: Run the app gate**

Run: `npm run build && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 3: Confirm the guards still hold**

Run: `npx vitest run test/replay.barrel.test.ts test/mcp.readonly.test.ts`
Expected: PASS — nothing here may reach `replay/` or widen what the MCP reader can do.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test: carry strength and QueryEmbedding through the remaining fixtures

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `scripts/highlight-probe.mjs` and the calibration sweep

The floor shipped in Task 5 comes from ONE frame in ONE application. This task measures it properly and ships whatever it measures.

**Files:**
- Create: `scripts/highlight-probe.mjs`
- Modify: `package.json` (a `probe:highlight` script), `src/retrieve/tier2-mv.ts` (the two constants, if the sweep moves them), `CLAUDE.md` is Task 8
- Test: none — it is a probe, like `scripts/decimate-probe.mjs`

**Interfaces:**
- Consumes: `ColModernVBertMultiVector`/`ColSmolMultiVector` from `dist/`, `computeTileGeometry`/`patchIndexToCell`/`cellToBox`/`gridTokenCount` from `dist/`, the app's real data dir.
- Produces: a CLI that prints a sweep table and writes overlay PNGs.

- [ ] **Step 1: Write the probe**

Create `scripts/highlight-probe.mjs` with exactly this content. It calls the REAL `highlightsFrom` rather than reimplementing the rule — a probe that calibrates its own copy of the algorithm calibrates something the app does not run.

```js
#!/usr/bin/env node
/**
 * Read-only calibration for patch highlights: sweep the relative floor over
 * real frames and real queries, and write an overlay per setting so the
 * numbers can be LOOKED AT.
 *
 * Read-only by construction: it opens SQLite readonly, opens the Lance table
 * to read, reads keyframe blobs, and writes only PNGs under --out.
 *
 * The frame's own `answer` box (optional, in frame-space points) is what turns
 * this from a picture into a count: a box is a HIT if it overlaps it.
 *
 * Usage:
 *   npm run build
 *   npm run probe:highlight -- --frame <frameId> --query "probe mcp"
 *   npm run probe:highlight -- --set probe-queries.json
 *   npm run probe:highlight -- --set probe-queries.json --floors 0.6,0.7,0.8,0.9
 *
 * --set is a JSON array of { frameId, query, answer?: {x,y,w,h} }.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Tier2MultiVectorRetriever } from "../dist/retrieve/tier2-mv.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sharp = require("sharp");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DATA = arg("data", join(homedir(), "Library/Application Support/deskrag-app/DeskRAG"));
const OUT = arg("out", ".probe/highlights");
const FLOORS = arg("floors", "0.6,0.7,0.75,0.8,0.85,0.9").split(",").map(Number);
const cases = arg("set")
  ? JSON.parse(readFileSync(arg("set"), "utf8"))
  : [{ frameId: arg("frame"), query: arg("query") }];
if (!cases.length || !cases[0].frameId || !cases[0].query) {
  console.error("need --frame <id> --query <text>, or --set <file.json>");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const db = new Database(join(DATA, "app.db"), { readonly: true });
const settings = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
const which = settings.providers.imageProvider;
if (which !== "colsmol" && which !== "colmodernvbert") {
  console.error(`imageProvider is "${which}" — this probe needs a late-interaction provider`);
  process.exit(1);
}

const modelDir = join(
  settings.providers.localModels?.dir || join(DATA, "models"),
  which === "colsmol" ? "colSmol-256M-dynamic" : "colmodernvbert-250m",
);
const provider = await (async () => {
  if (which === "colsmol") {
    const { ColSmolMultiVector } = await import("../dist/embed/onnx/colsmol.js");
    return new ColSmolMultiVector({
      modelPath: join(modelDir, "model.onnx"),
      tokenizerPath: join(modelDir, "tokenizer.json"),
    });
  }
  const { ColModernVBertMultiVector } = await import("../dist/embed/onnx/colmodernvbert.js");
  return new ColModernVBertMultiVector({
    modelPath: join(modelDir, "model.onnx"),
    tokenizerPath: join(modelDir, "tokenizer.json"),
  });
})();

const ns = `frame_patches:${provider.id}:${provider.model}:${provider.dimensions}`;
const table = await (await lancedb.connect(join(DATA, "lance"))).openTable(
  ns.replace(/:/g, "__"),
);

const frameRow = db.prepare("SELECT width, height, blob_id FROM frame WHERE id = ?");
const blobRow = db.prepare("SELECT path FROM blob WHERE id = ?");
const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const c of cases) {
  const frame = frameRow.get(c.frameId);
  if (!frame) {
    console.error(`no frame ${c.frameId}`);
    continue;
  }
  const [row] = await table.query().where(`id = '${c.frameId}'`).limit(1).toArray();
  if (!row) {
    console.error(`no patches for ${c.frameId} in ${ns}`);
    continue;
  }
  const patches = [];
  for (let i = 0; i < row.patches.length; i++) patches.push(Float32Array.from(row.patches.get(i)));

  const [q] = await provider.embedQueries([c.query]);
  console.log(
    `\n${JSON.stringify(c.query)} on ${c.frameId} — ${frame.width}x${frame.height}, ` +
      `${patches.length} patches, ${q.contentIndices.length} of ${q.vectors.length} vectors are content`,
  );

  const jpeg = blobRow.get(frame.blob_id)?.path;
  for (const relativeFloor of FLOORS) {
    // The REAL rule, not a copy of it. `highlightsFrom` never touches the store.
    const hits = new Tier2MultiVectorRetriever({}, provider, { relativeFloor }).highlightsFrom(
      c.frameId,
      q,
      patches,
      frame.width,
      frame.height,
    );
    const hit = c.answer ? hits.filter((h) => overlaps(h.bbox, c.answer)).length : null;
    console.log(
      `  floor ${relativeFloor}: ${hits.length} boxes` +
        (hit === null ? "" : `, ${hit} on the answer, ${hits.length - hit} elsewhere`) +
        `  strengths ${hits.map((h) => h.strength.toFixed(2)).join(" ")}`,
    );

    if (!jpeg) continue;
    const W = 1280;
    const s = W / frame.width;
    const H = Math.round(frame.height * s);
    const rects = hits
      .map(
        (h) =>
          `<rect x="${h.bbox.x * s}" y="${h.bbox.y * s}" width="${h.bbox.w * s}" ` +
          `height="${h.bbox.h * s}" fill="rgba(255,194,75,${(0.3 * h.strength).toFixed(2)})" ` +
          `stroke="#ffc24b" stroke-width="2"/>`,
      )
      .join("");
    const name = `${c.frameId}-${c.query.replace(/\W+/g, "_")}-${relativeFloor}.png`;
    await sharp(jpeg)
      .resize(W, H)
      .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}">${rects}</svg>`), top: 0, left: 0 }])
      .png()
      .toFile(join(OUT, name));
  }
}
db.close();
console.log(`\noverlays in ${OUT}`);
```

- [ ] **Step 2: Wire the npm script**

In `package.json` `scripts`, beside the other probes:

```json
    "probe:highlight": "node scripts/highlight-probe.mjs",
```

- [ ] **Step 3: Run the sweep**

Run: `npm run build && npm run probe:highlight -- --floors 0.6,0.7,0.75,0.8,0.85,0.9`

Use at least **six frames across at least three applications** from the real library, each with a query whose answer is visible on the frame and an `answer` box measured off the keyframe. The anchor ladder was falsified twice by recording in one more app; a floor from one Obsidian frame is provisional in exactly the same way.

Two things the sweep must also REPORT, both spec-declared derived requirements that are not solved here:

- **An image query is a different regime.** Its 832 vectors are all content, so the map is a max over 832 similarities and this floor may not suit it. Run one case with `--query` replaced by an image (add `--image <path>` to the probe if you want the number; otherwise state plainly in the commit that it was not measured).
- **ColSmol is unmeasured.** Every number here comes from ColModernVBERT. If the machine has ColSmol weights, run the same sweep with `imageProvider: "colsmol"` and report whether the floor transfers; if not, say so rather than implying it was checked.

- [ ] **Step 4: Ship what was measured**

Update `DEFAULT_RELATIVE_FLOOR` and `DEFAULT_MIN_SCORE` in `src/retrieve/tier2-mv.ts` to the sweep's answer, and rewrite their comments to carry the real numbers, the corpus (how many frames, which applications) and the date. If the sweep confirms 0.8/0, say so with the evidence — a confirmed default still needs its measurement recorded.

Run: `npx vitest run test/tier2-mv.test.ts && npm run typecheck`
Expected: PASS (every test in that file passes an explicit floor, so a changed default cannot break them).

- [ ] **Step 5: Commit**

```bash
git add scripts/highlight-probe.mjs package.json src/retrieve/tier2-mv.ts
git commit -m "$(cat <<'EOF'
feat(probe): calibrate the highlight floor against the real library

scripts/highlight-probe.mjs sweeps the relative floor over real frames and
real queries and writes an overlay per setting. Read-only: it reads the store
and writes only PNGs. The shipped constants now carry the corpus they were
measured on rather than one frame's reading.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Verify in the real app, then record the invariant

The suite has no renderer and every existing highlight test used a fake whose query vectors were all content — which is exactly why this shipped. The last check is the app.

**Files:**
- Modify: `CLAUDE.md` (the Providers/adapters section and the retrieval section)
- Test: driving the app

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Drive the app**

Use the `run-app` skill. Launch the built app against the REAL data dir, run the reported query (`probe mcp`), open the frame at `00:00:38.098` in session `01KZZ3J82GHR…`, and screenshot the detail view.

Expected: boxes on the **`mcp` tab title**, **`probe:mcp` in the shell command** and the **`mcp` sidebar entry**; the boxes on blank document space gone or visibly faint; each box a wash rather than a solid outline; any AX-labelled region still drawn solid with its label.

- [ ] **Step 2: Check the other path did not change**

In Settings, note the configured image provider. With `imageProvider: "none"` (the DEFAULT configuration — test the one nobody runs), run a text query and confirm labelled AX region highlights still draw solid with labels, exactly as before.

- [ ] **Step 3: Record the invariant in CLAUDE.md**

Add to the providers/late-interaction section, in the file's voice — the fact and the measurement that produced it:

> **SCORING KEEPS EVERY QUERY VECTOR; HIGHLIGHTING KEEPS ONLY THE CONTENT ONES.** A ColPali-family query is the user's tokens plus ten `<end_of_utterance>` buffer slots, wrapped in `[CLS]`/`[SEP]` for ColModernVBERT. MaxSim needs all of them — the buffer slots are learned expansion slots. Highlighting must not: measured on a real frame, `"probe mcp"` is 15 vectors of which 12 are wrapper or buffer, and one box per query-vector argmax drew seven boxes of which four were noise — `[CLS]` scoring **0.992** against blank document space and therefore ranking FIRST. `QueryEmbedding.contentIndices` is how the provider (the only thing that knows the prompt layout) says which is which. The geometry was NOT the bug and was measured to be right: painting a 320x240 rect into a real keyframe and re-embedding put 16 of the 25 most-changed patches inside it.

- [ ] **Step 4: Run every gate one final time**

Run: `npm run typecheck && npm test && npm run build && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: record what a query vector is allowed to highlight

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the executor

- **The two probe scripts that found this bug are throwaway** and live in this session's scratchpad, not in the repo. `scripts/highlight-probe.mjs` (Task 7) is the one that ships, and it must import the real `highlightsFrom` rather than reimplementing it.
- **Do not "fix" `patchIndexToBox`.** It was measured correct. If a highlight looks misplaced after this work, re-run the painted-rect probe before touching geometry.
- **`test/onnx.smoke.test.ts` needs real weights** (`ONNX_SMOKE=1` + `DESKRAG_MODELS_DIR`) and is skipped otherwise — but it must still COMPILE after the `QueryEmbedding` change.
