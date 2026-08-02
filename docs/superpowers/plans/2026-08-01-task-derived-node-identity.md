# Task-Derived Node Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a trace node's identity be what the task does next — plus a URL prefix for web scope — so replay can locate and verify against a real desktop instead of demanding a pixel-identical screen.

**Architecture:** Lift becomes three-phase (full observed predicates → edges → narrow each node to its identity set), because waits are derived from the full sets and identity is derived from the edges. `ax_exists` gains identifier keying so `AXIdentifier` reaches identity at all. Web scope arrives as a `url_change` **event**, the repo's established pattern for environment facts, because `ax_snapshot` has no column for it and there is no migration mechanism.

**Tech Stack:** TypeScript strict ESM, vitest, Swift (the `ax-dump` sidecar), macOS Accessibility APIs.

**Spec:** `docs/superpowers/specs/2026-08-01-task-derived-node-identity-design.md`

## Global Constraints

- **Task 1 is a GATE.** If `AXURL` is not readable in practice, **stop and report** — the spec says the web-scope option collapses and the design reopens. Do **not** silently fall back to a window title.
- **No schema changes and no migrations.** The repo runs `CREATE TABLE IF NOT EXISTS` on every open, so an existing table's shape can never change. `TraceNode.predicates` keeps its `Predicate[]` shape; the URL travels as an event.
- **AX roles carry no `AX` prefix in real data** (`ax-dump.swift` does `rawRole.dropFirst(2)`). Normalize on every comparison; write fixtures in the unprefixed shape. Matching the prefixed spelling has already shipped once and produced zero predicates from every recording.
- **A stale sidecar fails silently.** Run `npm run build:ax` after touching `native/`, and never assume a binary is current.
- **`src/trace/` is a leaf** — it may not import `store/`, `represent/`, or `retrieve/`. External data arrives through injected callbacks.
- **`grep` skips `src/store/store.ts`** (two deliberate NUL bytes). Use `grep -a` / `rg -a`.
- **Truncation defaults come from measurement, not from this plan.** Task 2's table is filled from the URLs gathered in Task 1.
- Gates: `npm run typecheck`, `npm test`, `npm --prefix app run typecheck`. Commit after every task. Work on a branch off `main`.

## File Structure

| File | Responsibility |
|---|---|
| `native/ax-dump.swift` (modify) | Read `AXURL` from the focused window's web area; emit it beside the elements |
| `src/capture/ax/types.ts` (modify) | `url?: string` on the parsed AX result |
| `src/capture/ax/swift.ts` (modify) | Parse the new field |
| `src/trace/url.ts` (create) | Pure URL → identity-prefix truncation. One responsibility, table-tested. |
| `src/trace/types.ts` (modify) | `url` predicate kind, tagged `assertable` |
| `src/trace/predicates.ts` (modify) | Identifier-keyed `ax_exists`; `url` predicate from context |
| `src/trace/identity-set.ts` (create) | `identityPredicates()` — the touched-set derivation. Separate from `predicates.ts` because it consumes edges, which predicate extraction must not know about. |
| `src/trace/lift.ts` (modify) | Three-phase lift; wait-predicate priority; `url_change` resolution |
| `src/capture/ax/boundary.ts` (modify) | Emit `url_change` when the URL changes |
| `src/replay/locate.ts` (modify) | The locate floor (weak nodes verify but never locate) |
| `src/replay/run.ts` (modify) | Prefer verifying `expected` over re-locating |
| `test/*.test.ts` (create) | One file per unit below |

---

### Task 1: Measure whether `AXURL` is readable — THE GATE

No identity code is written until this answers. The spec is explicit: if `AXURL` is absent the option collapses and the design reopens.

**Files:**
- Modify: `native/ax-dump.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `ax-dump` stdout gains a top-level `url` string when the focused window contains a web area; the JSON stays an object with `elements`.

- [ ] **Step 1: Read the current emit shape**

Run: `grep -n "func emit" -A 20 native/ax-dump.swift`
Note whether stdout is a bare array or an object. The steps below assume an object with an `elements` key; **if it is a bare array, wrap it and update `src/capture/ax/swift.ts` in the same task**, because the TS parser must not be left disagreeing with the binary.

- [ ] **Step 2: Add the web-area URL read**

In `native/ax-dump.swift`, above the final `emit(reader.elements)`:

```swift
/// The URL of the focused window's web area, when it has one.
///
/// Chromium and WebKit expose `AXURL` on the `AXWebArea` element. It is the
/// only semantic identity a page has: a title carries unread counts
/// ("(3) Inbox") and changes with content, while a URL does not.
///
/// Searched breadth-first from the window and capped, because a deep search of
/// a large page competes with the walk budget for no benefit — every browser
/// puts the web area within a few levels of the window.
func webAreaURL(_ window: AXUIElement) -> String? {
    var queue: [(AXUIElement, Int)] = [(window, 0)]
    var visited = 0
    while !queue.isEmpty, visited < 200 {
        let (el, depth) = queue.removeFirst()
        visited += 1
        if depth > 6 { continue }

        var roleValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleValue) == .success,
           let role = roleValue as? String, role == "AXWebArea" {
            var urlValue: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, "AXURL" as CFString, &urlValue) == .success {
                if let u = urlValue as? URL { return u.absoluteString }
                // Some implementations hand back a string rather than an NSURL.
                if let s = urlValue as? String, !s.isEmpty { return s }
            }
            return nil
        }

        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
           let kids = children as? [AXUIElement] {
            for k in kids { queue.append((k, depth + 1)) }
        }
    }
    return nil
}
```

- [ ] **Step 3: Emit it**

Capture the window in a variable so it can be reused, then pass the URL to `emit`. Replace the walk block's `reader.walk(win as! AXUIElement, rawDepth: 0, parent: nil)` so the element is retained, and change the final call to `emit(reader.elements, url: focusedWindowElement.flatMap(webAreaURL))`. Update `emit` to add `"url"` to its dictionary **only when non-nil**, so a native app's output is byte-identical to today's.

- [ ] **Step 4: Build**

Run: `npm run build:ax`
Expected: both binaries compile. A stale binary fails silently, so this is not optional.

- [ ] **Step 5: MEASURE — the gate**

Open, in turn, a Chrome window, a Safari window, and a native app (TextEdit). For each, make it frontmost and run:

```bash
sleep 3; ./native/ax-dump | head -c 300
```

Record for each: whether `url` appears, and its exact value. Also collect **at least six real URLs** across different sites (GitHub PR + repo home + issues, a Google Doc, an Amazon product, a docs site) — Task 2's truncation table is built from these and from nothing else.

- [ ] **Step 6: Gate decision**

- **`url` present for Chrome and Safari, absent for TextEdit** → proceed to Task 2.
- **Absent or unreliable** → **STOP.** Report the measurement, revert this task's Swift change, and say that the web-scope design must reopen. Do not substitute a window title.

- [ ] **Step 7: Commit**

```bash
git add native/ax-dump.swift
git commit -m "feat(ax): read the focused web area's AXURL

