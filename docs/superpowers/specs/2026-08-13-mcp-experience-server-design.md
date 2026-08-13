# The MCP experience server — DeskRAG as evidence for an external agent

**Date:** 2026-08-13
**Status:** designed

## Why

DeskRAG turns desktop activity into a searchable multimodal memory, and the only
thing that has ever read it is DeskRAGApp. Every question the index can answer —
what was on screen at 3pm, what that recording was *for*, how the user actually
carried a task out and what varied between attempts — is reachable from one
window on one machine, by a person, by hand.

An agent working alongside the user cannot ask any of it. It guesses instead:
what tools they use, how their project is laid out, whether they have done this
before, what they typed last time. The recordings hold the answers.

So: an MCP server, hosted by the app, exposing the experience index read-only.

The valuable payload is not the raw frames. It is the three things the pipeline
already computes and nothing outside the app can reach:

- the **composed hierarchy** — session purpose → process → task → action, each
  level a different question rather than the same question at a bigger box;
- the **trace graph routes** — recorded procedural flows, with the slot values
  that varied across recordings;
- the **coarse-to-fine retriever** — a query narrowed through segments, frames
  and regions into ranked moments with the keyframe that shows them.

## What this is not

It is not a way for an agent to *act*. `src/replay/`, `native/ax-exec` and every
`test/replay.*` case remain exactly as the 2026-08-06 removal left them: intact,
green, and unreachable from the app. This server does not widen that.

The guarantee is structural, not a promise in prose. `test/mcp.readonly.test.ts`
asserts that no file under `app/src/main/mcp/` mentions `replay`, `ax-exec`,
`spawn`, `child_process`, `startRecording`, `removeSession` or `reindex` — the
same principle as `test/replay.barrel.test.ts`, which is what makes the suite
structurally incapable of posting a real event. A tool that clicks cannot be
added here by accident; it can only be added by deleting that test.

There is also no recording control and no delete. An agent can read what
happened; it cannot make something happen, and it cannot destroy the evidence.

## Where it runs, and why not standalone

**In the app's main process, over HTTP on loopback.**

The obvious alternative — a `deskrag-mcp` stdio binary in the library package,
opening its own `DualStore` — was rejected on the seam this repo already draws:
`DeskRagService` is the single owner of the library, the store and the providers.
A standalone server would be a **second owner**. Concretely it would have to
duplicate `buildProviders` (Ollama hosts, the ONNX utility process, the reranker,
the managed models directory, the whisper resolution), re-read `settings.json`
behind the app's back, and open SQLite and LanceDB against a directory another
process is writing to. Every one of those is a drift hazard whose failure mode is
a silently different answer from the one the app would give.

The cost is real and worth stating: **the app must be running.** In practice it
is — the window closes to the tray and recording continues — but an agent asking
DeskRAG a question while DeskRAG is quit gets a connection refused, and that is
the trade accepted here.

### Transport

`StreamableHTTPServerTransport` in **stateless** mode: a fresh transport and a
fresh `McpServer` per POST, no session id, no SSE stream held open. This is the
Flows rule again — one call, no subscriptions, nothing to reconnect. A restart of
the app costs a client nothing.

One route, `POST /mcp`, on `127.0.0.1` at a settings-configurable port
(default 41777). `GET` is 405: there is no server-initiated stream to subscribe
to, and answering `GET` would imply one.

**A bind failure is surfaced, never swallowed.** Falling back to a random free
port is specifically wrong: the user has already pasted a fixed URL into their
client config, so a silent port change presents as "the server is broken" with
nothing on screen to say otherwise. The Settings pane shows the bind error.

## Security posture — decided, with the residual risk stated

The endpoint binds `127.0.0.1`, never `0.0.0.0`, and rejects any request carrying
an `Origin` header with 403. That check is not decoration: a web page you visit
can POST to `http://127.0.0.1:41777` from your own browser, and without it any
site could read your entire screen history. It is the MCP specification's own
DNS-rebinding mitigation.

**There is no bearer token.** This was raised explicitly during design, with the
attack described, and the choice was made for zero setup friction. The residual
risk is therefore documented rather than hidden:

> Any local process running as this user can read the entire experience index
> over the loopback endpoint, unauthenticated. The `Origin` check closes the
> browser-driven path only.

Two related exposures follow from the same "no gate" decision and are recorded
here so they are visible where they apply:

- **No session allow-list.** Every recording is readable by every tool.
- **Typed text is not redacted.** `buildDigest` folds typed runs into the digest
  — that is deliberate and is what took the digest's duplicate rate from 86% to
  4% — so a password typed during a recording can appear in
  `search_experience` output. The Settings pane says so.

The user-facing gate is instead **visibility**: every tool call is logged and
shown in the app.

### The activity log is in-memory, and that is a choice

A ring buffer of 200 entries in `server.ts`, pushed to the renderer on its own
event channel, cleared on quit. Adding a table is the sanctioned schema move in
this repo and would have worked — this is not a limitation. It is that a
permanent, growing audit trail of what an agent asked about your screen history
is itself a second copy of sensitive material, and nothing in the design needs
it to survive a restart. The pane states that it resets.

## Layers

The split follows `graph-view.ts` and `session-tracks.ts`: the arithmetic and
the formatting are pure and live in the ROOT test suite; one module does the I/O.
`vitest.config.ts` already aliases `@shared` and `deskrag` for exactly this, so
no config change is needed.

