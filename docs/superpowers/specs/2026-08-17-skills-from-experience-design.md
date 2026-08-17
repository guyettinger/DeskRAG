# Skills — a recorded route as a SKILL.md an agent can load

**Date:** 2026-08-17
**Status:** designed
**Builds on:** `2026-08-06-flows-graph-exploration-design.md` (the routes this reads) and
`2026-08-13-mcp-experience-server-design.md` (the read-only surface it extends). Neither
changes.

## Why

`frequentRoutes` already finds the repeated tasks in the trace graph: a named, counted path
with discovered variables and provenance back to the recordings that walked it. `get_flow`
already renders one as step-by-step procedural text. Two of the six MCP tools are, in
substance, "here are your repeated tasks, step by step, with the values that varied."

What is missing is the last mile. An agent like Claude Code loads **skills** — a `SKILL.md`
with `name`/`description` frontmatter and a procedural body. DeskRAG has no surface that
produces one, nowhere to keep the ones worth keeping, and no way to correct the ones it gets
wrong. A route is *raw material for* a skill; it is not a skill, because nothing decides
which routes are worth having, what they should be called, or what to do when the graph is
rebuilt underneath them.

So: a seventh screen. DeskRAG proposes a skill per route, the user curates, each renders to
markdown reachable by clipboard or by MCP.

The property that makes this worth building rather than writing how-to prose by hand is that
a DeskRAG skill is **evidence**: counted, cited back to real recordings, and explicit about
what it does not know.

## What this is not

No file export. There is no `dialog` import anywhere in `app/src` and no save channel, and
this does not add one — the first outbound file write in DeskRAG's history is not a thing to
do casually for a feature whose output is a few kilobytes of text. Delivery is the clipboard
and two read-only MCP tools. A user who wants the file on disk pastes it; that keeps the
"never leaves your machine unless you move it" property intact and literal.

The executor stays unwired. Nothing here spawns anything.

## The section that must not be built

The obvious design puts a **"Watch for — this step sometimes failed"** section in the skill,
built from `TraceEdge.outcomes {attempts, successes}`. It would be the strongest thing in the
file: no generic how-to can say which step is flaky.

**It is vacuous. Every edge in every graph on disk has `outcomes: {attempts: 0,
successes: 0}`.**

`src/trace/lift.ts:222` writes the zeroes. `src/trace/merge.ts:66,121` copies them. Nothing
in `src/`, `app/src/` or `scripts/` increments either field. The only reader is
`src/replay/plan.ts:43`, which treats `attempts === 0` as a 0.5 prior — written that way
precisely because the counters are never populated. The executor that would have produced
real numbers has had no UI since 2026-08-06 and has run against a live desktop three times
ever.

And it cannot be fixed by capturing harder: **passive recording cannot observe a failure.**
The user did the thing; it succeeded. A failure only exists when something *replays* a step
and the state does not arrive.

`toGraphDTO` (`app/src/main/graph-view.ts:284-294`) already drops `outcomes` and `guard`
from `GraphEdgeDTO`. Leave them dropped. Widening the DTO would ship a section that is empty
on every install, which is the failure mode the `skipReason` and `describe` rules exist to
prevent elsewhere.

### What replaces it

A **"What this evidence does not say"** section, template-generated from facts that are real
and already in the DTO:

| Fact | Source | What it says |
| --- | --- | --- |
| `edge.liftWarnings` | `lift.ts:223`, merged `merge.ts:110` | what lifting could not do here |
| `node.locatable === false` | `isLocatable`, `identity-set.ts:147` | an app-only identity verifies perfectly and locates never |
| `route.count === 1` | `frequentRoutes` | one recording is not a habit |
| `nameObservations < count` | `nameRoute` | the recordings disagreed about what this was for |
| a slot with one sample | `discoveredVariables`, `merge.ts:142` | a value typed once, not a variable |
| `sources.length < observations` | the standing rule | evidence deleted since |

Every one of these is a limit on the claim, which is what a consuming agent needs and what a
score would have obscured.

## Identity, and what a rebuild does to it

A route's `id` **is** the de-duplicated place-label sequence:

```ts
const key = places.join(" → ");   // app/src/main/graph-view.ts:534
```

