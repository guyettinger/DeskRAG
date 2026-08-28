# Roadmap and known gaps

What the design describes but the code does not yet do, and where a shipped
subsystem stops short of its claim. Everything here is **verified against the
current tree**, not carried forward from an older note — an item leaves this file
when the behavior exists, not when it is planned.

For the invariants that constrain how these get built, see
[CLAUDE.md](./CLAUDE.md). The reasoning behind each subsystem is in
`docs/superpowers/specs/`.

## Where the four subsystems stand

| # | Subsystem | State |
|---|---|---|
| 1 | Replay-fidelity capture (`src/capture/`) | shipped |
| 2 | Trace IR (`src/trace/`) | shipped, proven on real recordings |
| 3 | The executor (`src/replay/`) | shipped and green; **reachable only from the suite and `scripts/probes/replay.ts`** |
| 4 | AI-in-the-loop | wire contract shipped; **runtime unbuilt** |

## Not built

### AI-in-the-loop has a wire contract and no runtime

`printInterventionRequest` / `parseInterventionResponse` (`src/trace/language.ts`)
are implemented, exported, and tested — `parseInterventionResponse` is a
**security boundary**: an unknown edge id, an undeclared slot, or synthesis under
`allow: "select"` all become `{ abort }`, so a model cannot widen its own
permissions by malforming a reply.

What does not exist is anything that *calls* them: no model selection, no
prompting, no latency budget, no loop that pauses a run to ask. The IR spec fixes
the contract deliberately and defers the runtime to its own spec, which has not
been written.

### The executor is not wired to the app

`src/replay/`, `native/ax-exec` and every `test/replay.*` case are complete and
passing, but **nothing in DeskRAGApp can reach them**. There is no plan DTO, no
arm channel, and no location poller, so the app never spawns `ax-exec` at all.
`app/src/main/index.ts` deliberately does not resolve a path to that binary.

This is a **decision, not an omission** — the plan-review screen that used to
exist never became reliable and was removed on 2026-08-06 in favor of Flows, a
reader over the same graph (`docs/superpowers/specs/2026-08-06-flows-graph-exploration-design.md`).
Consequence worth stating plainly: the live executor measurements recorded in
CLAUDE.md cannot currently be reproduced from the app. Re-wiring it is a
deliberate act with its own safety design, not a refactor.

## Known gaps in shipped subsystems

### Deleting a recording orphans the trace graph

`DualStore.deleteSession` deletes the `session` row, and the cascade clears
`event` / `blob` / `segment` / `frame` / `region` plus the provenance tables
`trace_node_source` / `trace_edge_source`. It **never touches `trace_node` or
`trace_edge`**, so clearing every recording leaves the whole graph behind,
referencing sessions that no longer exist.

This is not a missing `ON DELETE CASCADE`. Merging is **lossy** — a node
accreted from six recordings cannot be un-merged — so per-session retraction from
a graph is not a well-defined operation. It needs a product decision, roughly:
drop the graph when the last session goes, offer an explicit reset, or mark the
graph stale and prompt a rebuild. The Flows screen already surfaces the symptom:
`observations` and the number of recording links legitimately disagree, and the
drawer says so rather than showing a quietly short list.

Today the workaround is **Settings → Rebuild trace graph**, which discards the graph
and re-lifts every remaining recording.

### Region proposals are effectively AX-only where AX is available

`fuse.ts` budgets to the top 14 regions by priority. AX boxes score **2** base,
**+1** with a label and **+2** when focused (so 2–5); interaction hotspots score
roughly 1–2; grid tiles score a flat **0.5**. In any app with a populated
accessibility tree the AX regions fill the budget and **no grid tile ever
survives**, so the visual anchor rung has coverage only where AX already had it.

How much this costs is app-specific and was measured on only two applications
(~5–8% of targets in TextEdit, ~40% in Chrome), so treat both numbers as
provisional per the validation rule below. The fix is not simply raising the grid
priority — that would displace real labeled boxes — it needs a coverage-aware cut
rather than a pure top-N.

### There is no AX fixture captured from the real sidecar

Every accessibility fixture in `test/` is hand-written, and `test/fixtures/`
holds only two PNGs. That is precisely why the AX role-prefix bug survived to
production: the sidecars emit roles **without** the `AX` prefix (`Button`, not
`AXButton`), hand-written fixtures agreed with whatever the code assumed, and the
result was **zero predicates from every real recording** — collapsing the graph
to one node with no waits and no slots.

CLAUDE.md records this as an open derived requirement. Capturing one real
`ax-dump` tree into the corpus is the single highest-value test addition in the
repo.

## Shipped but not validated against a real desktop

The executor has posted real CGEvents twice (2026-07-31, one click; 2026-08-02,
nine steps including a chord, typing, and an activation repair — see CLAUDE.md
for exactly what each run exercised). These parts have **only ever run against
`FakeActuator`**:

- **Drags.** `dragPath` is implemented in `sidecar.ts` and exercised in the
  suite; no real drag has been posted.
- **Continuation past a plan cut.** `executeRun` re-plans at each segment
  boundary, and that loop runs in `test/run.expected.test.ts`. Live, it has
  always aborted before segment 2.

Treat every other executor figure in the docs as a **capture-time or dry-run**
measurement.

### The MCP surface stops short in three known places

The endpoint ([docs/mcp.md](./docs/mcp.md)) ships with six read-only tools. Three
things were deliberately left out of the first version:

- **No image-by-example query.** `SearchInput.imageBytes` exists and works, but an
  agent rarely has a screenshot to hand and the path needs an image provider
  configured.
- **Keyframes are inline base64, not MCP resources.** A `resource_link` would let a
  client fetch only the images it wants — cleaner than a 275 kB block in a tool
  result — but client support is uneven today.
- **Streamable HTTP only.** A client that speaks stdio and not HTTP cannot connect;
  a thin stdio bridge would fix it and has not been written.

And one constraint that follows from hosting it in the app rather than as a
standalone binary: **DeskRAGApp must be running.** It owns the store and the
providers, and a second owner would have to duplicate provider construction and
open SQLite and LanceDB behind the app's back. The app may be closed to the tray,
but not quit.

## Standing constraints (not bugs, and not scheduled to change)

- **macOS only.** Capture depends on avfoundation, the Swift AX sidecars, and
  CGEvent. Nothing else is stubbed for another platform.
- **No schema migration mechanism.** `CREATE TABLE IF NOT EXISTS` runs on every
  open, so *adding* a table works on an existing install (verified — see
  CLAUDE.md), but an existing table's **shape can never change**. A change to
  what a column *means* needs a data-dir reset.
- **Every provider is local, permanently.** There are no cloud adapters and no
  API keys. A network call to a third party is a regression, not a feature to
  add.

## The rule that governs everything above

**Validate against a real recording before trusting a measurement.** Both of this
repo's worst bugs were invisible to `npm test` and obvious within minutes of
driving a real session through the pipeline. Synthetic fixtures agree with
whatever the code assumes — and any number derived from a single application is
provisional, because the anchor ladder was falsified twice, each time by
recording in one more app.

Read the **bytes**, not just the row counts: the silent-microphone default
produced a perfectly healthy-looking store with exact byte counts and contiguous
spans in which every sample was zero.