A page's only semantic identity. A title carries unread counts and
changes with content; a URL does not.

Emitted only when present, so a native app's output is unchanged."
```

---

### Task 2: URL → identity prefix

**Files:**
- Create: `src/trace/url.ts`
- Create: `test/url-prefix.test.ts`

**Interfaces:**
- Consumes: the real URLs measured in Task 1.
- Produces: `urlPrefix(raw: string): string | undefined` — e.g. `https://github.com/guyettinger/DeskRAG/pull/27` → `github.com/guyettinger/DeskRAG/pull`.

- [ ] **Step 1: Write the failing test**

Create `test/url-prefix.test.ts`. **Replace the sample rows with the URLs actually measured in Task 1** — these are illustrative of the rule, not a substitute for real data:

```ts
import { describe, expect, it } from "vitest";
import { urlPrefix } from "../src/trace/url.js";

describe("urlPrefix", () => {
  it("keeps host and non-identifier segments, dropping the id", () => {
    expect(urlPrefix("https://github.com/guyettinger/DeskRAG/pull/27")).toBe(
      "github.com/guyettinger/DeskRAG/pull",
    );
  });

  it("merges two pull requests in one repo, and separates two repos", () => {
    const a = urlPrefix("https://github.com/guyettinger/DeskRAG/pull/27");
    const b = urlPrefix("https://github.com/guyettinger/DeskRAG/pull/29");
    const c = urlPrefix("https://github.com/guyettinger/Other/pull/1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("drops a long opaque id, so one document class is one state", () => {
    expect(urlPrefix("https://docs.google.com/document/d/1A2b3C4d5E6f7G8h9I0j/edit")).toBe(
      "docs.google.com/document/d/edit",
    );
  });

  it("caps depth so a deep path cannot become a unique identity", () => {
    expect(urlPrefix("https://example.com/a/b/c/d/e/f")).toBe("example.com/a/b/c");
  });

  it("ignores query and fragment, which carry session state", () => {
    expect(urlPrefix("https://github.com/o/r?tab=readme#install")).toBe("github.com/o/r");
  });

  it("strips a leading www so one site is one identity", () => {
    expect(urlPrefix("https://www.example.com/a")).toBe("example.com/a");
  });

  it("returns undefined for anything that is not an http(s) URL", () => {
    // A file:// or chrome:// page is not a site, and about:blank is not a state.
    expect(urlPrefix("about:blank")).toBeUndefined();
    expect(urlPrefix("chrome://settings")).toBeUndefined();
    expect(urlPrefix("not a url")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/url-prefix.test.ts`
Expected: FAIL — cannot resolve `../src/trace/url.js`.

- [ ] **Step 3: Implement**

Create `src/trace/url.ts`:

```ts
/**
 * A URL reduced to the coarsest thing that still names a state.
 *
 * The grain is the SITE, not the page and not the tab. The repo already decided
 * a task should work on any document — dropping TextEdit's filename from
 * identity — and the web analogue is that it should work on any pull request.
 * A full URL is too strict for the same reason a filename was; a bare host is
 * too coarse, because two repositories are genuinely different states.
 *
 * Pure: no I/O, no clock.
 */

/** Segments that name an instance rather than a kind of page. */
const ID_PATTERNS: readonly RegExp[] = [
  /^\d+$/, //                                    27, 12345
  /^[0-9a-f]{8,}$/i, //                          a commit sha, a long hex id
  /^[0-9a-f-]{16,}$/i, //                        a UUID
  /^[A-Za-z0-9_-]{16,}$/, //                     an opaque document key
];

/**
 * Three is enough to separate `github.com/owner/repo/pull` from
 * `.../issues` while refusing to let a deep path become a unique identity.
 * Derived from the URLs measured in the sidecar task, not chosen a priori.
 */
const MAX_SEGMENTS = 3;

const isIdLike = (segment: string): boolean => ID_PATTERNS.some((re) => re.test(segment));

export function urlPrefix(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  // `file:`, `chrome:`, `about:` name no site, so they carry no web scope.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  const host = parsed.hostname.replace(/^www\./, "");
  if (host.length === 0) return undefined;

  // Query and fragment are session state — a tab index, a scroll anchor.
  const segments = parsed.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .filter((s) => !isIdLike(s))
    .slice(0, MAX_SEGMENTS);

  return [host, ...segments].join("/");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/url-prefix.test.ts`
Expected: PASS. If a row measured in Task 1 disagrees with `MAX_SEGMENTS` or `ID_PATTERNS`, **change the constant and say so in the commit** — the real URLs win over the numbers written here.

- [ ] **Step 5: Commit**

```bash
git add src/trace/url.ts test/url-prefix.test.ts
git commit -m "feat(trace): reduce a URL to the site-level identity

The grain is the site, not the page. A task should work on any pull
request for the same reason it should work on any document, so id-like
segments are dropped and the depth is capped."
```

---

### Task 3: The `url` predicate kind

**Files:**
- Modify: `src/trace/types.ts`
- Create: `test/predicates.url.test.ts`

**Interfaces:**
- Consumes: `urlPrefix` (Task 2).
- Produces: `PredicateKind` gains `"url"`; `REACH_BY_KIND.url === "assertable"`; `PredicateContext` gains `url?: string`; `extractPredicates` emits `{ kind: "url", args: { prefix }, reach: "assertable" }`.

- [ ] **Step 1: Write the failing test**