That key was chosen over the edge-id and node-id sequences after both were measured on a real
9-recording graph and both split five identical walks into nine routes of ×1. It is the only
key that finds repetition — and it is **not stable**. Record the same task once more in a way
that touches one extra app and the key changes. `rebuildGraph` discards and replays the whole
graph. So a skill cannot *be* a route, and a saved skill keyed on `route.id` would silently
lose the user's edits on the next rebuild.

> The `FlowRouteDTO.id` doc comment at `app/src/shared/types.ts:1074` still says "the joined
> edge-id sequence — stable across reloads, and its own key." That is **stale** on both
> counts. Fix it as part of this work; it is exactly the comment that would talk the next
> person into binding to it.

### The binding

A skill owns an app-minted **ULID**, stable forever. The binding is a *record of a past act*,
stored verbatim and never rewritten by the app: the `routeKey` it was accepted against, that
route's `label`, its `sessionIds`, and the wall clock of the act.

`bindSkill(doc, routes)` — pure, in `app/src/main/skill-bind.ts`, root-tested — resolves each
skill against the routes the graph has *now*:

1. **exact** — `routes.find(r => r.id === doc.routeKey)`. Still computes lost/gained: a route
   can keep its key and lose a recording, and that must show.
2. **rebound** — no exact match, but one route holds a **strict majority** of the stored
   `sessionIds`.
3. **ambiguous** — two candidates tie. It **declines** rather than picking.
4. **orphaned** — nothing matched.

The majority rule is not a tuned threshold, and that is the point. `frequentRoutes` builds
`walked` keyed by `sessionId` and each session produces exactly one key
(`graph-view.ts:504-548`), so **`sessionIds` partition across routes** — more than half of a
set can lie in at most one part. A strict majority therefore has at most one winner
*mathematically*, with no heuristic tiebreak. The only case that ties is an even split (two
recordings landing on two routes), and there it declines, for the reason `trace/identity.ts`
declines to merge on ambiguity: a redundant state is visible and fixable, a wrong one is
silent.

**Nothing in `bindSkill` writes.** A rebind is disclosed and stays disclosed until the user
confirms it; `routeKey` changes only by an explicit act. Silently adopting the new key would
make the skill's own record of where it came from unfalsifiable.

`sessionIds` lives in JSON and is deliberately **not** a foreign key. An FK would cascade the
skill away when a recording is deleted — and deleting a recording must change what the skill
*reports*, not destroy what the user wrote. The live count comes from `route.count` and the
bind-time count from `boundSessionIds.length`; neither is ever derived from the other, and
their disagreement is the information.

That disagreement also arrives for free and without a rebuild: `trace_edge_source.session_id`
cascades (`schema.ts:274`) and `getGraph` reads sources straight from those tables
(`store.ts:1865-1876`), so `route.count` drops the moment a recording is deleted.

### An orphan must still produce a usable file

Orphaning is routine, not exotic — any re-index calls `rebuildGraph`, and one new app hop
re-keys a route. A skill whose whole body reads "route unavailable" is a broken artifact.

So the doc carries `stepsSnapshot`: the exact Recorded-steps block with the wall clock it was
rendered at, refreshed at every moment the skill is written anyway (accept, generate, edit,
confirmed re-bind) and **never on a read**. When live, the file prints live steps; when
orphaned, it prints the snapshot under a dated header saying it has not been re-checked.
Never both, never blended.

## Schema — a fifth bucket

`src/store/sqlite/schema.ts` exports four lists, and `test/store.purge-derived.test.ts:300`
unions them against `sqlite_master` so a new table cannot avoid the question. `skill` answers
it with none of the four:

- not **captured** — no sensor wrote it;
- not **derived** — a re-index must never regenerate it, because it holds edits that cannot
  be recomputed from the blobs;
- not **operational** — it is not a work queue, and losing it costs writing, not pending work.

It is **authored**: unrecoverable like a recording, but written by a person rather than by a
sensor. That distinction is the whole reason it needs its own list — it shares "a purge must
never touch this" with `CAPTURED_TABLES` and shares nothing else.

```ts
/**
 * AUTHORED state: written by the user, and unrecoverable.
 *
 * Like a recording, losing this loses something no re-index can reproduce — but
 * unlike a recording it came from a person, not a sensor. It is NOT derived:
 * `purgeDerived` exists to discard what can be rebuilt from the blobs, and a
 * skill's name, description and prose cannot be. A re-index must leave it alone.
 */
export const AUTHORED_TABLES = ["skill"] as const;
```

