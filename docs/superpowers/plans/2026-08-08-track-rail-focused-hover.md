# Track Rail Focused Hover Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Library track rail's hover card answer about the lane the cursor is on, instead of dumping all sixteen lanes at equal weight.

**Architecture:** `readoutAt` in `app/src/renderer/src/screens/track-view.ts` (pure, root-tested) gains an optional `focusLaneId` and splits its output into `focus` + `rows`. `TrackRail` learns the lane id from `e.target.closest(".tracks__lane")` — one existing mousemove, no per-lane listener — and renders three states from that one resolver. A `data-hovered` attribute on the lane row closes the loop between the card and the rail.

**Tech Stack:** TypeScript (strict, ESM), React 18, Vitest, plain global CSS (`app/src/renderer/src/styles.css` — one sheet, no modules).

**Spec:** `docs/superpowers/specs/2026-08-08-track-rail-focused-hover-design.md`

## Global Constraints

- **`track-view.ts` must stay `.ts`, never `.tsx`.** The root `tsconfig.json` sets no `jsx`, so a root test reaching into a `.tsx` — even only for a type — breaks `npm run typecheck`.
- **`track-view.ts` is a leaf.** It imports only from `@shared/types`. `keyframeLabel` stays INJECTED via `ReadoutOptions.label`; do not import it (`api.ts` evaluates `window.deskrag` at module scope and cannot be loaded by a root test).
- **Class names in `styles.css` are repo-wide identifiers.** There is one global sheet with no scoping. Grep for a base class before minting one.
- **No undefined CSS custom properties.** A `var(--x)` with no `--x:` declaration fails silently at computed-value time and falls back to `transparent`. Every token used below already exists in `:root`.
- **Use the spacing scale (`--s0..--s6`) and type scale (`--t-nano..--t-display`)**, never a raw `px` rhythm literal.
- **Two colour registers.** `--accent` is the INSTRUMENT register (selection/focus). `--data-*` is the DATA register (lane tones). Focus highlighting uses `--accent`; it must never borrow a lane tone.
- **Nothing in the rail truncates.** The card is the one stated exception (`.tracks__tip-value` already clamps to 3 lines). Context rows tighten that exception to 1 line; the focus row keeps 3. Do not add `text-overflow: ellipsis` anywhere.
- **Gates:** `npx vitest run test/track-view.test.ts` (Task 1), `npm run typecheck` + `npm --prefix app run typecheck` (every task).

## File Structure

| File | Change | Responsibility after |
|---|---|---|
| `app/src/renderer/src/screens/track-view.ts` | Modify (~line 303-376) | Pure resolution of every lane at an instant, now partitioned into `focus` + `rows`. Still the only place a lane's readout text is decided. |
| `test/track-view.test.ts` | Modify (~line 263-372) | Root-suite coverage of that partition, including the empty-focus case. |
| `app/src/renderer/src/screens/TrackLane.tsx` | Modify (line 25-74) | Publishes its lane id to the DOM (`data-lane`) and reflects focus (`data-hovered`). Decides nothing. |
| `app/src/renderer/src/screens/TrackRail.tsx` | Modify (line 64-68, 377-390, 247-253, 434-444, 461-531) | Detects the hovered lane, passes it to the resolver, renders the three card states. |
| `app/src/renderer/src/styles.css` | Modify (~line 1868, ~line 2184) | `.tracks__tip-focus`, the compact context grid, and the lane row's focus tint. |
| `CLAUDE.md` | Modify (track-rail section) | Records the superseded invariant. |

---

### Task 1: `readoutAt` partitions into focus and context