Create `test/predicates.url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractPredicates } from "../src/trace/predicates.js";
import { REACH_BY_KIND } from "../src/trace/types.js";

describe("url predicate", () => {
  it("is assertable — there is no navigation repair", () => {
    expect(REACH_BY_KIND.url).toBe("assertable");
  });

  it("is emitted as the reduced prefix, not the raw URL", () => {
    const preds = extractPredicates([], {
      app: "Google Chrome",
      url: "https://github.com/guyettinger/DeskRAG/pull/27",
    });
    const url = preds.find((p) => p.kind === "url");
    expect(url?.args["prefix"]).toBe("github.com/guyettinger/DeskRAG/pull");
  });

  it("emits nothing for a non-site URL", () => {
    const preds = extractPredicates([], { app: "Google Chrome", url: "about:blank" });
    expect(preds.some((p) => p.kind === "url")).toBe(false);
  });

  it("emits nothing when there is no URL at all", () => {
    const preds = extractPredicates([], { app: "TextEdit" });
    expect(preds.some((p) => p.kind === "url")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/predicates.url.test.ts`
Expected: FAIL — `REACH_BY_KIND.url` is undefined.

- [ ] **Step 3: Add the kind**

In `src/trace/types.ts`, add `| "url"` to `PredicateKind`, and to `REACH_BY_KIND`:

```ts
  /**
   * ASSERTABLE, deliberately. `app` is achievable because activation is a real
   * repair; there is no navigation mechanism, so a URL can only gate. Being on
   * the wrong site is therefore a clean, unoverridable blocker — which is
   * exactly the wrong-page replay this exists to prevent.
   */
  url: "assertable",
```

- [ ] **Step 4: Emit it**

In `src/trace/predicates.ts`, add `url?: string;` to `PredicateContext` with a comment that it is the RAW url and is reduced here, then in `extractPredicates` immediately after the `app` line:

```ts
  if (ctx.url !== undefined) {
    const prefix = urlPrefix(ctx.url);
    if (prefix !== undefined) add("url", { prefix });
  }
```

Import `urlPrefix` from `./url.js`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/predicates.url.test.ts && npm test`
Expected: PASS. The full suite matters here — `REACH_BY_KIND` is exhaustive over `PredicateKind`, so an omission is a type error rather than a silent gap.

- [ ] **Step 6: Commit**

```bash
git add src/trace/types.ts src/trace/predicates.ts test/predicates.url.test.ts
git commit -m "feat(trace): a url predicate, assertable and ungated

app is achievable because activation repairs it. Nothing navigates, so
a url can only gate — and being on the wrong site should be exactly an
unoverridable blocker."
```

---

### Task 4: Identifier-keyed `ax_exists`

Today `extractPredicates` keeps only elements with a non-empty **label**, so `AXIdentifier` — which `LAYER_CEILING` ranks at 1.0 against a label's 0.8 — never reaches identity. The measured failing run's own target, `TextArea #First Text View`, has an identifier and no label and contributes nothing.

**Files:**
- Modify: `src/trace/predicates.ts`
- Create: `test/predicates.identifier.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractPredicates` emits `ax_exists { role, identifier }` for elements carrying an `AXIdentifier`, and `ax_exists { role, label }` otherwise. `predicateKey` already distinguishes them, since it keys on sorted arg names.

- [ ] **Step 1: Write the failing test**

Create `test/predicates.identifier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractPredicates } from "../src/trace/predicates.js";
import type { UIElement } from "../src/embed/types.js";

// Roles WITHOUT the "AX" prefix — the shape ax-dump actually emits.
const el = (over: Partial<UIElement>): UIElement => ({
  role: "Button",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  ...over,
});

describe("identifier-keyed ax_exists", () => {
  it("emits an identifier-keyed predicate for a labelless element", () => {
    const preds = extractPredicates([el({ role: "TextArea", identifier: "First Text View" })]);
    expect(preds).toEqual([
      {
        kind: "ax_exists",
        args: { role: "TextArea", identifier: "First Text View" },
        reach: "achievable",
      },
    ]);
  });

  it("prefers the identifier when an element has both, emitting ONE predicate", () => {
    // Two predicates from one element would shift every count and cap.
    const preds = extractPredicates([el({ label: "Save", identifier: "save-btn" })]);
    expect(preds).toHaveLength(1);
    expect(preds[0]?.args).toEqual({ role: "Button", identifier: "save-btn" });
  });

  it("still emits a label-keyed predicate when there is no identifier", () => {
    const preds = extractPredicates([el({ label: "Save" })]);
    expect(preds[0]?.args).toEqual({ role: "Button", label: "Save" });
  });

  it("emits nothing for an element with neither", () => {
    expect(extractPredicates([el({})])).toEqual([]);
  });

  it("keeps an identifier even when the label is volatile", () => {
    // "Inbox (14)" is volatile; the identifier is not, so the element survives.
    const preds = extractPredicates([el({ label: "Inbox (14)", identifier: "inbox" })]);
    expect(preds[0]?.args).toEqual({ role: "Button", identifier: "inbox" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/predicates.identifier.test.ts`
Expected: FAIL — labelless elements currently produce nothing.

- [ ] **Step 3: Implement**

In `src/trace/predicates.ts`, replace `labelArgs` and the candidate filter. The filter currently requires a usable label; it must now accept an element with **either** key:

```ts
/**
 * The best available descriptor for an element, as predicate args.
 *
 * Identifier first, matching `LAYER_CEILING`: an `AXIdentifier` is app-assigned
 * and stable (ceiling 1.0) while a label is display text (0.8). Identity used
 * only labels, so the most reliable descriptor was invisible to it — the
 * measured failing node's own target had an identifier and no label.
 *
 * ONE predicate per element. Emitting both keys would double every count and
 * silently move the truncation cap.
 */
function descriptorArgs(e: UIElement): { role: string; identifier: string } | { role: string; label: string } | undefined {
  const role = canonicalRole(e.role);
  if (e.identifier !== undefined && e.identifier.length > 0) {
    return { role, identifier: e.identifier };
  }
  if (e.label !== undefined && e.label.length > 0 && !isVolatileLabel(e.label)) {
    return { role, label: e.label };
  }
  return undefined;
}
```

Change the candidate filter from `.filter((e) => e.label !== undefined && …)` to `.filter((e) => descriptorArgs(e) !== undefined)`, keep the existing sort, and inside the loop use `const args = descriptorArgs(e)!;` with `const key = \`${args.role} ${"identifier" in args ? args.identifier : args.label}\`;`.

`ax_focused` uses `descriptorArgs(focused)` too, and is skipped when it returns undefined.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/predicates.identifier.test.ts && npm test`
Expected: PASS. Existing predicate tests may need their expectations updated where a fixture element has both keys — that is the intended behaviour change, so update the fixture expectations rather than the rule.

- [ ] **Step 5: Commit**

```bash
git add src/trace/predicates.ts test/predicates.identifier.test.ts
git commit -m "feat(trace): key ax_exists by identifier where one exists