```sql
CREATE TABLE IF NOT EXISTS skill (
  id         TEXT PRIMARY KEY,   -- ULID, minted by the caller
  state      TEXT NOT NULL,      -- app-defined: active | archived | dismissed
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  doc        TEXT NOT NULL       -- JSON, app-defined
);
CREATE INDEX IF NOT EXISTS idx_skill_state ON skill(state, updated_at);
```

`state` and `doc` are **deliberately opaque to `store/`** — the `index_job.payload` seam.
What a skill *is* — frontmatter, prose, binding, the samples toggle, the steps snapshot — is
an app concept, and this schema can never change shape. One JSON column is what makes a
seventh field possible in six months without a data-dir reset.

Adding a table is the sanctioned schema move and works on an existing install
(`CREATE TABLE IF NOT EXISTS` runs on every open). Verify it the `transcript_clip` way rather
than assuming: open a copy of a real `app.db` with the new code, confirm it gains `skill` and
that no other table's row count moves.

Inside `doc`: `edited` is what makes **Regenerate** ask first — without it, regenerating
silently eats prose the user wrote. `bodySource: "llm" | "template"` follows `SummarySource`
exactly: disclosure, not bookkeeping, so a templated skill cannot masquerade as one a model
wrote.

**`dismissed` is a real row**, carrying only the binding and an otherwise-empty doc. A
rejected proposal that is not persisted comes back on every load — which the "accepts and
rejects" requirement implies but does not by itself solve. It is reversible from a
"Dismissed" filter in the head.

## The rendered file

Frontmatter carries `name` and `description` and nothing else at the top level. Surveyed
across the 139 `SKILL.md` files installed on this machine, those two are the only keys
present in all of them; `metadata:` is the sanctioned nested extension, and shipped skills
carry substantial custom blocks there. An invented top-level `confidence:` — which is where
the first sketch of this went — is both non-standard and the exact number
`search_experience` refuses to print.

```markdown
---
name: file-a-bug-report-on-github
description: Use when filing a GitHub issue on a repo you already have open. Recorded 5 times.
metadata:
  source: deskrag
  skill_id: 01K3W8QF5T3M2Q7V6N0X4C1B8D
  recordings: 5
  recorded_between: 2026-08-02 / 2026-08-14
  step_count: 12
  prose: llm (ollama qwen3:4b)     # or: template
  steps: template                   # always. The record is never model-written.
  route: "Google Chrome → github.com/user/repo → Google Chrome"
---

# File a bug report on GitHub

<model-written: what this is, when it applies, how it goes>

## Inputs

- `title` — 2 recorded values, varies between recordings
- `body` — 1 recorded value (typed once; not established as a variable)

## Recorded steps

Step 1 — Google Chrome  ⟶  github.com/user/repo
    click        Button "Issues"
    · walked by 5 recordings, first at 2026-08-09 19:45

## What this evidence does not say

- Recorded 5 times; 3 of 5 recordings agreed on what it was for.
- Step 4's state is identified only by its application, so an agent can confirm it
  arrived but cannot locate that state on screen.
- lifting note: dwell gap ending at 4200 produced no newly-true predicate.
```

### The model writes the body, and the record stays beside it

A model writes the prose, because the frontmatter `description` is what decides whether an
agent ever *loads* the skill, and the alternative is a mechanical join of route labels.
`nameRoute` cannot fill that gap: it votes by exact string match, so four recordings agreeing
semantically about what a task was report as 1-of-4, and `name` is frequently null.

The hazard is equally plain: a model writing a whole body can state a step that was never
recorded — the one thing the IR refuses to do everywhere else. Four mitigations, none of
which prevents it, all of which make it visible:

- **The model writes four fields and nothing else** — `title`, `description`, the opening
  paragraph, and `## When to use`. They are emitted strictly *above* the `## Recorded steps`
  heading, and `renderSkillMarkdown` concatenates prose-then-record, so there is no code path
  by which the model's string reaches the record. The root test is adversarial: for an
  arbitrary body — *including one containing its own `## Recorded steps` and a fake step
  list* — the document's tail from that heading onward must be byte-identical to
  `recordedBlocks(...)`.
- `parseSkillResponse` **rejects wholesale**: a reply missing any of the four fields, or
  carrying a `steps` key, returns `undefined`. No partial acceptance, no repair — the
  malformed-partition rule.
