# Experience trace IR — a manipulable language for recorded desktop behavior

**Date:** 2026-07-30
**Status:** Design approved, pending spec review

## Context

DeskRAG captures desktop activity and makes it *retrievable*. It cannot make it
*executable*. A recording can be searched, watched, and inspected, but there is
no representation of it that a machine can act on — no notion of "the thing I
did," only "the signals that were present while I did it."

The goal is a representation that can be replayed to reproduce behavior on a
computer, and — because it is structured rather than raw — manipulated at
defined points by a local AI to produce variations of that behavior.

### What capture already provides

- `UiohookInputProducer` (`src/capture/producers/uiohook-input.ts`) — `mouse_move`
  throttled to 100ms; `mouse_down`/`mouse_up` with `button`; `scroll` with
  `rotation`/`direction`; `key_down`/`key_up` with **`keycode` only**.
- `ActiveWindowProducer` — `focus_change` polled at 500ms: app name, window
  title, window id.
- AX trees per keyframe in `frame_ax` — flat, with `role`, `label`, bbox,
  `focused`, `parent` back-references, in **global screen coordinates, the same
  space as mouse events** (stated explicitly in `native/ax-dump.swift`).
- Region proposals and region-image embeddings per keyframe.
- Everything stamped on `t_mono`.

### What is missing for replay

No modifier state or resolved characters (a bare keycode cannot reproduce `⌘⇧4`
or typed text). No display topology or DPI, so coordinates do not port across
monitors. No window bounds, so no window-relative coordinates. No drag
semantics — `down`/`move`/`up` is not marked as one gesture. And 100ms movement
sampling is too coarse to reproduce a drag path.

### Scope decomposition

The full ambition is four subsystems, strictly ordered by dependency:

1. **Replay-fidelity capture** — enrich the input producer, add environment state.
2. **The trace IR** — lift raw events into structured, addressable actions. *(this spec)*
3. **The executor** — drive macOS from the IR, with verification.
4. **AI-in-the-loop** — intervene at keypoints against live state.

**This spec covers #2 only.** It was sequenced first deliberately: designing the
IR turns "what data do we need to capture?" from a guess into a derivation. The
capture requirements in the final section are an *output* of this document and
form the input to spec #1.