LAYER_CEILING ranks AXIdentifier at 1.0 and a label at 0.8, yet identity
was built from labels alone — so the strongest descriptor never reached
it. The measured failing node's own target is `TextArea #First Text
View`: an identifier, no label, contributing nothing.

One predicate per element: emitting both keys would double every count
and move the truncation cap without saying so."
```

---

### Task 5: The identity set

**Files:**
- Create: `src/trace/identity-set.ts`
- Create: `test/identity-set.test.ts`

**Interfaces:**
- Consumes: `predicateKey` from `./predicates.js`.
- Produces:

```ts
export interface IdentityInput {
  observed: readonly Predicate[];
  outgoing: readonly TraceEdge[];
  incoming: readonly TraceEdge[];
}
export function identityPredicates(input: IdentityInput): Predicate[];
export function isLocatable(predicates: readonly Predicate[]): boolean;
```

- [ ] **Step 1: Write the failing test**

Create `test/identity-set.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { identityPredicates, isLocatable } from "../src/trace/identity-set.js";
import type { Action, Anchor, Predicate, TraceEdge } from "../src/trace/types.js";

const p = (kind: Predicate["kind"], args: Predicate["args"]): Predicate => ({
  kind,
  args,
  reach: kind === "url" ? "assertable" : "achievable",
});

const anchor = (ax?: Anchor["ax"]): Anchor => ({
  point: { x: 1, y: 2, displayId: "d0" },
  ...(ax !== undefined ? { ax } : {}),
});

const edge = (id: string, actions: Action[]): TraceEdge => ({
  id,
  from: "n0",
  to: "n1",
  actions,
  provenance: "recorded",
  observations: 1,
  outcomes: { attempts: 0, successes: 0 },
});

const APP = p("app", { app: "Google Chrome" });
const URL = p("url", { prefix: "github.com/o/r/pull" });
const TOUCHED = p("ax_exists", { role: "Button", label: "Files changed" });
const PAGE = p("ax_exists", { role: "Button", label: "assign yourself" });

describe("identityPredicates", () => {
  it("keeps app and url, and drops untouched page content", () => {
    const out = identityPredicates({
      observed: [APP, URL, TOUCHED, PAGE],
      outgoing: [
        edge("e0", [
          { kind: "click", anchor: anchor({ role: "Button", label: "Files changed", path: "W[0]>B[1]" }), button: 0, count: 1 },
        ]),
      ],
      incoming: [],
    });
    expect(out).toContainEqual(APP);
    expect(out).toContainEqual(URL);
    expect(out).toContainEqual(TOUCHED);
    expect(out).not.toContainEqual(PAGE);
  });

  it("matches an anchor by identifier when it has one", () => {
    const byId = p("ax_exists", { role: "TextArea", identifier: "First Text View" });
    const out = identityPredicates({
      observed: [APP, byId, PAGE],
      outgoing: [
        edge("e0", [
          { kind: "click", anchor: anchor({ role: "TextArea", identifier: "First Text View", path: "W[0]>T[0]" }), button: 0, count: 1 },
        ]),
      ],
      incoming: [],
    });
    expect(out).toContainEqual(byId);
  });

  it("unions every outgoing edge, and both ends of a drag", () => {
    const a = p("ax_exists", { role: "Button", label: "A" });
    const b = p("ax_exists", { role: "Button", label: "B" });
    const out = identityPredicates({
      observed: [APP, a, b],
      outgoing: [
        edge("e0", [{ kind: "click", anchor: anchor({ role: "Button", label: "A", path: "x" }), button: 0, count: 1 }]),
        edge("e1", [
          {
            kind: "drag",
            from: anchor({ role: "Button", label: "B", path: "y" }),
            to: anchor({ role: "Button", label: "A", path: "x" }),
            path: { spans: [], durationMs: 1 } as unknown as Action extends { kind: "drag" } ? never : never,
            button: 0,
          } as unknown as Action,
        ]),
      ],
      incoming: [],
    });
    expect(out).toContainEqual(a);
    expect(out).toContainEqual(b);
  });

  it("keeps ax_focused when an outgoing edge types", () => {
    const focused = p("ax_focused", { role: "TextArea", identifier: "First Text View" });
    const out = identityPredicates({
      observed: [APP, focused, PAGE],
      outgoing: [edge("e0", [{ kind: "type", slot: "textarea", recorded: "hi" }])],
      incoming: [],
    });
    expect(out).toContainEqual(focused);
  });

  it("takes waits from the INCOMING edge, and only when they hold", () => {
    const holds = p("app", { app: "Google Chrome" });
    const stale = p("ax_exists", { role: "Button", label: "gone" });
    const out = identityPredicates({
      observed: [holds],
      outgoing: [],
      incoming: [
        edge("e0", [
          { kind: "wait", until: holds, timeoutMs: 1000 },
          { kind: "wait", until: stale, timeoutMs: 1000 },
        ]),
      ],
    });
    expect(out).toContainEqual(holds);
    expect(out).not.toContainEqual(stale);
  });

  it("ignores an outgoing edge's waits, which describe the NEXT state", () => {
    const next = p("app", { app: "TextEdit" });
    const out = identityPredicates({
      observed: [APP, next],
      outgoing: [edge("e0", [{ kind: "wait", until: next, timeoutMs: 1000 }])],
      incoming: [],
    });
    expect(out).not.toContainEqual(next);
  });

  it("emits nothing for an anchor that is path-only", () => {
    const out = identityPredicates({
      observed: [APP, PAGE],
      outgoing: [edge("e0", [{ kind: "click", anchor: anchor({ role: "Button", path: "W[0]>B[3]" }), button: 0, count: 1 }])],
      incoming: [],
    });
    expect(out).toEqual([APP]);
  });

  it("never emits duplicates", () => {
    const out = identityPredicates({
      observed: [APP, TOUCHED],
      outgoing: [
        edge("e0", [{ kind: "click", anchor: anchor({ role: "Button", label: "Files changed", path: "x" }), button: 0, count: 1 }]),
        edge("e1", [{ kind: "click", anchor: anchor({ role: "Button", label: "Files changed", path: "x" }), button: 0, count: 1 }]),
      ],
      incoming: [],
    });
    expect(out.filter((q) => q.kind === "ax_exists")).toHaveLength(1);
  });
});

describe("isLocatable", () => {
  it("rejects a set that is only app", () => {
    expect(isLocatable([APP])).toBe(false);
  });
  it("rejects an empty set", () => {
    expect(isLocatable([])).toBe(false);
  });
  it("accepts app plus anything else", () => {
    expect(isLocatable([APP, URL])).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/identity-set.test.ts`