- `prose: llm (ollama <model>)` vs `prose: template`, and `steps: template`, are in the
  frontmatter.
- Generation **can never fail the app**, following the compose precedent: an unreachable
  daemon degrades to the template body and *says why* in `generateNote`.

A default install with no summarizer gets the template body, and that path is what the probe
runs **first**.

### Slot samples are named, not printed — and the model never sees one

Recorded typing is verbatim and unredacted by design; `Slot.secret` is `false` by
construction. A skill is a document that gets pasted elsewhere, which makes it a different
exposure from a search result the user is looking at.

So the default prints the *name* and the *count*: `` `title` — 2 recorded values, varies
between recordings ``. That preserves the fact that actually matters — two samples is a
discovered variable, one is a value that happened to be typed — without shipping the strings.
A per-skill toggle, off by default, prints them under a warning that travels *in the file*,
not just in the UI.

**The brief sent to the model carries names and counts only, in both modes.** The toggle is
purely a rendering decision, so a typed password has one fewer place to travel. A root test
asserts no sample string occurs in `briefFor()`'s output.

### One walk, two formatters

`mcp/flow-text.ts` already walks a route and formats it (`stepLines`); the SKILL.md needs the
same walk in markdown. Two readers of one structure is the `ax-dump`/`ax-exec` drift hazard
by name, so the walk is extracted to `app/src/main/flow-steps.ts` as `flowSteps(flows, route)
→ FlowStep[]`, and both formatters read it.

`renderFlow` keeps its current behaviour exactly, including printing samples unconditionally
(`flow-text.ts:33`) — `get_flow` is a shipped contract documented in `docs/mcp.md`. The
regression check on the refactor is that **`test/mcp.flow-text.test.ts` passes byte-identical
afterwards.**

## Where the code goes

`renderFlow`, `renderOutline` and `graph-view.ts` are **app-side** — `app/src/main/mcp/` and
`app/src/main/` — root-tested through the `deskrag` and `@shared` aliases in
`vitest.config.ts`. The skill renderer joins them. It does not go in `src/trace/`, which is a
leaf that must not learn about DTOs.

| Path | New? | What |
| --- | --- | --- |
| `src/embed/skill-prose.ts` | new | `SkillProseProvider`, `SkillBrief`, `SkillProse`, a deterministic fake, and the pure prompt/parse pair. `SummaryProvider.compose` is a *partitioner* and is the wrong shape. |
| `src/embed/ollama-skill-prose.ts` | new | plain `fetch`, barrel-safe. Reads both `message.content` **and** `message.thinking` — a thinking model routes structured output into the latter. |
| `src/store/sqlite/schema.ts` | edit | the table + `AUTHORED_TABLES` |
| `src/store/store.ts` / `types.ts` | edit | `putSkill` / `listSkills` / `getSkill` / `deleteSkill` through `mutex.run` |
| `app/src/main/flow-steps.ts` | new | the shared route walk, pure |
| `app/src/main/skill-bind.ts` | new | `bindSkill`, `proposalsFrom`, row ordering — pure |
| `app/src/main/skill-doc.ts` | new | `renderSkillMarkdown`, `templateBody`, `briefFor`, `slugify` — pure |
| `app/src/main/mcp/skill-text.ts` | new | `renderSkillList` only. In `mcp/`, so the read-only guard's `readdirSync` covers it for free. |
| `app/src/main/mcp/reader.ts` | edit | `skills()` on `ExperienceReader`, `listSkills()` on `ServiceReads` |
| `app/src/main/mcp/tools.ts` | edit | `list_skills` / `get_skill`, both matching `/^(search\|get\|list)_/` |
| `app/src/main/deskrag-service.ts` | edit | the seven service methods + `buildProseWriter()` |
| `app/src/shared/types.ts` | edit | DTOs, `DeskRagApi.skills`, `IPC.skills*`, **and the stale `FlowRouteDTO.id` comment (it is wrong in two places, `:1067` and `:1074`)** |
| `app/src/renderer/src/screens/SkillsScreen.tsx` | new | the screen |
| `app/src/renderer/src/skills-view.ts` | new | `.ts`, not `.tsx` — the root tsconfig sets no `jsx` |