**Files:**
- Modify: `app/src/renderer/src/screens/track-view.ts:303-376`
- Test: `test/track-view.test.ts:263-372`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface Readout { timecode: string; focus: ReadoutRow | null; rows: ReadoutRow[] }`
  - `ReadoutOptions` gains `focusLaneId?: string | null`
  - `ReadoutRow` is unchanged: `{ laneId: string; title: string; text: string; tone: TrackTone | null }`

---

- [ ] **Step 1: Add a lane with an `emptyReason` to the test fixture**

The existing fixture (`test/track-view.test.ts:278-333`) has no empty lane, and Task 1 needs one to prove the empty-focus case. Insert this object as the **last** element of the `lanes` array, immediately after the `keyframes` lane (line 332's closing `},`) and before the closing `],`:

```ts
      {
        id: "scroll",
        group: "input",
        title: "scroll",
        shape: "density",
        showLabels: false,
        density: { values: new Array(10).fill(0), peak: 0, unit: "px/s" },
        emptyReason: "no scrolling recorded",
        warning: null,
      },
```

It is placed last and is empty, so `readoutAt` skips it and no existing assertion changes.

- [ ] **Step 2: Write the failing tests**

Append these five cases inside the existing `describe("readoutAt", ...)` block, after the last `it(...)` at line 371:

```ts
  it("extracts the focused lane and never repeats it in the rows", () => {
    const r = readoutAt(tracks, 2, { ...opts, focusLaneId: "apps" });
    expect(r.focus).toEqual({
      laneId: "apps",
      title: "apps",
      text: "TextEdit",
      tone: "app-1",
    });
    expect(r.rows.map((row) => row.laneId)).not.toContain("apps");
    expect(text(r, "typing")).toBe("4 keys/s");
  });

  // The no-lane state — a band header, or the space below the last lane — is
  // the function's DEFAULT, not a branch. That is what keeps this change
  // additive: every case above this one exercises it.
  it("without a focus lane reproduces the every-lane card", () => {
    const r = readoutAt(tracks, 2, opts);
    expect(r.focus).toBeNull();
    expect(r.rows.map((row) => row.laneId)).toEqual(["apps", "typing"]);
  });

  // Pointing at a lane and being answered about five OTHER lanes reads as a
  // broken card. The lane's own reason is the answer.
  it("answers about a focused lane that is empty, using the lane's own reason", () => {
    const r = readoutAt(tracks, 2, { ...opts, focusLaneId: "scroll" });
    expect(r.focus).toEqual({
      laneId: "scroll",
      title: "scroll",
      text: "no scrolling recorded",
      tone: null,
    });
    expect(r.rows.map((row) => row.laneId)).not.toContain("scroll");
  });

  it("answers about a focused lane with data elsewhere but none at the cursor", () => {
    const r = readoutAt(tracks, 7, { ...opts, focusLaneId: "apps" });
    expect(r.focus).toEqual({
      laneId: "apps",
      title: "apps",
      text: "nothing here",
      tone: null,
    });
  });

  it("treats an unknown focus lane as no focus at all", () => {
    const r = readoutAt(tracks, 2, { ...opts, focusLaneId: "no-such-lane" });
    expect(r.focus).toBeNull();
    expect(r.rows.map((row) => row.laneId)).toEqual(["apps", "typing"]);
  });
```

Why `sec = 2` and not `2.5`: at 2.5 the `markers` mark and the `keyframes` thumb both sit exactly `0.5` from the cursor, which is `<= tolSec` — so they appear, and the row-order assertions would need four ids. At 2.0 the gap is 1.0 and both are excluded, leaving `["apps", "typing"]`.

At `sec = 7` the `apps` span (`0`–`5`) has ended, which is the "data elsewhere, none here" case.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/track-view.test.ts -t "focus"`

Expected: the five new cases FAIL. `r.focus` is `undefined` (the property does not exist yet), so `expect(r.focus).toEqual({...})` and `expect(r.focus).toBeNull()` both fail, and `focusLaneId` is rejected by the compiler as an unknown property on `ReadoutOptions`.

- [ ] **Step 4: Extend the two exported types**

In `app/src/renderer/src/screens/track-view.ts`, replace the `Readout` interface (line 311-314) with:

```ts
export interface Readout {
  timecode: string;
  /**
   * The lane the cursor is on, resolved — the card's answer to the gesture.
   *
   * Null when the cursor is over NO lane (a band header, or the space below
   * the last lane). There is no pointing gesture there to honour, so the card
   * answers about everything, which is the card this focus block replaced.
   */
  focus: ReadoutRow | null;
  /** Every OTHER lane carrying a value, in rail order. Never contains `focus`. */
  rows: ReadoutRow[];
}
```

Then add this field to `ReadoutOptions`, after `label` (line 329):

```ts
  /**
   * The lane under the cursor, or null when it is over none.
   *
   * OMITTING IT IS THE DEFAULT, not a branch: it yields `focus: null` and the
   * full row list, so the no-lane state costs no second code path and every
   * caller that predates focusing is unchanged.
   *
   * A named lane ALWAYS produces a `focus` row, even where it carries nothing
   * at this instant. A card that answered about five other lanes and not the
   * one under the cursor reads as broken rather than as informative.
   */
  focusLaneId?: string | null;
```

- [ ] **Step 5: Extract the per-lane resolution into a helper**

The current `readoutAt` inlines four `if` branches that push straight into one array. Focus needs the same resolution to produce a value the caller can route, so lift it out. Insert this **above** `readoutAt` (after the `ReadoutOptions` interface):

```ts
/**
 * What a focused lane says when it says nothing.
 *
 * Distinct from an `emptyReason`, which is a property of the whole recording
 * ("no scrolling recorded"). This one is about the instant.
 */
const NOTHING_HERE = "nothing here";

/**
 * One lane resolved at one instant, or null where it has nothing to say.
 *
 * Lifted out of `readoutAt` so the SAME resolution serves both the focus row
 * and the context rows — two copies of these four branches is exactly how the
 * card would come to disagree with itself about what a lane says.
 */
function resolveLane(
  lane: TrackLaneDTO,
  sec: number,
  totalSec: number,
  { tolSec, label }: ReadoutOptions,
): ReadoutRow | null {
  if (lane.emptyReason !== null) return null;
  const row = (text: string, tone: TrackTone | null): ReadoutRow => ({
    laneId: lane.id,
    title: lane.title,
    text,
    tone,
  });
  if (lane.shape === "span") {
    const span = lane.spans?.find((s) => sec >= s.startSec && sec < s.endSec);
    return span ? row(span.label, span.tone) : null;
  }
  if (lane.shape === "density" && lane.density) {
    const text = densityReadout(lane.density, sec, totalSec);
    // No coverage is omitted entirely. Reporting it as 0 would assert silence
    // where nothing was recorded at all.
    return text === null ? null : row(text, null);
  }
  if (lane.shape === "mark") {
    const mark = nearest(lane.marks ?? [], (m) => m.atSec, sec, tolSec);
    return mark ? row(mark.label, mark.tone) : null;
  }
  if (lane.shape === "thumb") {
    const thumb = nearest(lane.thumbs ?? [], (t) => t.atSec, sec, tolSec);
    return thumb
      ? row(`${label(thumb.marker)} · ${thumb.regionCount} regions`, "accent")
      : null;
  }
  return null;
}
```

`TrackLaneDTO` and `TrackTone` are already imported at the top of the file (lines 15-16). No new import is needed.

- [ ] **Step 6: Rewrite `readoutAt` to route through the helper**

Replace the whole body of `readoutAt` (lines 346-376) — keep the doc comment above it for now, Step 7 replaces it:

```ts
export function readoutAt(
  tracks: SessionTracksDTO,
  sec: number,
  options: ReadoutOptions,
): Readout {
  const focusLaneId = options.focusLaneId ?? null;
  const rows: ReadoutRow[] = [];
  let focus: ReadoutRow | null = null;

  for (const lane of tracks.lanes) {
    const resolved = resolveLane(lane, sec, tracks.totalSec, options);
    if (focusLaneId !== null && lane.id === focusLaneId) {
      // A focused lane always answers. Where it resolved to nothing, the
      // lane's own reason is the answer; where it has no reason either, saying
      // so beats omitting the one row the cursor asked for.
      focus = resolved ?? {
        laneId: lane.id,
        title: lane.title,
        text: lane.emptyReason ?? NOTHING_HERE,
        tone: null,
      };
    } else if (resolved) {
      rows.push(resolved);
    }
  }

  return { timecode: timecodeShort(sec), focus, rows };
}
```

A `focusLaneId` matching no lane leaves `focus` null and touches nothing — the unknown-lane case falls out of the loop rather than needing a guard.

- [ ] **Step 7: Replace `readoutAt`'s doc comment**

The comment at lines 332-345 states the superseded rule. Replace it with:

```ts
/**
 * Every lane resolved at one instant, partitioned by what the cursor pointed at.
 *
 * ONE card for all lanes, never one per lane — the question is "what was
 * happening here", and asking it sixteen times is not the same question. But a
 * hover CARRIES AN ARGUMENT: the lane under the pointer. That lane becomes
 * `focus` and every other lane with a value becomes context, because a card
 * that returned sixteen equally-weighted rows put the answer — `Calculator` —
 * second in ~550px behind four near-identical VLM captions.
 *
 * EVERY lane is still resolved, including those in a collapsed band. Collapsing
 * is a choice about how much of the PLOT to show and must not silently cost
 * evidence; focusing is a pointing gesture and is answered as one. The two are
 * different acts, and the card now distinguishes them rather than flattening
 * both into a list.
 */
```

- [ ] **Step 8: Run the whole file's tests**

Run: `npx vitest run test/track-view.test.ts`

Expected: PASS, all cases — the five new ones plus the six pre-existing `readoutAt` cases untouched. If a pre-existing case fails, `resolveLane` has diverged from the branches it replaced; diff it against git history rather than adjusting the test.

- [ ] **Step 9: Typecheck both packages**

Run: `npm run typecheck && npm --prefix app run typecheck`

Expected: both clean. The app's `TrackRail.tsx` still compiles because `focus` is an added property and `focusLaneId` is optional.

- [ ] **Step 10: Commit**

```bash
git add app/src/renderer/src/screens/track-view.ts test/track-view.test.ts
git commit -m "feat(app): partition the rail readout into focus and context

readoutAt gains an optional focusLaneId and splits its output. Omitting
it reproduces today's every-lane card, so the no-lane state is the
default rather than a branch. A named lane always yields a focus row —
where it carries nothing at the cursor, its emptyReason is the answer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The card focuses the hovered lane

**Files:**
- Modify: `app/src/renderer/src/screens/TrackLane.tsx:55-56`
- Modify: `app/src/renderer/src/screens/TrackRail.tsx:64-68, 247-253, 377-390, 461-531`
- Modify: `app/src/renderer/src/styles.css` (insert after `.tracks__tip-rows`, ~line 2189)

**Interfaces:**
- Consumes: `readoutAt(tracks, sec, { tolSec, label, focusLaneId })` returning `{ timecode, focus, rows }` from Task 1.
- Produces: `interface Hover { sec: number; x: number; y: number; laneId: string | null }` in `TrackRail.tsx`, and the DOM contract `.tracks__lane[data-lane="<TrackLaneDTO.id>"]` that Task 3 also reads.

---

- [ ] **Step 1: Publish each lane's id to the DOM**

In `app/src/renderer/src/screens/TrackLane.tsx`, replace the opening tag at line 56:

```tsx
    <div className="tracks__lane" data-shape={lane.shape} data-empty={empty || undefined}>