Expected: FAIL — cannot resolve `../src/trace/identity-set.js`.

- [ ] **Step 3: Implement**

Create `src/trace/identity-set.ts`:

```ts
/**
 * A node's identity: what the task does next, not what happens to be on screen.
 *
 * A predicate set sized for MERGING (is this a new state?) was being reused for
 * LOCATING (am I here again?), and those pull opposite ways —
 * `DEFAULT_MAX_AX_PREDICATES` went 32 -> 64 to stop two GitHub pages merging
 * wrongly, which is the same move that made a node unlocatable. Deriving
 * identity from the task instead needs no cap and no page-vs-chrome heuristic:
 * content the recording never touched is excluded by construction.
 *
 * Lives apart from `predicates.ts` because it consumes EDGES, which predicate
 * extraction must not know about.
 *
 * Pure: no store, no clock, no I/O.
 */

import { predicateKey } from "./predicates.js";
import type { Anchor, Predicate, TraceEdge } from "./types.js";

export interface IdentityInput {
  /** Everything the tree yielded at this boundary. */
  observed: readonly Predicate[];
  /** Edges leaving this node — what the task can do from here. */
  outgoing: readonly TraceEdge[];
  /** Edges arriving — their waits assert what this state is. */
  incoming: readonly TraceEdge[];
}

/** Descriptor keys an anchor can offer, best first. Mirrors `LAYER_CEILING`. */
function anchorKeys(a: Anchor): string[] {
  const ax = a.ax;
  if (ax === undefined) return [];
  const role = ax.role.replace(/^AX/i, "");
  const keys: string[] = [];
  if (ax.identifier !== undefined && ax.identifier.length > 0) {
    keys.push(predicateKey({ kind: "ax_exists", args: { role, identifier: ax.identifier }, reach: "achievable" }));
  }
  if (ax.label !== undefined && ax.label.length > 0) {
    keys.push(predicateKey({ kind: "ax_exists", args: { role, label: ax.label }, reach: "achievable" }));
  }
  return keys;
}

function anchorsOf(edges: readonly TraceEdge[]): Anchor[] {
  const out: Anchor[] = [];
  for (const e of edges) {
    for (const a of e.actions) {
      switch (a.kind) {
        case "click":
        case "hover":
        case "scroll":
          out.push(a.anchor);
          break;
        case "drag":
          // Both ends: each is an element the task requires to exist here.
          out.push(a.from, a.to);
          break;
        default:
          break;
      }
    }
  }
  return out;
}

export function identityPredicates(input: IdentityInput): Predicate[] {
  const byKey = new Map(input.observed.map((p) => [predicateKey(p), p]));
  const out: Predicate[] = [];
  const taken = new Set<string>();
  const take = (key: string): void => {
    if (taken.has(key)) return;
    const p = byKey.get(key);
    if (p === undefined) return; // Not actually present in the observed tree.
    taken.add(key);
    out.push(p);
  };

  // `app` always. It is one predicate, cheap, and highly discriminating across
  // applications — though useless WITHIN one, which `isLocatable` accounts for.
  for (const p of input.observed) if (p.kind === "app") take(predicateKey(p));
  for (const p of input.observed) if (p.kind === "url") take(predicateKey(p));

  // What the task touches. The first key an anchor offers that is actually
  // present wins, so an identifier beats a label exactly as the ladder ranks.
  for (const a of anchorsOf(input.outgoing)) {
    for (const key of anchorKeys(a)) {
      if (byKey.has(key)) {
        take(key);
        break;
      }
    }
  }

  // Typing goes to whatever is focused, so focus is part of the state.
  if (input.outgoing.some((e) => e.actions.some((a) => a.kind === "type"))) {
    for (const p of input.observed) if (p.kind === "ax_focused") take(predicateKey(p));
  }

  // Waits from the INCOMING edge: a `wait until app(Chrome)` asserts something
  // about where the edge ARRIVES, so it describes this node. Reading them from
  // the outgoing edge would attach the next state's assertion to this one — the
  // same off-by-one that made boundary snapshots describe the previous app.
  // Filtered by the observation, which is also what drops a wait describing a
  // transient mid-edge condition rather than the arrival.
  for (const e of input.incoming) {
    for (const a of e.actions) {
      if (a.kind === "wait") take(predicateKey(a.until));
    }
  }

  return out;
}

/**
 * Can this node answer "which state am I in?".
 *
 * `app` is shared by every node in an application, so it has zero discriminating
 * power for the question LOCATING asks — while being a perfectly good answer to
 * the question VERIFYING asks ("did I reach Chrome?"). Stated as a rule rather
 * than a tunable count, because a count invites tuning.
 */
export function isLocatable(predicates: readonly Predicate[]): boolean {
  return predicates.some((p) => p.kind !== "app");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/identity-set.test.ts`
Expected: PASS. If the drag test's `Path` cast is awkward, build a real `Path` via the helpers in `src/trace/paths.ts` rather than casting — a cast that hides a shape change is worse than a longer fixture.

- [ ] **Step 5: Commit**

```bash
git add src/trace/identity-set.ts test/identity-set.test.ts
git commit -m "feat(trace): derive node identity from what the task touches

Content the recording never touched is excluded by construction, so no
page-vs-chrome heuristic is needed — which is the heuristic the symptom
seemed to demand.

Waits come from the INCOMING edge: they assert where an edge arrives, so
they describe the destination. Reading them from the outgoing edge is
the same off-by-one that made boundary snapshots describe the previous
application."
```

---

### Task 6: Three-phase lift

`buildNode` runs before edges exist, and `newlyTruePredicate` derives waits FROM the full node predicates — so identity, which is derived from edges, cannot be computed in `buildNode`.

**Files:**
- Modify: `src/trace/lift.ts`
- Create: `test/lift.identity.test.ts`

**Interfaces:**
- Consumes: `identityPredicates` (Task 5).
- Produces: `liftTrace` returns nodes whose `predicates` are the identity set; `newlyTruePredicate` prefers state-level predicates.

- [ ] **Step 1: Write the failing test**

Create `test/lift.identity.test.ts`. Build a two-boundary session with a click on a labelled button, an `axAt` returning that button **plus** an untouched page control, and assert the untouched one is absent:

