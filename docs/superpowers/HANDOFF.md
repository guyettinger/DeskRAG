# Handoff — after the executor landed (2026-07-31)

`main` is at `9791b3b`. PR #20 merged the executor and the trace fixes; both
branches are deleted. Working tree clean, 647 tests passing, all three gates
green (`npm run typecheck`, `npm test`, `npm --prefix app run typecheck`).

## Where the four subsystems stand

| # | Subsystem | State |
| --- | --- | --- |
| 1 | Replay-fidelity capture | shipped |
| 2 | Trace IR (`src/trace/`) | shipped, and now proven on real recordings |
| 3 | **The executor (`src/replay/`)** | **shipped, never run against a live desktop** |
| 4 | AI-in-the-loop | wire contract fixed in the IR spec; runtime unbuilt |

Read first: `CLAUDE.md` (now documents the `replay/` seam), then
`docs/superpowers/specs/2026-07-31-executor-design.md`.

## The one thing I would do next

**Run the executor for real.** It is fully tested against `FakeActuator` and has
never resolved a plan against a live AX tree or posted a single CGEvent. Every
number in its spec — anchor ladder rates, path depths, brittleness — is a
**capture-time** measurement. Whether a recorded anchor still resolves at
*replay* time is a different question, and unanswered.

This is the same shape of gap the previous handoff flagged for capture ("no real
recording has been driven through the full chain"). Closing that one surfaced
four defects within an hour, including one where **no real recording had ever
produced a single AX predicate**. There is no reason to expect the executor to be
in better shape.

`buildPlan` is inert — no arming, no CGEvents — so this is zero-risk:

- Four sessions are already recorded in the dev data dir
  (`~/Library/Application Support/deskrag-app/DeskRAG/`): 2 TextEdit, 1 Chrome,
  1 System Settings, merged into one graph (43 nodes, 50 edges, 4 slots).
- Build a plan from live AX against that graph and read what happens: does the
  current node get identified at all? Do the rungs resolve? How do replay-time
  ladder rates compare with the capture-time ones?
- Only then consider arming anything, and pick a target that is harmless to
  replay.

## Open work, roughly in order

1. **Replay-time validation** (above).
2. **A real-sidecar AX fixture in the test corpus.** Every AX fixture is
   hand-written with `AX`-prefixed roles, which is exactly why the role-prefix
   bug survived to production and produced zero predicates from real data. This
   is a derived requirement in the executor spec and the cheapest guard against
   that whole bug class recurring.
3. **Region coverage for the visual rung.** All region rows are `source: "ax"` —
   grid tiles score 0.5 against AX's 2–5 and never survive the 14-region budget
   in `fuse.ts`. Coverage is therefore inherited from the AX tree, so the visual
   rung is thinnest where AX is thin. How badly that bites is app-specific
   (5–8% of targets in TextEdit, 40% in Chrome). Note the proposal-only path does
   no cropping, so a larger budget is nearly free there.
4. **Subsystem #4, AI-in-the-loop.** Local Ollama model; `parseInterventionResponse`
   is already a security boundary and is tested.
5. **App wiring.** Nothing surfaces plans or replay in DeskRAGApp.

## Three things worth carrying over

**The anchor ladder was falsified twice, each time by one more application.** It
is now trust-ordered with `pathCeiling(depth)` rather than fixed. The decay
constants are fitted to **9 anchors** — the only ones carrying both a label and a
path. The *shape* (trust decays with path depth) is far better supported than any
constant. Do not simplify it back to a fixed order; that has been tried twice and
both orders were wrong for one AX implementation or another. More apps (Electron,
Qt, Java/Swing) would firm up the constants.

**Availability is not a ranking criterion.** AXIdentifier appears on 67% of AX
anchors in AppKit, 9% in Chromium, 20% in SwiftUI — and SwiftUI carries no usable
labels at all. Availability measures the application's AX implementation, not the
descriptor's reliability. The spec's first version got this wrong.

**The suite cannot post a real event, and that is enforced, not assumed.**
`test/replay.barrel.test.ts` asserts no file in `replay/` except `sidecar.ts`
mentions `spawn`/`child_process`. If a resolver, planner, or verifier ever needs
process access, that is a design smell — the `Actuator` seam exists for it.

## Caveat

`native/ax-exec` and `native/ax-dump` are gitignored. Run `npm run build:ax`
before recording or replaying anything: a stale `ax-dump` silently ignored
`--keymap`/`--displays` for two days here and every recording in that window lost
its typed text entirely.