```

with:

```tsx
    <div
      className="tracks__lane"
      // The rail's ONE mousemove reads this with `closest()`. Sixteen lanes
      // across four shapes would otherwise need sixteen more handlers, which is
      // sixteen more places for the hit rule to drift from the axis rule.
      data-lane={lane.id}
      data-shape={lane.shape}
      data-empty={empty || undefined}
    >
```

- [ ] **Step 2: Carry the hovered lane in `Hover`**

In `app/src/renderer/src/screens/TrackRail.tsx`, replace the `Hover` interface (lines 64-68):

```tsx
interface Hover {
  sec: number;
  x: number;
  y: number;
  /**
   * The lane under the cursor, or null over a band header or the space below
   * the last lane.
   *
   * Read with `closest()` from the event target, which is sound because
   * `.tracks__axis` — the box holding the playhead and crosshair, spanning
   * every lane — is already `pointer-events: none`. Without that the axis would
   * be the target everywhere and this would always be null.
   */
  laneId: string | null;
}
```

- [ ] **Step 3: Detect the lane in the existing mousemove**

In the same file, replace the `onMouseMove` body's first two lines (lines 379-381):

```tsx
          const sec = secAt(e.clientX);
          setHover(sec === null ? null : { sec, x: e.clientX, y: e.clientY });
```

with:

```tsx
          const sec = secAt(e.clientX);
          const laneId =
            (e.target as HTMLElement).closest<HTMLElement>(".tracks__lane")?.dataset.lane ??
            null;
          setHover(sec === null ? null : { sec, x: e.clientX, y: e.clientY, laneId });
```

- [ ] **Step 4: Pass it to the resolver**

Replace the `readout` memo (lines 247-253) with:

```tsx
  const readout = useMemo(() => {
    if (!tracks || !hover) return null;
    return readoutAt(tracks, hover.sec, {
      tolSec: axisWidth > 0 ? (HOVER_TOL_PX / axisWidth) * totalSec : 0,
      label: keyframeLabel,
      focusLaneId: hover.laneId,
    });
  }, [tracks, hover, axisWidth, totalSec]);
```

- [ ] **Step 5: Render the three states in `ReadoutCard`**

Replace `ReadoutCard`'s doc comment (lines 461-469) and its `return` (lines 505-530).

The comment becomes:

```tsx
/**
 * The card. Three states from ONE resolver, because they are one question asked
 * with different precision:
 *
 *  - over a lane            head + focus block + a divided context list
 *  - over a lane with
 *    nothing at the cursor  the same, with the lane's own reason as the answer
 *  - over no lane           head + every row at full weight (the original card)
 *
 * The third is not a third rendering: `focus` is null and `rows` holds
 * everything, so the same JSX produces it.
 *
 * Positioned `fixed` off the pointer rather than inside the rail, because the
 * rail is a clipped scroller and a card anchored inside it would be cut off at
 * exactly the lanes near its edges.
 */