**Persistence never touches the reader.** `test/mcp.readonly.test.ts` asserts the
`ExperienceReader` and `ServiceReads` interface bodies contain no
`write|put|set|delete|record|remove|start|stop|arm|execute`, so accept/edit/regenerate go
through `DeskRagService` and IPC by construction, not by discipline. (It is also why the
method is `skills()` and not `getSkillSet`, and why no field here is named `startedAt`.)

### Generation runs on demand, and must not build the world

One model call taking seconds, so it is a plain async IPC call. Not an indexing stage — the
plan table is re-run whole by a re-index, which would **rewrite user-edited prose on every
rebuild** — and not the durable queue, whose purge is `purgeDerived` and which exists for the
hundreds-of-units work where a stage measured 14m16s.

`generateSkill` must **not** call `buildProviders()`. That resolves ONNX weights, opens the
out-of-process host, and can download half a gigabyte — for a call that needs a chat endpoint
and nothing else. It gets a private `buildProseWriter()` reading `summaryProvider`,
`ollamaSummaryModel` and `ollamaHost`, and nothing else. Reusing the **summary** model rather
than adding a picker is deliberate: naming a level and naming a flow are the same act at two
altitudes, and two pickers is two things to keep in step.

### No new `Capabilities` member

`Capabilities` reports configured intent as booleans, but this screen needs the model's
*name* for its disclosure — a boolean there plus a name here would be two answers to one
question, the drift `shared/evidence.ts` exists to stop. `SkillsDTO.prose:
{ available, model }` is the single source.

## The screen

Seventh route, after Flows — the order the work happens in. Modelled on `RouteList.tsx`,
which already renders `×count`, a name falling back to a label, and name disagreement in a
`title`.