| Module | Purity | Job |
| --- | --- | --- |
| `mcp/tools.ts` | pure | Tool schemas + handlers, written against an injected `ExperienceReader`. |
| `mcp/outline.ts` | pure | Composed ladder → indented text. |
| `mcp/flow-text.ts` | pure | Route + graph → step-by-step procedural text. |
| `mcp/origin.ts` | pure | The request guard. |
| `mcp/reader.ts` | I/O | `ExperienceReader` + the `DeskRagService`-backed impl. |
| `mcp/server.ts` | I/O | http listener, transport, activity log, lifecycle. |

`ExperienceReader` is the seam that makes the tools testable without Electron, a
store, or a model — the same injection pattern as `LiftInput.axAt` and
`VisualMatcher` in `trace/`.

## The six tools

Each maps to one question a person would actually ask about their own past.

### `search_experience` — "when did I deal with X?"

`{ query, limit? }` through `DeskRagService.search`, returning ranked moments:
frame id, ISO wall clock, `offsetSec`, task summary, segment digest, caption and
the labels of what was highlighted.

It must surface the two diagnostics `search()` already computes —
`indexedUnderDifferentProvider` and `segmentsMatchedButNoFrames` — as prose. An
empty list is the shape of "nothing matched" *and* of "your vectors are in a
namespace this provider cannot read", and an agent given the bare list will
report the first when the truth is the second.

### `get_moment` — "show me the screen"

`{ frameId, includeImage? }` through `detail()` + `readBlob()`. A text block
(digest, caption, transcript, AX labels, highlights, session context) plus an MCP
**image** content block carrying the keyframe JPEG, so a vision-capable agent
looks at the pixels rather than at a description of them.

### `list_recordings` — "what have I recorded?"

`listSessions()`: ISO times, duration, counts, and `purpose` — the root summary,
the session's own statement of what it was for — carried with its
`purposeSource`. `llm` versus `template` travels with the text everywhere else in
this app, and an agent weighing evidence needs it more than a reader skimming a
list does.

### `get_recording_outline` — "what happened, at altitude"

`{ sessionId }` → the ladder as indented text with time offsets. This is the one
genuinely new formatter: the hierarchy exists on disk and is drawn as four lanes
on the rail, but nothing renders it as something you can read top to bottom.

Two existing invariants constrain it, and both were learned the hard way:

- **A missing `session` root row means the recording was never composed**, not
  that it has no structure. That absence is the marker for a recording indexed
  before the compose stage, exactly as `session_clock`'s absence marks a
  pre-calibration recording. The tool says so. Presenting that recording's flat
  action list as a hierarchy would assert a grouping no model ever made.
- **Elision means an edge can span two levels.** A node that would hold exactly
  one child is dissolved, and on the 286-action recording 33% of actions are
  direct children of the session root. The formatter therefore walks
  `getSegmentChildren` and prints the level it finds; it never assumes depth,
  and it never renders a rung that is not there.

### `list_flows` — "what do I do repeatedly?"

`service.flows().routes`: name, label, count, `nameObservations`, session ids.

An empty list needs its explanation too. A graph with no provenance yields **zero
routes by design** — routes are never synthesized from traversal, because a
merged graph composes paths no recording ever walked and offering those as "your
common flows" would be a fabrication. So on any install whose graph predates
provenance the honest answer is "no recorded routes; press Rebuild trace graph",
and the tool gives that rather than an empty array.

### `get_flow` — "how did I do it?"

`{ routeId }` walks the route's edges and prints, per step, the source state, the
actions in plain language (click on *label*, type *slot*, wait until app X), the
destination state, and which recordings walked it and when.

Then the slots and their sample values. **This is the decision-relevant half.** A
slot exists precisely because two recordings of one task differed there — it is
the IR's whole claim that variation comes from recording twice rather than from a
model inventing it — so the slot list is the recorded answer to "what changes
each time I do this?"

## Time is wall clock

Every timestamp an agent sees is ISO wall clock, `session.startedAt + tMono`, the
rule `search()` already follows. `offsetSec` travels beside it so a human can
jump to the moment in the app, but `t_mono` is not the primary field: an agent
reasons in "yesterday afternoon", not in milliseconds from a session epoch.

## One defect found while reading, fixed here

`DeskRagService.search()` clears and repopulates `this.lastHighlights`, and
`detail()` serves the renderer from that map. A search issued over MCP would
therefore wipe the open window's highlights mid-session — a UI state change
caused by a process the user cannot see, which is precisely what the read-only
promise is supposed to exclude.

The frame→DTO hydration splits out to return `{ hits, highlights }`, and only the
IPC path commits them. The MCP path carries highlights inline and mutates
nothing.

## Testing

The pure modules — tools, outline, flow text, the origin guard — are root-tested
against fakes, plus the read-only guard above.

None of that is the check that matters. Per this repo's standing rule, the server
is exercised against a **real recording in the DEFAULT configuration**:
`imageProvider: "none"`. Text retrieval recalls frames purely by segment
membership, and that is the exact path that once returned zero results over a
full library while every retrieval test passed — because every test built the
`Retriever` with an image embedder. A suite that only exercises the rich setup
cannot see the setup most users have.

The security posture is verified by hand, not by reading the code: `curl` with an
`Origin` header must 403, plain `curl` must succeed, and `lsof` must show the
listener on `127.0.0.1` rather than `*`.

## Deferred

- **Image-by-example queries.** `SearchInput.imageBytes` exists and works, but an
  agent rarely has a screenshot to hand, and the path needs an image provider
  configured.
- **Keyframes as MCP resources** (`resource_link` in tool results) rather than
  inline base64. Cleaner — the client fetches only what it wants — but client
  support is uneven today.
- **A stdio bridge** for clients that cannot speak Streamable HTTP.
