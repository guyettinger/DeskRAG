# Agent access (MCP)

DeskRAG can serve what you have recorded to an external agent over
[MCP](https://modelcontextprotocol.io), so a coding assistant can ground its
decisions in what you have **actually done** — which tools you use, how you
carried out a task before, what was on screen at the time — instead of guessing.

The server is hosted by DeskRAGApp, is **read-only**, and never leaves your
machine.

## Connect

The endpoint is on by default. Open **Settings → Agent access (MCP)** and copy
the command:

```bash
claude mcp add --transport http deskrag http://127.0.0.1:41777/mcp
```

Any MCP client that speaks Streamable HTTP works; the transport is stateless, so
there is nothing to reconnect after DeskRAG restarts. DeskRAGApp must be running
— it owns the store and the models — but it can be closed to the tray.

## The eleven tools

### `search_experience`

"When did I deal with X?" A query runs the full retrieval stack and comes back as
ranked moments.

```
3 moment(s), best first. Ranking is RELATIVE to this result set: there is no
absolute confidence, and the best match of any query always comes first however
weak it is. "Matched in" names the ranked lists each moment appeared in —
agreement across several is what makes a match strong.

1. 2026-08-09 19:45:25 · 0:24.0 into recording 01KZM0X89RAJXRF42EK2VAGCKQ
   Task: start desk rag recorder
   On screen: The DeskRAG Recorder is recording, timer at 00:00:24.403.
   What happened: Electron — DeskRAG. clicked "Start recording". 1 click.
   Matched in: what happened, exact words, on-screen label
   1 matching region(s) on screen
   frameId: 01KZM0Y10BHJ4R8SX6PSVRKB1X  — pass to get_moment for the screenshot
```

**There is deliberately no score in that output.** The retriever computes one,
but every term of it is max-normalized across the current result set, so the
best hit of *any* query lands at the ceiling — literally `1.000` on a default
install — however good or bad the match is, and two queries' scores are not
comparable. An agent handed that number reports "100% confidence" to a user. The
lanes are what the number could never say: a moment three independent lists rank
highly is trustworthy, one scraping in on `exact words` alone is a stretch.

When every hit scores identically — frames sharing a segment with no region
match are equal on every signal there is — the preamble drops "best first" and
says the order is arbitrary instead.

An empty result is never just an empty list: if your vectors were indexed under a
different embedding provider, or segments matched but carry no frames, the tool
says so and names the remedy. Those are different states from "you never did
this", and an agent given a bare empty list would report the wrong one.

### `get_moment`

The screenshot, plus everything else recorded about that instant — caption,
what happened, any speech, and the labelled accessibility elements. The keyframe
comes back as a real MCP **image** block, so a vision-capable agent looks at the
pixels rather than at a description of them.

```
Frame 01KZM0Y10BHJ4R8SX6PSVRKB1X — 2026-08-09 19:45:25, 0:24.0 into recording 01KZM0X89RAJXRF42EK2VAGCKQ
Task: start desk rag recorder
On screen: DeskRAG Recorder app open in Electron, actively recording a session…
Accessibility elements: Window "DeskRAG", Button "Record", Button "Library",
  Heading "Capture an experience", Button "Start recording", CheckBox "Toggle Screen", …

[image image/jpeg, 275 kB]
```

Pass `includeImage: false` for the text alone.

### `list_recordings`

What exists, with what each recording was *for* — the summary of its root
segment. The tag says whether a model wrote it or it was rolled up from a
template, because an agent weighing evidence needs to know which.

```
13 recording(s).

01KZSSRJJJDTQ8D85QR283W904
  2026-08-12 01:35:33 → 2026-08-12 01:35:56  (22.7s)
  Purpose: Record a calculator calculation with DeskRAG [llm]
  21 keyframes · 38 segments · 182 events · 7.6 MB
```

A recording that was never indexed says so rather than claiming no purpose.

### `get_recording_outline`

One recording as its composed hierarchy — session purpose, the phases inside it,
the tasks inside those, and the individual actions, each stamped with its offset.
This is the fastest way for an agent to understand a whole session.

```
0:00.0–0:20.6  SESSION  Record a calculator calculation with DeskRAG [llm]
  0:00.0–0:01.9  PROCESS  check recorder is active [llm]
    0:00.0–0:00.0  TASK  Move mouse [llm]
      0:00.0–0:00.0  ACTION  mouse movement.
  0:01.9–0:14.9  PROCESS  perform calculator addition [llm]
    0:01.9–0:12.3  TASK  enter sequential addition in Calculator [llm]
      0:02.0–0:03.0  ACTION  The Calculator app is open over a browser window…
```

Two things it will not do. A recording indexed before the compose stage existed
has no session root, and the tool reports it as **never composed** rather than
presenting a flat action list as a hierarchy. And because a node holding exactly
one child is elided, an action can legitimately sit directly under a process or
the session itself — the outline prints the level each row actually is rather
than assuming a fixed depth.

### `list_flows` and `get_flow`

Tasks you have performed more than once, as routes through the states your
recordings actually passed through.

```
calculate
  id: Electron — localhost → Calculator → TextEdit → Electron
  6 recordings · 27 step(s)
```

`get_flow` walks one of them step by step, with the elements each action
targeted and the values that varied between attempts:

```
Step 3 — Calculator  ⟶  Calculator
    click        Button "All Clear" #AllClear
    click        Button "1" #One
    click        Button "Add" #Add
    · walked by 6 recordings, first at 2026-08-08 18:51
```

A **slot** with two or more samples is the interesting part — it exists precisely
because two recordings of one task differed there, which is the recorded answer
to "what changes each time I do this?". One sample is a value that happened to be
typed once, and the tool distinguishes the two rather than calling both
variables.

Routes are never synthesised. A merged graph composes paths no single recording
ever walked, and offering those as "your common flows" would present something
you have never done as a habit — so a graph with no provenance yields no routes,
and the tool points you at **Rebuild trace graph** instead of returning an empty
list.

### `list_habits` and `get_habit`

HABIT.md files you have kept from your own recorded flows, ready for an agent to
load. `list_habits` is the catalogue:

```
record-calculation-and-document-result
  id: 01M0922J6YZ9ESJB7AHTN8G24M
  Use when you need to perform a simple arithmetic calculation in Calculator and
  capture the result for documentation.
  1 recording · prose: llm
  RECORDED ONCE — kept from a single observation. Nothing has confirmed it repeats.
  route: Electron — localhost → Calculator → TextEdit → Electron
```

After the kept habits, the catalogue names the recorded routes you have walked
**more than once** but not yet kept, with how many recordings walked each —
recurrence is the only evidence a proposal carries, and it is what makes one
worth keeping. Routes walked once are counted rather than named: one walk is an
observation, and listing it beside a repeated route would present it as the same
kind of thing.

The two disclosures that would change an agent's mind about fetching are in the
**list**, not only in the file: a habit built from one recording, and a habit
whose route has left the graph so its steps are a stored copy that has not been
re-checked.

`get_habit` returns the file itself, raw, with no preamble before the `---`. The
point of the tool is that its output *is* a HABIT.md — a friendly sentence in
front of the frontmatter would corrupt a paste to disk, and everything a client
needs in order to weigh it is already inside the document.

Every habit has two halves written by different things, and the file says which
is which. Above `## Recorded steps` is prose — a local model's, or a template's,
declared as `prose: llm (...)` or `prose: template` in the frontmatter. From that
heading down is the **record**, rendered from the trace graph, and
`steps: template` says so on every habit because a model never writes it. That is
structural rather than a promise: the function that renders the record takes the
route and nothing else, so there is no path by which model output could reach it.

Two things a habit will not do. It does not print what you typed — a slot is
named and counted (`` `title` — 2 recorded values, varies between recordings ``)
unless you turn recorded values on for that habit, and even then the model is
never shown a sample. And it never claims a step succeeded or failed: nothing in
DeskRAG observes a failure, because passive recording only sees what you did. In
place of a success rate it carries **What this evidence does not say** — which
steps fewer recordings walked, which states can be confirmed but not located,
what lifting could not resolve, and whether one recording is being read as a
habit.

Habits are kept, renamed and edited in DeskRAG → Habits; this endpoint only
reads them.

**Saving one to disk.** DeskRAG calls the artifact a HABIT.md, but the document
inside it is the ordinary agent-skill shape — `name`, `description`, `metadata:`
and nothing else at the top level. So a habit destined for a Claude Code skills
directory is saved at `~/.claude/skills/<name>/SKILL.md`, under the filename that
directory requires; the frontmatter needs no editing. The rename is what DeskRAG
calls the thing, not a change to the format.

### `search_habits`

The catalogue is a chooser, and a composite habit runs to roughly 1,500 tokens, so
an agent that reads `list_habits` to find one habit reads all of them.
`search_habits` takes a situation in the agent's own words and ranks the kept
habits against it.

Two lanes are matched and fused by rank. The **prose** lane compares meaning
against what a person or model wrote — the title, the description, the body, and
the applications the route passes through. The **exact terms** lane matches
against the whole file, which is where a button label, a URL or an app name
actually lives. The reply names which lanes each habit appeared in and where:

```
matched in: prose #1, exact terms #3
```

There is no score, for `search_experience`'s reason. What replaces it is the
**corpus**, stated before the ranking rather than after it. With one kept habit
the reply says so outright — that habit is the only candidate, and nothing was
ranked against it. Below five it warns that a corpus that small ranks nearly
everything. An agent handed an order with no idea how many things were ordered
will present the first as authoritative.

If no local text model has downloaded, the prose lane is **skipped and says so**,
and the ranking is exact terms alone. A quietly lexical-only answer is
indistinguishable from a working one.

### `get_habit_step`

An agent following a HABIT.md and stuck partway has nowhere to look: the file
says `Calculator — no state → TextEdit — Untitled` and nothing shows what that
was. This returns one step with the screenshot of what was on screen when it ran,
plus the accessibility labels visible at that moment.

`step` is the number the file prints, counting from 1. `way` is the letter —
**required** for a habit whose recordings took different paths, because those are
different procedures rather than one procedure with options, and guessing would
answer about a path you did not read.

The screenshot is the last keyframe **at or before** the step began: a step is a
transition, and its actions want the screen as it was when they started. If the
step began before the recording's video did, the earliest keyframe is returned
and the reply says it is *after* the step rather than before it.

### `get_habit_steps`

The same recorded steps as JSON, to write as `steps.json` beside the HABIT.md
that `get_habit` returns — metadata, then the body, then the bundled file. Raw
JSON with no preamble, for the same reason `get_habit` has none.

Each step carries its edge, its actions and targets, how many recordings walked
it, when it was first walked, and **`arrivesWhen`** — the state the step arrives
in, as the conditions that identify it. That is the answer to "how do I know I
have got there". When it is `null`, `arrivesWhenAbsent` says why, and
`locatable: false` says a state can be confirmed but not recognised beyond its
application.

**No recorded keystroke value appears in this file, ever.** A slot travels as its
name and nothing else, and the per-habit "show recorded values" toggle is not
consulted — a file you deliberately turned values on for is not the same as a
payload handed to a background process over a socket.

## Read-only, by construction

The server cannot record, delete, re-index, or control your desktop. That is not
a promise in prose: `test/mcp.readonly.test.ts` asserts that no file in the MCP
surface imports the executor (`src/replay/`), names the `ax-exec` binary, spawns
a process, or calls any writing method on the service. The reader is handed a
narrow port that declares only the read half, so a tool could not close the store
even if one asked.

DeskRAGApp has not started a process capable of clicking since the executor was
unwired, and this does not change that.

## Security

The endpoint binds `127.0.0.1` only — never the network — and rejects any request
whose `Host` or `Origin` is not its own loopback address. The `Host` check is the
load-bearing one: after a DNS rebinding attack the browser considers the target
same-origin and sends no `Origin` header at all, so only the `Host` header
reveals that a web page is talking to your machine.

**There is no password on the endpoint.** Two things follow, and both are stated
in the Settings pane as well as here:

- any program running as you on this Mac can query your recorded activity;
- **recorded typing is included** in what it returns, so a password typed during
  a recording can appear in a search result.

The gate is visibility instead: every call an agent makes is shown live in
Settings — the tool, its arguments, how long it took, and whether it succeeded.
That log is held in memory and cleared when DeskRAG quits, because a permanent
growing record of what was read from your screen history is itself a second copy
of sensitive material.

If you would rather not expose it at all, turn **Serve recorded experience** off;
no port is opened.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Serve recorded experience | on | Off opens no port at all. |
| Port | `41777` | 1024–65535. Changing it moves the endpoint — reconnect your agent. |

The port is fixed rather than auto-assigned: you paste a URL into an agent's
config once, so a server that quietly moved to a free port would look broken. If
the port is already in use the pane says so and nothing is served, rather than
silently listening somewhere else.

## Troubleshooting

**Connection refused** — DeskRAGApp is not running, or the endpoint is switched
off. It can be closed to the tray, but not quit.

**Search returns nothing over a full library** — the pane's activity log will
show the call succeeding; the tool's own text explains which of the two index
states applies. Both are fixed from Settings → Maintenance.

**No flows** — the trace graph carries no provenance until it has been rebuilt;
press **Rebuild trace graph** in Settings → Maintenance.

To exercise the whole surface against your real store, from the repo root:

```bash
npm run probe:mcp
```

It drives the built app, calls all eleven tools, and runs the three guard checks.
It is read-only — every tool it calls is a read.

`npm run probe:habits` does the same for the two habit tools, and additionally
keeps one proposal so there is a file to check. That one write is disclosed in
its output; it deletes nothing and re-indexes nothing.