```ts
import { describe, expect, it } from "vitest";
import { liftTrace } from "../src/trace/lift.js";
import type { TraceEvent } from "../src/trace/types.js";
import type { UIElement } from "../src/embed/types.js";

const el = (over: Partial<UIElement>): UIElement => ({ role: "Button", x: 0, y: 0, w: 10, h: 10, ...over });

const TREE: UIElement[] = [
  el({ role: "Button", label: "Files changed" }),
  el({ role: "Button", label: "assign yourself" }),
];

const events: TraceEvent[] = [
  { tMono: 0, kind: "focus_change", data: { app: "Google Chrome", title: "PR" } },
  { tMono: 10, kind: "mouse_down", data: { x: 5, y: 5, button: 0 } },
  { tMono: 60, kind: "mouse_up", data: { x: 5, y: 5, button: 0 } },
  { tMono: 5000, kind: "session_end", data: {} },
];

describe("lift produces task-derived identity", () => {
  it("keeps the touched control and drops untouched page content", () => {
    const trace = liftTrace({
      sessionId: "s1",
      events,
      endTMono: 5000,
      axAt: () => ({ elements: TREE }),
    });
    const labels = trace.nodes.flatMap((n) =>
      n.predicates.filter((p) => p.kind === "ax_exists").map((p) => String(p.args["label"] ?? p.args["identifier"])),
    );
    expect(labels).not.toContain("assign yourself");
    expect(trace.nodes.every((n) => n.predicates.some((p) => p.kind === "app"))).toBe(true);
  });

  it("keeps every node's predicate count far below the observed tree's", () => {
    const trace = liftTrace({
      sessionId: "s1",
      events,
      endTMono: 5000,
      axAt: () => ({ elements: TREE }),
    });
    for (const n of trace.nodes) expect(n.predicates.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/lift.identity.test.ts`
Expected: FAIL — `assign yourself` is present, because nodes still carry the full observed set.

- [ ] **Step 3: Narrow the nodes after the edges are built**

In `src/trace/lift.ts`, immediately before the `return { sessionId… }`, add the third phase:

```ts
  // PHASE 3. Nodes were built with the full observed set because `buildNode`
  // runs before any edge exists AND `newlyTruePredicate` derives waits from
  // those full sets. Identity is derived from the edges, so it can only be
  // computed once they exist — narrowing here rather than earlier is a sequence
  // requirement, not a preference.
  const outgoingBy = new Map<string, TraceEdge[]>();
  const incomingBy = new Map<string, TraceEdge[]>();
  const push = (m: Map<string, TraceEdge[]>, key: string, e: TraceEdge): void => {
    const list = m.get(key);
    if (list === undefined) m.set(key, [e]);
    else list.push(e);
  };
  for (const e of edges) {
    push(outgoingBy, e.from, e);
    push(incomingBy, e.to, e);
  }
  for (const n of nodes) {
    n.predicates = identityPredicates({
      observed: n.predicates,
      outgoing: outgoingBy.get(n.id) ?? [],
      incoming: incomingBy.get(n.id) ?? [],
    });
  }
```

Import `identityPredicates` from `./identity-set.js` and `TraceEdge` from `./types.js` if not already imported.

- [ ] **Step 4: Make wait selection prefer state-level predicates**

`newlyTruePredicate` returns the FIRST newly-true predicate, which on a browser edge is likely a page control — and since incoming waits become identity, that would smuggle page content straight back in. Replace its body:

```ts
function newlyTruePredicate(before: TraceNode, after: TraceNode): Predicate | undefined {
  const had = new Set(before.predicates.map(predicateKey));
  const fresh = after.predicates.filter((p) => !had.has(predicateKey(p)));
  // Ranked, not first-wins. A wait on `app(Chrome)` describes an arrival; a wait
  // on `ax_exists(label="Reviewers")` describes one page's furniture — and
  // because an incoming edge's waits become the destination's identity, picking
  // the wrong one reintroduces exactly the page content this design removes.
  const rank = (p: Predicate): number =>
    p.kind === "app" ? 0 : p.kind === "url" ? 1 : p.kind === "ax_focused" ? 2 : 3;
  const best = [...fresh].sort((a, b) => rank(a) - rank(b))[0];
  if (best !== undefined) return best;
  return after.predicates.find((p) => p.kind === "ax_focused");
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/lift.identity.test.ts && npm test`
Expected: PASS. Existing lift tests asserting predicate counts will need updating — that is this task's whole point, so update expectations to the identity set rather than relaxing the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/trace/lift.ts test/lift.identity.test.ts
git commit -m "feat(trace): narrow nodes to their identity after edges exist

Three-phase by necessity: buildNode runs before any edge, and
newlyTruePredicate derives waits from the full observed sets, so
identity — which is derived from edges — can only be computed last.

Wait selection is ranked rather than first-wins. On a browser edge the
first newly-true predicate is likely page furniture, and since an
incoming edge's waits become the destination's identity, that would
smuggle back exactly what this removes."
```

---

### Task 7: Carry the URL into the trace

`ax_snapshot` has no `url` column and the repo has no migration mechanism, so the URL travels as an **event** — the established pattern for environment facts that change mid-session and fail silently (`display_change`, `keymap_change`).

**Files:**
- Modify: `src/capture/ax/types.ts`, `src/capture/ax/swift.ts`, `src/capture/ax/boundary.ts`
- Modify: `src/trace/lift.ts`
- Create: `test/capture.url-event.test.ts`

**Interfaces:**
- Consumes: `ax-dump`'s `url` field (Task 1).
- Produces: a `url_change` event `{ kind: "url_change", data: { url } }`; `focusContext` in `lift.ts` resolves the latest at-or-before into `PredicateContext.url`.

- [ ] **Step 1: Write the failing test**

Create `test/capture.url-event.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { liftTrace } from "../src/trace/lift.js";
import type { TraceEvent } from "../src/trace/types.js";