The executor (#3) is out of scope, but the IR is designed to carry everything it
needs. The AI contract (#4) has its wire shape defined here, because it
constrains the model; its runtime is a later spec.

## Decisions taken during design

- **Targets are layered anchors, not coordinates.** Each action carries up to
  three independent descriptions of its target — AX, visual, point — resolved in
  that order at replay, recording which layer won.
- **The layers are recorded independently at capture time, never derived from
  one another at replay time.** Deriving an AX target from a coordinate at replay
  is how these systems silently drift.
- **Motion is a typed parameter of gestures that need it**, absent from those
  that do not. Clicks warp; drags carry a path; hovers carry a dwell.
- **The trace is a graph**, not a linear list — nodes are verified states, edges
  are action sequences. Chosen over a two-level linear model.
- **Node identity is a layered resolver** mirroring the anchor ladder: predicate
  set primary and authoritative, visual similarity corroborating, provenance
  recorded.
- **Setup is not a separate phase — it is the graph.** Predicates are tagged
  `achievable` (some edge produces them) or `assertable` (no UI action can).
- **Typed text lifts to `type`/`chord` with named slots.** Slots are the
  parameterization mechanism.
- **Secure-field content is recorded like any other text.** Explicit decision,
  see below.
- **The AI is a router by default.** Edge selection and slot binding; action
  synthesis is opt-in per node.

### Explicit decision: no secret redaction

macOS AX exposes `AXSecureTextField`, so password entry is detectable at capture
time and could be lifted to a valueless slot. **We are not doing this.** Slots
exist for parameterization; secure-field content is recorded verbatim in both the
IR and the raw event log, in the clear.

Consequence, stated so it can be revisited without re-deriving it: any recording
made while typing a credential contains that credential on disk in plaintext, and
any trace shared or exported carries it. Mitigation is procedural — do not record
while authenticating.

### Explicit decision: the graph now, not a linear model

A linear trace was considered and rejected. The graph's argument is not
expressiveness but *provenance of variation*: in a linear model, alternatives can
only come from an AI editing a recording, whereas in a graph, recording the same
task twice merges at equivalent states and the divergence becomes an observed
branch. The AI selects among real alternatives instead of being the sole source
of every one.

Accepted cost: node identity — deciding when two states are the same — is a hard
problem the linear model does not have, and the whole design depends on it.

## Architecture

The IR is **derived, not captured** — a projection of stored events, AX trees,
and regions, exactly as segments and representations already are. It can be
rebuilt from scratch when lifting rules improve; a bad heuristic is never a
data-loss event.

```
capture/ → segment/ → represent/ → retrieve/
                 ↘ trace/ ──────────────→ replay/   (later spec)
```

### Module layout

`src/trace/` is pure TypeScript — no native modules, no subprocesses — so unlike
the executor it **can** be re-exported from `src/index.ts` without violating the
barrel rule.

| File | Responsibility |
| --- | --- |
| `types.ts` | The IR: `Graph`, `Trace`, `Node`, `Edge`, `Action`, `Anchor`, `Path`, `Predicate`, `Slot` |
| `predicates.ts` | AX tree → predicate set; `achievable`/`assertable` tagging |
| `anchors.ts` | interaction + AX frame + region → layered `Anchor` |
| `paths.ts` | polyline → fitted `Path`; `Path` + endpoints → polyline |
| `identity.ts` | Node equivalence: predicate match, visual corroboration, provenance |
| `lift.ts` | events + AX + boundaries → a linear `Trace` |
| `merge.ts` | linear `Trace` + existing `Graph` → merged `Graph` |
| `language.ts` | `Graph` ⇄ canonical text form (parse + print) |

`paths.ts` and `predicates.ts` are pure functions over plain data — no store, no
clock, no I/O — which is what makes them exhaustively testable.

### Dependency rules

1. **`trace/` never depends on `represent/` or `retrieve/`.** Node identity needs
   visual corroboration, which needs embeddings. Resolved by caller injection,
   the same pattern `store/` reconciliation already uses: `trace/` defines a
   narrow `VisualMatcher` interface, and `DeskRagService` wires it to existing
   region/frame retrieval. `trace/` stays a leaf.

   ```ts
   interface VisualMatcher {
     similar(ref: FrameRef, candidates: readonly FrameRef[]): Promise<number[]>;
   }
   ```

2. **The graph is SQLite-only — no new vector space.** Visual corroboration
   reuses existing region and frame vectors by id. No new namespace, no
   dual-store write-order hazard, graph writes are a plain transaction. Stated
   explicitly because "register a vector space" is the reflexive move here and
   would buy nothing.

### Canonical form vs. the language

The graph persists as SQLite rows. `language.ts` prints it to a readable text
form and parses it back, round-trip tested. That text is what the AI reads and
writes and what a human would hand-edit.

Keeping the persisted form typed and the exchange form textual means the AI never
sees ids and foreign keys, and a malformed AI response fails at the parser rather
than halfway through a database write.

## The data model

### Anchor

`point` is the only required layer — it is always recordable, so an anchor can
never be empty.

```ts
interface Anchor {
  ax?:     { role: string; label?: string; path: string };
  visual?: { regionId: string; phash: string; bbox: Rect };
  point:   { x: number; y: number; displayId: string; windowRelative?: Vec2 };
}
```

`ax.path` is the ancestor chain, not `role` + `label` — the latter is not unique
within a window.

Resolution order at replay is `ax → visual → point`, and the resolver records
**which layer decided and with what confidence**. That telemetry is the empirical
answer to "where is this trace brittle," and it is the reason the layers are
recorded rather than derived.

### Action

```ts
type Action =
  | { kind: "click";  anchor: Anchor; button: number; count: number }
  | { kind: "drag";   from: Anchor; to: Anchor; path: Path; button: number }
  | { kind: "hover";  anchor: Anchor; dwellMs: number }
  | { kind: "scroll"; anchor: Anchor; delta: Vec2; steps: number }
  | { kind: "type";   slot: SlotRef; recorded: string }
  | { kind: "chord";  keys: string[] }
  | { kind: "wait";   until: Predicate; timeoutMs: number }
```

`wait` is load-bearing. Replay must wait on **state**, never sleep on a recorded
duration — a dialog that took 400ms while recording takes seconds on a cold
start. Dwell gaps lift into `wait { until: <predicate that became true> }`. This
is the difference between a trace that works once and one that works repeatedly.

`type` and `chord` are separate because they are different things: text entry's
unit is the *string*, a chord's unit is the key combination and it is a command.
Separating them is what makes typed content parameterizable.

### Path

```ts
interface Path {
  curve: CubicBezier[];   // control points in unit space, endpoint-independent
  durationMs: number;
  velocity: number[];     // sampled speed profile, normalized
  fitConfidence: number;  // low when source samples were sparse
}
```

**The curve is normalized to a unit box between its endpoints.** This is what
makes synthesis fall out for free: the shape carries no absolute coordinates, so
retargeting re-projects the same curve onto new endpoints. "Verbatim" versus
"synthesized" is therefore not a stored mode but a runtime consequence — if both
endpoints resolve to their recorded positions, projection reproduces the original
exactly; if the AI moved one, the same projection generalizes it. One code path.

### Predicate

```ts
interface Predicate {
  kind: "app" | "window" | "ax_exists" | "ax_focused" | "display" | "file" | "permission";
  args: Record<string, string | number | boolean>;
  reach: "achievable" | "assertable";
}
```

- **`achievable`** — some edge in the graph establishes it (`∃ AXWindow[title="New
  Message"]`). If false on arrival, the executor searches for a path from where it
  actually is to a node where it holds.
- **`assertable`** — no UI action can produce it (display topology, app version, a
  file existing, an OS permission granted). Gates execution with a specific
  reason; has no repair path.

This tag is what makes "ensure the same application state is present" a
well-defined operation rather than a wish. It also collapses error recovery into
setup: arriving mid-replay at a node whose predicates do not hold triggers the
same pathfinding as starting cold. There is no separate recovery subsystem.

### Node and Edge

```ts
interface Node {
  id: string;
  predicates: Predicate[];
  visual?: { frameBlobId: string; phash: string };
  intervene: "none" | "select" | "synthesize";   // default "select"
  observations: number;
}

interface Edge {
  id: string;
  from: string;
  to: string;
  actions: Action[];
  guard?: Predicate[];
  provenance: "recorded" | "synthesized";
  observations: number;
  outcomes: { attempts: number; successes: number };
  liftWarnings?: string[];
}
```

A node is both a **checkpoint** (replay verifies state here) and an
**intervention point** (the AI may alter what happens next). They are the same
places by design: an AI can only sensibly rewrite a trace where state is settled.
Mid-drag or three keystrokes into a word there is nothing coherent to reason
about.

### Slot

```ts
interface Slot {
  name: string;          // stable, derived from the anchor it was typed into
  samples: string[];     // every distinct recorded value, in observation order
  secret: false;         // reserved; see "no secret redaction" above
}

type SlotRef = string;   // Slot.name, resolved against Graph.slots
```

Slots live on the graph, not the action, so one slot can be referenced by several
edges (the same value typed in two places). `Action.type` carries `slot: SlotRef`
plus `recorded: string` — the value from *this* observation, kept on the action so
a single recording replays verbatim without any slot binding.

A slot with one sample is a constant that happens to be addressable. A slot with
two or more is a discovered variable — see Merging.

### Graph and Trace

```ts
interface Graph {
  id: string;
  nodes: Node[];
  edges: Edge[];
  slots: Slot[];
  entry: string;         // node id
}

/** The output of lifting one session: a linear chain, merged into a Graph. */
interface Trace {
  sessionId: string;
  nodes: Node[];         // in traversal order
  edges: Edge[];         // edges[i] connects nodes[i] → nodes[i+1]
  slots: Slot[];         // each with exactly one sample
}
```

`Trace` is a `Graph` constrained to a single path. Keeping it a distinct type
makes the direction of `merge.ts` explicit in the signature
(`merge(graph, trace) → Graph`) and prevents an unmerged lift from being executed
as if it were a full graph.

## Semantics

### Lifting (`lift.ts`)

Reuses `computeBoundaries()` from `src/segment/boundaries.ts` rather than
inventing a second notion of where things break. Its existing reasons —
`focus_change`, `dwell_gap`, `bookmark` — are already the moments where state
settles, and `bookmark` is already a user-placed keypoint.

1. Cut the event stream at existing boundaries. No new boundary logic.
2. Group raw events into gestures within each span:
   - `down` → `up` with no movement → `click` (double-click by time+space proximity)
   - `down` → movement → `up` → `drag`, fitting the path over the **button-down
     interval only**
   - movement then dwell with no click, above threshold → `hover`
   - wheel runs coalesce → `scroll`
   - printable key runs coalesce → `type`, splitting on focus change
   - modifier + key → `chord`
   - idle gaps → `wait`
3. For each gesture, resolve the anchor **against the `frame_ax` captured at that
   moment, never live** — the rule `StoredAxProvider` already enforces at
   represent time. Deepest AX element containing the point, plus the covering
   region.
4. At each boundary, extract a predicate set from that instant's AX tree → a Node.
5. Emit `Node → Edge(actions) → Node`: a linear chain.

### Merging (`merge.ts`)

Walk the new chain. For each node, find an equivalent node in the graph via
`identity.ts`; reuse its id if found, otherwise create one. For each edge, if an
equivalent edge already connects the same pair, increment `observations`;
otherwise add a parallel edge — a branch.

**Edge equivalence compares action kinds, order, and resolved anchors, but not
typed content.** So two recordings differing only in what was typed collapse into
**one edge with two slot observations**. Slots are therefore *discovered* by
recording a task twice, not declared by hand; a third recording with a third
value makes the variable and its range plain. This is the mechanism by which the
graph teaches you where the parameters are.

### Node identity (`identity.ts`)

Predicate set is primary and authoritative. Two states are the same node iff they
satisfy the same predicate set, where predicates are extracted from the AX tree
and filtered to stable attributes — the same discipline `axFilter` already applies
to regions. Visual similarity corroborates and covers AX-blind applications. Every
match records which layer decided and with what confidence.

Predicates stay primary even where visual matching would be easier: a node whose
identity cannot be read is a node that cannot be debugged.

### The AI contract

Constrained hard by a repo invariant: **every provider is local.** No cloud
adapters, no API keys; a network call to a third party is a regression. So this is
an Ollama model on the machine, and the design must be one a local model executes
reliably — which means a small closed decision, not an open generative one.

```ts
interface InterventionRequest {
  goal: string;
  atNode: Predicate[];       // what the recording expects here
  observed: Predicate[];     // what is actually true now
  options: { edgeId: string; summary: string; guard?: Predicate[] }[];
  slots: { name: string; samples: string[] }[];
  allow: "select" | "synthesize";
}

interface InterventionResponse {
  choose?: string;                 // edge id
  bind?: Record<string, string>;   // slot values
  synthesize?: Action[];           // rejected unless allow === "synthesize"
  abort?: string;                  // reason
}
```

Showing `atNode` alongside `observed` is deliberate: the model sees the **diff**
between expectation and reality, a far easier judgment for a small local model
than "here is a screen, decide what to do."

A response naming an unknown edge id, an undeclared slot, or synthesizing under
`allow: "select"` is rejected at the parser and treated as `abort`. **The model
cannot widen its own permissions by malforming a reply.**

Synthesis is opt-in per node via `Node.intervene`, defaulting to `select`. A
synthesized edge is marked `provenance: "synthesized"` and is provisional; if it
executes successfully it can be promoted to a real edge, so the graph learns from
successful interventions the same way it learns from recordings.

Honest limitation: with a local model, `select` will carry most real usage, and
`synthesize` needs a dry-run and confirmation path in the executor spec to be
trustworthy.

## Failure handling

Lifting is a pure projection over immutable capture data, so every failure is
re-runnable and none lose anything.

| Condition | Behavior |
| --- | --- |
| Broken gesture (`down` with no `up`) | Drop the gesture, attach a `liftWarning`. Never fabricate the missing half. |
| No AX at gesture time | Anchor with `point` + `visual` only. Not an error — the type permits it. |
| Sparse mouse samples | Low `fitConfidence`. Not a failure. |
| Ambiguous node match | **Do not merge.** Create a distinct node and flag it. |
| No `VisualMatcher` injected | Predicate-only matching, recorded in provenance. Degrades, does not fail. |
| Malformed AI response | Rejected at the parser, treated as `abort`. |

The ambiguity bias is deliberate and asymmetric: failing to merge leaves a
redundant node that is visible and fixable, while merging wrongly corrupts the
graph silently and sends replay down a branch belonging to another context.

AI edits apply transactionally to a graph copy, so a rejected edit leaves the
stored graph byte-identical.

An `achievable` predicate with no path in the graph is not a lift-time error — it
is a fact discovered at replay. The IR records reach tags; pathfinding belongs to
the executor.

## Testing

All pure TypeScript, no native modules, no network — runs in the default
`npm test` gate.

- **`paths.test.ts`** — normalize→project round-trips to the original polyline
  within tolerance; a synthesized path between *new* endpoints preserves
  curvature sign and velocity profile.
- **`predicates.test.ts`** — checked-in AX fixture JSON (captured from the real
  sidecar, so no `swiftc` needed) → predicate sets; asserts the stability filter
  drops volatile attributes such as clocks and badge counts.
- **`identity.test.ts`** — equivalent and non-equivalent state pairs. The
  don't-merge-on-ambiguity bias is a test, not a comment.
- **`lift.test.ts`** — driven by the existing `SyntheticInputProducer`
  (`src/capture/synthetic.ts`), already deterministic. Synthesize a known event
  stream, assert the exact gesture decomposition. Highest-value file here.
- **`merge.test.ts`** — two chains differing only in typed text must produce one
  edge with two slot samples; two chains diverging mid-way must produce a branch.
  These two assertions are the entire thesis of the graph model.
- **`language.test.ts`** — `parse(print(g))` deep-equals `g`, plus a corpus of
  malformed AI responses each asserted to abort cleanly.

## Derived capture requirements

Output of this design; input to the capture spec (#1). Each follows from a
specific element of the IR.

1. **Mouse — adaptive sampling.** 10–20ms while any button is down, 100ms
   otherwise. Required by `Path` fitting for drags. Not a global rate increase:
   the firehose stays bounded.
2. **Keys — modifier state per event, plus the layout-resolved character**,
   alongside the existing keycode. Required by `type` and `chord`.
3. **Display topology** — id, bounds, scale factor per display, at session start
   and on change. Required by `Anchor.point.displayId`.
4. **Window bounds on each `focus_change`.** Required by
   `Anchor.point.windowRelative`.
5. **AX element path.** Derivable in TS from the sidecar's existing `parent`
   back-references; needs validation that it is stable enough to anchor against.
   Required by `Anchor.ax.path`.
6. **AX capture cadence.** AX is currently captured per keyframe (~1fps). Node
   predicates need a tree at each **boundary**, and boundaries do not coincide
   with keyframes. Either trigger an AX capture on boundary events, or accept the
   nearest keyframe's tree under an explicit staleness bound. Left unresolved,
   every node in the graph is built from a tree captured up to a second away from
   the state it claims to describe.
7. **App/document identity** — bundle id plus document path or URL on
   `focus_change`. Required by entry-node predicates.

Requirement 6 surfaced only because the IR was designed first, and it is the
sharpest of the seven — it would not have been visible from the capture side.

## Out of scope

- The executor: driving macOS via CGEvent/AX actions, dry-run, confirmation,
  abort conditions. Separate spec.
- The AI intervention runtime: model selection, prompting, latency budget.
  Separate spec. Only the wire contract is fixed here.
- Graph visualization or editing UI in the app.
- Trace embeddings. The graph registers no vector space; whether edges become an
  embeddable view is a later question, deliberately not answered now.