Bands, in this order — **Needs attention** first (rebound / ambiguous / orphaned, hidden when
empty), then **Mine** (pinned first, then `updatedAt` desc), then **Proposed**
(`frequentRoutes`' own order: count desc, then steps desc).

- **Proposed** — `×count`, the route name or label, step count, app chips, and
  `Accept` / `Not a skill`. Selecting one shows its rendered preview in the right pane, so
  accepting is never blind. `count === 1` is shown as weak rather than hidden or filtered
  out; the user decides.
- **Mine** — title, `slug` in `.mono`, `×N recordings`, the `llm`/`template` chip, `edited`,
  pin. Editor pane: title/description/slug inputs, one **prose** textarea labelled *"Yours or
  the model's — everything below is generated from the recording and cannot be edited here"*,
  and the generated blocks verbatim in a read-only `--sunken` well. Then `Generate with
  model` (disabled **with the reason in words** when no model is configured, never merely
  greyed), the samples switch, `Copy SKILL.md`, Pin, Archive, Forget.
- **Needs attention** — the binding chip in amber plus the sentence from `binding.note`.
  Re-bind is a **press**, never automatic; the ambiguous case offers a picker and refuses to
  choose.

`Copy SKILL.md` copies `skill.markdown` — the string *main* rendered, byte-identical to what
`get_skill` returns. The renderer never re-renders the document; two renderers of one file is
the drift hazard, and the probe asserts they match.

Regenerating over `edited: true` goes through the existing `.confirm` overlay: *"This
replaces the prose you wrote. The recorded steps are unaffected."*

Three distinct empty states, never one: no graph at all (the existing `NO_GRAPH` sentence);
a graph with no provenance (zero routes → the rebuild pointer, verbatim from `RouteList`);
routes present but nothing kept.

Nothing truncates: a label fits or is withheld. The panes scroll, not the page.
`container-type` never goes on `.page`. `.skill` / `.skills` do not appear in `styles.css`,
so the class family is free — and it does not collide with `.signal`/`.signals`, `.settings`
or `.stagenode`. Two things to measure in the running app rather than in CSS: the seventh
rail item at the 900×600 minimum, and the editor's height chain, where one missing
`min-height: 0` silently restores page scroll.

## The two MCP tools

`list_skills` takes no arguments and prints, per kept skill: slug, id, description, `N
recordings · M steps · prose: llm|template`, the route, and — where they apply — the
`RECORDED ONCE` and `ORPHANED` lines. Three distinct empty branches, each naming its remedy,
the `search_experience` rule: no graph (reuse `NO_GRAPH` verbatim), a graph with no
provenance, and routes present but nothing kept — the last one **naming how many routes it
could propose from**, which is the actionable half.

`get_skill(skillId)` returns **the raw SKILL.md as the only text block, with no preamble.**
Deliberate: the value of this tool is that its output is a *file*, and a friendly sentence in
front of the `---` corrupts a paste-to-disk. Everything a client needs in order to weigh it is
already inside the document — `metadata.prose` says who wrote it, `metadata.recordings` says
how much evidence there is, `metadata.steps: template` says the record was not model-written.

Both names satisfy the guard's `/^(search|get|list)_/`. `SERVER_INSTRUCTIONS` gains one
sentence; `docs/mcp.md` and `app-main.md`'s "six tools" become eight.

## Verification

Root suite: `flow-steps`, `skill.bind`, `skill.doc`, `skill.proposals`, `skill.prose`,
`store.skill`, `skills-view`; `mcp.flow-text` **byte-identical after the refactor**;
`mcp.tools` extended; `store.purge-derived` extended with the new bucket; `mcp.readonly`
green and unchanged. Both typechecks. The load-bearing three:

- the **adversarial body** test — a `body` containing its own `## Recorded steps` and a fake
  step list must not change one byte of the real record block;
- **no sample string appears in `briefFor()`'s output**, in either toggle state;
- `purgeDerived` and `deleteSession` leave `skill` untouched, and deleting a bound recording
  lowers `route.count` while `doc.sessionIds` stays as written.

None of that is sufficient, and the repo has paid for believing otherwise three times. A new
`npm run probe:skills` drives the real app through the `run-app` launcher, as `probe:mcp`
does:

1. runs **first in the default configuration** (`summaryProvider: "none"`) — the install most
   people have and the one a suite built around a configured model cannot see — printing the
   configuration it found before any assertion;
2. accepts the top proposal from a **real** graph and asserts `bodySource === "template"`, so
   a bare install produces a usable skill or the probe fails;
3. presses Copy and reads it back via `electronApp.evaluate(({ clipboard }) => clipboard.readText())`;
4. calls `list_skills` and `get_skill` over the real loopback socket and **diffs `get_skill`
   against the clipboard byte for byte** — the check that matters, and one nothing in the
   suite can see;
5. with a model configured, generates and asserts the `## Recorded steps` block is
   byte-identical to the template run's — the fabrication mitigation made measurable rather
   than promised;
6. deletes nothing and re-indexes nothing.

Then two manual checks nothing automates:

- **paste a generated SKILL.md into `~/.claude/skills/` and confirm Claude Code loads and
  triggers it.** That is the acceptance test the whole feature exists for;
- record one more session through a kept flow, rebuild the trace graph, and confirm the skill
  comes back **re-bound and disclosed** rather than orphaned or silently moved.

## Build order

Dependency direction — `store/` first, the app last — mirroring the four `feat(mcp)` commits:

0. **`docs(spec)`** — this file, plus the `FlowRouteDTO` doc fix.
1. **`feat(store): a skill is authored, so it gets its own bucket`** — the table,
   `AUTHORED_TABLES`, the store methods, `store.skill` and the purge-guard edit. Verified
   against a copy of a real `app.db`.
2. **`feat(embed): a prose seam that can never fail the file`** — `skill-prose.ts`,
   the Ollama adapter, the barrel. Library gate green *before* anything in `app/` moves, then
   `npm run build`, since the app imports `dist/`.
3. **`feat(app): bind a skill to a route that will not hold still`** — `flow-steps.ts` (+ the
   `renderFlow` refactor and its byte-identical test), `skill-bind.ts`, `skill-doc.ts`, the
   DTOs. All pure, all decided in the root suite, nothing on screen yet.
4. **`feat(app): the Skills screen, and the file it hands you`** — the seven service methods,
   the five IPC edits, the screen, `skills-view.ts`, styles. Measured in the running app.
5. **`feat(mcp): two read-only tools over the kept skills`** — `reader.ts`, `tools.ts`,
   `skill-text.ts`, `probe:skills`, and the real-store pass recorded with its numbers.
6. **`docs`** — `docs/mcp.md` (eight tools), `app-main.md` (the fifth bucket, the on-demand
   rule, the tools), `app-ui.md` (the screen, the prose-vs-record split), one line in
   `CLAUDE.md` (*a skill is AUTHORED — no purge, re-index or rebuild may touch it, and its
   binding is disclosed, never silently repaired*), `README.md`, and `npm run gen:shots`.