describe("url_change events reach node identity", () => {
  it("resolves the latest url at-or-before the boundary", () => {
    const events: TraceEvent[] = [
      { tMono: 0, kind: "focus_change", data: { app: "Google Chrome", title: "PR" } },
      { tMono: 1, kind: "url_change", data: { url: "https://github.com/o/r/pull/27" } },
      { tMono: 10, kind: "mouse_down", data: { x: 5, y: 5, button: 0 } },
      { tMono: 60, kind: "mouse_up", data: { x: 5, y: 5, button: 0 } },
      { tMono: 5000, kind: "session_end", data: {} },
    ];
    const trace = liftTrace({ sessionId: "s", events, endTMono: 5000, axAt: () => ({ elements: [] }) });
    const urls = trace.nodes.flatMap((n) => n.predicates.filter((p) => p.kind === "url"));
    expect(urls[0]?.args["prefix"]).toBe("github.com/o/r/pull");
  });

  it("carries no url predicate when no url_change was recorded", () => {
    const events: TraceEvent[] = [
      { tMono: 0, kind: "focus_change", data: { app: "TextEdit", title: "Untitled" } },
      { tMono: 5000, kind: "session_end", data: {} },
    ];
    const trace = liftTrace({ sessionId: "s", events, endTMono: 5000, axAt: () => ({ elements: [] }) });
    expect(trace.nodes.every((n) => !n.predicates.some((p) => p.kind === "url"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/capture.url-event.test.ts`
Expected: FAIL — no `url` predicate is produced.

- [ ] **Step 3: Resolve the url at lift time**

In `src/trace/lift.ts`, extend `focusContext` so it also tracks `url_change`. Note that `focus_change` currently **replaces** the whole context; the url must survive a focus change, so accumulate rather than replace:

```ts
function focusContext(tMono: number, events: readonly TraceEvent[]): PredicateContext {
  let app: string | undefined;
  let windowTitle: string | undefined;
  let url: string | undefined;
  for (const e of events) {
    if (e.tMono > tMono) break;
    const d = e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
    if (e.kind === "focus_change") {
      app = typeof d.app === "string" ? d.app : undefined;
      windowTitle = typeof d.title === "string" ? d.title : undefined;
      // A focus change to a different app invalidates the page you were on.
      url = undefined;
    } else if (e.kind === "url_change" && typeof d.url === "string") {
      url = d.url;
    }
  }
  return {
    ...(app !== undefined ? { app } : {}),
    ...(windowTitle !== undefined ? { windowTitle } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}
```

- [ ] **Step 4: Emit the event at capture time**

Add `url?: string` to the parsed AX result in `src/capture/ax/types.ts`, parse it in `src/capture/ax/swift.ts`, and in `src/capture/ax/boundary.ts` — which already walks the tree at each boundary — emit when it differs from the last seen:

```ts
    // A URL is an environment fact that changes mid-session and fails silently
    // when it does, like display topology and keyboard layout. It rides the
    // boundary walk rather than its own poller: a spawn every 500ms to learn
    // something that only matters at a boundary is not worth the cost.
    if (result.url !== undefined && result.url !== this.lastUrl) {
      this.lastUrl = result.url;
      this.ctx.emit({ kind: "url_change", tMono, data: { url: result.url } });
    }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/capture.url-event.test.ts && npm test && npm run build:ax`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/capture/ax src/trace/lift.ts test/capture.url-event.test.ts
git commit -m "feat(capture): record the page URL as an event

ax_snapshot has no column for it and the repo has no migration
mechanism, so it travels the way display topology and keyboard layout
already do — an event, resolved latest-at-or-before.

It rides the boundary walk rather than its own poller: a spawn every
500ms to learn something that only matters at a boundary is not worth
the cost. A focus change clears it, because the page you were on does
not survive switching application."
```

---

### Task 8: The locate floor

**Files:**
- Modify: `src/replay/locate.ts`
- Create: `test/locate.weak.test.ts`

**Interfaces:**
- Consumes: `isLocatable` (Task 5).
- Produces: `locateNode` never returns a node whose identity is only `app`.

- [ ] **Step 1: Write the failing test**

Create `test/locate.weak.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { locateNode } from "../src/replay/locate.js";
import { verifyNode } from "../src/replay/verify.js";
import type { Predicate } from "../src/replay/types.js";
import type { TraceNode } from "../src/trace/types.js";

const app = (name: string): Predicate => ({ kind: "app", args: { app: name }, reach: "achievable" });
const exists = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "Button", label },
  reach: "achievable",
});
const node = (id: string, predicates: Predicate[]): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

describe("weak nodes", () => {
  const weak = node("n3", [app("Google Chrome")]);

  it("verifies — 'did I reach Chrome?' is a real question", () => {
    expect(verifyNode(weak.predicates, [app("Google Chrome"), exists("anything")]).satisfied).toBe(true);
  });

  it("is never a locate candidate, however well it matches", () => {
    const located = locateNode([app("Google Chrome"), exists("anything")], [weak]);
    expect(located.nodeId).toBeUndefined();
    expect(located.candidates).toBe(0);
  });

  it("does not block a locatable node in the same app", () => {
    const strong = node("n4", [app("Google Chrome"), exists("Files changed")]);
    const located = locateNode([app("Google Chrome"), exists("Files changed")], [weak, strong]);
    expect(located.nodeId).toBe("n4");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/locate.weak.test.ts`
Expected: FAIL — the weak node is currently returned.

- [ ] **Step 3: Implement**

In `src/replay/locate.ts`, extend the existing exclusion. It already drops zero-predicate nodes; the reason generalizes:

```ts
  // A node with NO predicates is vacuously satisfied by every observation, and a
  // node carrying ONLY `app` is nearly as weak: `app` is shared by every node in
  // an application, so it has zero discriminating power for the question this
  // function asks. Both still VERIFY — "did I reach Chrome?" has a real answer —
  // which is why the rule lives here and not in `verifyNode`.
  const candidates = nodes.filter(
    (n) => isLocatable(n.predicates) && verifyNode(n.predicates, observed).satisfied,
  );
```

Import `isLocatable` from `../trace/identity-set.js`. This keeps `replay/`'s dependency direction intact — it already imports from `trace/`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/locate.weak.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/replay/locate.ts test/locate.weak.test.ts
git commit -m "feat(replay): a node that only names an app cannot locate

The zero-predicate exclusion generalizes: `app` is shared by every node
in an application, so it cannot answer 'which state is this?'. It
answers 'did I arrive?' perfectly well, which is why verifyNode is
unchanged."
```

---

### Task 9: Prefer the expected node

Verify-only alone trades one failure for another: `executeRun` re-locates every turn, so a weak node that now verifies still fails the next turn with `not-located`, and continuation past a cut stays broken.

**Files:**
- Modify: `src/replay/run.ts`
- Create: `test/run.expected.test.ts`

**Interfaces:**
- Consumes: `verifyNode`, `isLocatable`.
- Produces: `executeRun` adopts `expected` when it verifies, and falls back to `locateNode` otherwise.

- [ ] **Step 1: Write the failing test**

Create `test/run.expected.test.ts`. Drive `executeRun` with a fake `Actuator` (the suite is structurally incapable of posting a real event, and `test/replay.execute.test.ts` already has a fake worth copying) whose second `dump()` returns an observation matching only a `{app}` node, and assert the run continues rather than stopping at `not-located`.

```ts
import { describe, expect, it } from "vitest";
import { executeRun } from "../src/replay/run.js";
// Copy the fake Actuator from test/replay.execute.test.ts rather than importing
// it — that file's fake is shaped for its own assertions and coupling the two
// makes both harder to change.

describe("continuation", () => {
  it("adopts the expected node when it verifies, without locating", async () => {
    // Build a two-edge graph whose middle node carries only `app`, plan a run
    // that cuts after the first edge, and assert `segments.length === 2`.
    // The middle node is NOT locatable, so this passes only via `expected`.
    // ... assemble graph + fake actuator, then:
    // const out = await executeRun({ …, arm: async () => true });
    // expect(out.segments).toHaveLength(2);
    // expect(out.stopped).toBeUndefined();
  });

  it("falls back to locating when the expected node does not verify", async () => {
    // Same graph, but the second dump returns an observation the expected node
    // does not satisfy. The run must locate normally and report drift.
  });
});
```

**Fill both test bodies in before implementing** — the sketch above names the assertions, and the graph fixture follows the shape used in `test/replay.locate.test.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/run.expected.test.ts`
Expected: FAIL — the run stops at `not-located`.

- [ ] **Step 3: Implement**

In `src/replay/run.ts`, replace the locate call inside the loop:

```ts
    // Prefer the node the previous segment said it would reach. `expected` was
    // already being tracked for drift reporting; using it here is what makes
    // continuation work for a node whose identity is too thin to locate — the
    // common case for an edge whose only anchor is a coordinate.
    //
    // A cold start has no prior and must locate. Mid-run there is one, and
    // verifying a specific claim is a strictly easier question than choosing
    // among all recorded states.
    const expectedNode =
      expected === undefined ? undefined : input.graph.nodes.find((n) => n.id === expected);
    const currentId =
      expectedNode !== undefined && verifyNode(expectedNode.predicates, observed).satisfied
        ? expectedNode.id
        : locateNode(observed, input.graph.nodes).nodeId;
    if (currentId === undefined) return stop("not-located");
```

Then use `currentId` everywhere `located.nodeId` was used, and leave the drift comparison as it is — it already compares `expected` against whatever was actually adopted, so an adopted `expected` correctly reports no drift. Import `verifyNode` from `./verify.js`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/run.expected.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/replay/run.ts test/run.expected.test.ts
git commit -m "feat(replay): prefer verifying the expected node over locating

`expected` was already tracked and used only to report drift. Verifying
a specific claim is a strictly easier question than choosing among all
recorded states, and it is what lets a run continue past a cut into a
node whose only anchor is a coordinate.

A cold start still locates: there is no prior to prefer."
```

---

### Task 10: Validate against real recordings, then a real run

The repo's standing rule, and the only gate that can reach what this changes. Both of this repo's worst bugs were invisible to `npm test` and obvious within minutes of driving a real session.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-08-01-task-derived-node-identity-design.md`

- [ ] **Step 1: Re-lift the existing recordings**

Build (`npm run build`), launch the app (`npm run app:dev`), and use the Library's rebuild action. Record: node count, edge count, and **per-node predicate counts before and after**. The failing node previously carried 34; state what it carries now.

- [ ] **Step 2: Check the specific failure is gone**

Open Replay, switch to Chrome, and read the nearest-states panel. The Chrome node should now show `held == total`, where before it was missing 18. If it does not, stop and diagnose — the panel names exactly which predicates fail.

- [ ] **Step 3: Record a fresh cross-app session**

TextEdit → Chrome, a few deliberate clicks with pauses, ending on a page. This one has `url_change` events, which no existing recording does.

- [ ] **Step 4: Drive the full armed run**

Plan, review, arm. Watch for the thing this whole plan exists to produce: **a second segment**. The previous run stopped after segment 1 at boundary verification; a second review appearing is the first evidence that progressive resolution works end to end.

- [ ] **Step 5: Check the merge side did not regress**

Record the same task twice on two different pages of the same site, and confirm they **merge** (that is the intent). Then record it on a different site and confirm they do **not** — that is what the URL predicate is for, and it is the claim most likely to be wrong.

- [ ] **Step 6: Record the findings**

Add a "What changed, measured" section to the spec with the real before/after numbers. Update `CLAUDE.md`: the identity rule, the `assertable` URL predicate, the locate floor, and the `expected` preference. Correct anything the run falsified — a measurement from one pair of applications is provisional, exactly as the anchor ladder's was.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/
git commit -m "docs: what task-derived identity actually measured

Before/after predicate counts from re-lifting real recordings, and
whether a second segment finally ran."
```

---

## Self-Review

**Spec coverage:** identity rule → Tasks 5–6; identifier keying → Task 4; URL prefix → Tasks 1–3, 7; `assertable`, no override → Task 3; weak nodes verify-not-locate → Tasks 5, 8; continuation via `expected` → Task 9; outgoing-is-a-union and drag-both-ends → Task 5; waits from the incoming edge, filtered by observation → Task 5; no migration → Task 7 (event, not column) and Task 6 (shape unchanged); rebuild path → Task 10; testing → each task.

**Two things this plan discovered that the spec did not state, both now load-bearing:**
- **Lift must be three-phase.** `buildNode` precedes edges *and* `newlyTruePredicate` derives waits from the full observed sets, so identity cannot be computed where predicates are. Task 6.
- **Wait selection had to change.** `newlyTruePredicate` returns the first newly-true predicate; on a browser edge that is likely page furniture, and since incoming waits become identity it would smuggle back exactly what the design removes. Task 6, Step 4.

**Known soft spot:** Task 9's test bodies are sketched with named assertions rather than written out, because the fake `Actuator` fixture must be copied from `test/replay.execute.test.ts` and adapted. That is the one place an implementer has to write test code from a description — flagged rather than hidden.

**Type consistency:** `identityPredicates(IdentityInput): Predicate[]` and `isLocatable(readonly Predicate[]): boolean` are used under those exact names in Tasks 6 and 8. `urlPrefix(string): string | undefined` is used in Task 3. `PredicateContext.url` is written in Task 3 and populated in Task 7.