```

And the render becomes:

```tsx
  if (readout.focus === null && readout.rows.length === 0) return null;
  return (
    <div
      className="tracks__tip"
      ref={cardRef}
      style={{
        left: pos?.left ?? hover.x + TIP_OFFSET,
        top: pos?.top ?? hover.y + TIP_OFFSET,
        // Hidden for the one frame between mount and measurement, so the card
        // never appears at an unclamped position and jumps.
        visibility: pos ? undefined : "hidden",
      }}
    >
      <div className="tracks__tip-head mono">{readout.timecode}</div>
      {readout.focus && (
        <div className="tracks__tip-focus">
          <span className="tracks__tip-title mono">{readout.focus.title}</span>
          <span className="tracks__tip-value" data-tone={readout.focus.tone ?? undefined}>
            {readout.focus.text}
          </span>
        </div>
      )}
      {readout.rows.length > 0 && (
        // `data-compact` is present only when something is focused above, so it
        // carries BOTH the divider and the demotion — the context list can only
        // be context when there is a focus for it to be context to.
        <div className="tracks__tip-rows" data-compact={readout.focus ? "" : undefined}>
          {readout.rows.map((row) => (
            <React.Fragment key={row.laneId}>
              <span className="tracks__tip-title mono">{row.title}</span>
              <span className="tracks__tip-value" data-tone={row.tone ?? undefined}>
                {row.text}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
```

The `useLayoutEffect` above it (lines 486-503) is unchanged: it already measures the real card and clamps it into the viewport, and this card is shorter than the ~550px it was built for.

- [ ] **Step 6: Style the focus block and the compact context list**

In `app/src/renderer/src/styles.css`, insert immediately after the `.tracks__tip-rows` rule (which ends at line 2189, before the `.tracks__tip-title` comment):

```css
/* The lane the cursor is on, answered in full. A hover CARRIES AN ARGUMENT —
   "this bar, here" — and the card that ignored it put `Calculator` second in
   ~550px behind four near-identical VLM captions. Two lines, so the title and
   its answer read as one statement rather than as a row in a table. */
.tracks__tip-focus {
  display: grid;
  gap: var(--s0);
  padding-bottom: var(--s2);
  font-size: var(--t-body);
}

/* Every OTHER lane, demoted. The divider lives here rather than under the focus
   block because this is the box that appears and disappears — a rule on the
   block above would leave a dangling line whenever nothing else is happening. */
.tracks__tip-rows[data-compact] {
  gap: var(--s0) var(--s2);
  padding-top: var(--s2);
  border-top: 1px solid var(--hairline-soft);
}

/* ONE line, and this is not a new exception to the rail's no-truncation rule.
   The card is already the stated exception — `.tracks__tip-value` clamps at
   three lines because the card is a glance and DetailView carries the record.
   The row the reader ASKED for is the one that keeps all three. */
.tracks__tip-rows[data-compact] .tracks__tip-value {
  -webkit-line-clamp: 1;
  color: var(--muted);
}
```

- [ ] **Step 7: Typecheck the app**

Run: `npm --prefix app run typecheck`

Expected: clean. If `dataset.lane` errors, `closest` was called without its `<HTMLElement>` type argument — `Element` has no `dataset`.

- [ ] **Step 8: Verify against a real recording**

Use the `run-app` skill to launch DeskRAGApp against the real data dir, open Library, select a recording, and hover the rail.

Confirm, by screenshot:
1. Hovering the **APPS** bar shows a card of a few rows, with `APPS` / `Calculator` at the top in full weight and the rest dimmed one-liners below a divider.
2. Hovering **KEYFRAMES** puts the frame's caption in the focus block at three lines and every other lane beneath it — the "show all the other tracks" case, with no special case in the code.
3. Hovering the **SCROLL** lane (empty on most recordings) shows `SCROLL` / `no scrolling recorded` as the focus, not an omitted row.
4. Hovering a **band header** (`▾ SCREEN`) or the space below MARKERS shows the original all-rows card with no divider.

Measure the card's height in states 1 and 4 with `getBoundingClientRect()` and record both numbers in the commit message. The suite cannot see a card's height, and the rail's per-bucket-rate bug and its 1px playhead were both found by driving the app.

- [ ] **Step 9: Commit**

```bash
git add app/src/renderer/src/screens/TrackLane.tsx \
        app/src/renderer/src/screens/TrackRail.tsx \
        app/src/renderer/src/styles.css
git commit -m "feat(app): the rail's hover card answers about the lane you point at

The rail's one mousemove discarded the pointer's vertical position, so
the card resolved sixteen lanes at equal weight. It now reads the lane
from `closest('.tracks__lane')` — sound because .tracks__axis is already
pointer-events:none — and renders a focus block plus a demoted context
list. Over no lane, focus is null and the original card is what renders.

Card height over a lane: <N>px, over a band header: <M>px.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Replace `<N>` and `<M>` with the numbers measured in Step 8. Do not commit with the placeholders.

---

### Task 3: The rail says which lane the card is about

**Files:**
- Modify: `app/src/renderer/src/screens/TrackLane.tsx:25-33, 48-74`
- Modify: `app/src/renderer/src/screens/TrackRail.tsx:434-444`
- Modify: `app/src/renderer/src/styles.css` (insert after `.tracks__lane[data-empty]`, ~line 1887)
- Modify: `CLAUDE.md` (the track-rail bullet beginning "**The hover card reports EVERY lane…**")

**Interfaces:**
- Consumes: `Hover.laneId` and `.tracks__lane[data-lane]` from Task 2.
- Produces: nothing later tasks depend on.

---

- [ ] **Step 1: Accept a `hovered` prop on the lane**

In `app/src/renderer/src/screens/TrackLane.tsx`, add to the `Props` interface after `axisWidth` (line 30):

```tsx
  /**
   * The cursor is on this lane, and the hover card is answering about it.
   *
   * Passed down rather than read from a `:hover` selector: the card's focus is
   * decided by `closest()` from ONE mousemove on the rail, and a CSS `:hover`
   * would be a second, independent rule for the same fact — free to disagree
   * with the card at exactly the lane boundaries where it matters.
   */
  hovered: boolean;
```

- [ ] **Step 2: Reflect it on the row**

In the same file, destructure it at line 49 — replace:

```tsx
  const { lane } = props;
```

with:

```tsx
  const { lane, hovered } = props;
```

and add the attribute to the opening `<div>` (the tag edited in Task 2 Step 1), after `data-empty`:

```tsx
      data-hovered={hovered || undefined}
```

`LaneBody` takes `Props` and ignores the new field; no change is needed there.

- [ ] **Step 3: Pass it from the rail**

In `app/src/renderer/src/screens/TrackRail.tsx`, replace the `<TrackLane .../>` element (lines 436-443):

```tsx
                    <TrackLane
                      key={lane.id}
                      lane={lane}
                      totalSec={totalSec}
                      axisWidth={axisWidth}
                      hovered={hover?.laneId === lane.id}
                      onSeek={player ? seek : null}
                      onInspect={onInspect}
                    />
```

`hover` is `Hover | null`, so `hover?.laneId` is `string | undefined` and never equals a lane id when the cursor is off the rail.

- [ ] **Step 4: Style it**

In `app/src/renderer/src/styles.css`, insert after the `.tracks__lane[data-empty]` rule (ends line 1887) and before `.tracks__lane:last-child`:

```css
/* Which lane the card is about.
   Without it the card names a lane and nothing on screen connects the name to
   a row — the reader has to read the card to discover what they are pointing
   at, which inverts the gesture. It also holds the focus visible during the
   vertical travel between lanes, where the card's contents change fastest.

   `--accent` and never a lane tone: this is the INSTRUMENT register
   (selection and focus), which the rail's two-register rule keeps above the
   OKLCH band every `--data-*` bar is drawn from. The wash matches the alpha
   `.axtree__row--selected` already uses, halved — a lane is 32px tall and a
   full-strength tint over one competes with the bars inside it. */
.tracks__lane[data-hovered] {
  background: rgba(124, 156, 255, 0.07);
}
.tracks__lane[data-hovered] .tracks__gutter {
  box-shadow: inset 2px 0 0 var(--accent);
  color: var(--text);
}
```

`box-shadow`, never a border or a margin: it paints outside the box, so the gutter keeps its exact width and the lane titles do not shift by 2px as the cursor moves down the rail — the same reason `.tracks__span` uses a ring.

- [ ] **Step 5: Typecheck the app**

Run: `npm --prefix app run typecheck`

Expected: clean. A missing `hovered` prop on the `<TrackLane>` call site is the failure to look for — it is required, deliberately, so the compiler finds every render site.

- [ ] **Step 6: Update the superseded invariant in CLAUDE.md**

In `CLAUDE.md`, find the bullet in the track-rail section that begins:

> **The hover card reports EVERY lane, including collapsed ones.** Collapsing
> chooses how much of the plot to show; it must not quietly drop evidence. Its
> position is MEASURED, not guessed: …

Replace the first two sentences (up to and including "must not quietly drop evidence.") with:

```
  - **The hover card ANSWERS THE LANE YOU POINTED AT, and reports the rest as
    context.** A hover carries an argument — "this bar, here" — and the card
    that ignored it put the answer (`Calculator`) second in a ~550px card
    behind four near-identical VLM captions. The lane under the cursor gets a
    focus block at full weight; every other lane with a value follows as a
    dimmed one-line row. Over a band header or the space below the last lane
    there is no gesture to honour, so every row renders at full weight — and
    that state is `readoutAt`'s DEFAULT (`focusLaneId` omitted), never a second
    code path. A focused lane ALWAYS answers, using its own `emptyReason` where
    it carries nothing at the cursor: a card that reported five other lanes and
    not the one being pointed at reads as broken. **Collapsed bands are still
    reported in full** — collapsing is a persistent choice about the plot and
    must not silently cost evidence, where focusing is a gesture; the card now
    distinguishes the two rather than flattening both into a list. The lane id
    reaches the card from ONE mousemove via `closest(".tracks__lane")`, which
    works only because `.tracks__axis` is `pointer-events: none`. Its
    position is MEASURED, not guessed: …
```

Keep the remainder of the original bullet (the `useLayoutEffect` clamping paragraph) intact.

- [ ] **Step 7: Verify the focus highlight on a real recording**

Use the `run-app` skill again. Hover slowly down the rail and confirm the tinted row plus the accent bar track the card's focus title exactly, including across a band header (where the tint must disappear and the card must go to all-rows).

- [ ] **Step 8: Run the full suite and both typechecks**

Run: `npm test && npm run typecheck && npm --prefix app run typecheck`

Expected: all green. `npm test` takes ~6s.

- [ ] **Step 9: Commit**

```bash
git add app/src/renderer/src/screens/TrackLane.tsx \
        app/src/renderer/src/screens/TrackRail.tsx \
        app/src/renderer/src/styles.css \
        CLAUDE.md
git commit -m "feat(app): mark the lane the rail's hover card is answering about

The card named a lane and nothing on screen connected the name to a row.
A data-hovered tint plus an accent bar in the gutter close the loop.
Passed as a prop, not a :hover selector — the focus is decided by one
mousemove and a second independent rule could disagree with it.

Records the superseded card invariant in CLAUDE.md.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage.** State 1 → Task 2 Steps 4-6. State 2 (`emptyReason` / `nothing here`) → Task 1 Steps 2, 6. State 3 (no lane) → Task 1 Step 6 (default) and Task 2 Step 5 (same JSX). Keyframes carve-out → falls out of state 1; verified in Task 2 Step 8.2. Lane-id detection → Task 2 Steps 1-3. `readoutAt` signature → Task 1 Steps 4-6. Rail highlight → Task 3 Steps 1-4. Truncation → Task 2 Step 6. CSS → Task 2 Step 6, Task 3 Step 4. Testing → Task 1 Steps 2-3, 8; Task 2 Step 8; Task 3 Steps 7-8. CLAUDE.md → Task 3 Step 6. Out-of-scope items (pinning, DTO changes, `session-tracks.ts`) appear in no task.
- **Type consistency.** `focusLaneId` is spelled identically in `ReadoutOptions` (Task 1 Step 4), the memo (Task 2 Step 4) and the tests. `Hover.laneId`, `data-lane`, `data-hovered`, `hovered` and `.tracks__tip-focus` / `[data-compact]` are each used with one spelling throughout.
- **No placeholders**, with one deliberate exception: `<N>` and `<M>` in Task 2 Step 9's commit message, which Step 8 measures and Step 9 states must not be committed unfilled.
