Can DeskRAG turn indexed experiences into a set of skills (markdown) consumable by other agents like Claude Code?

Key findings from the code:

1. DeskRAG already has multiple "text projection" surfaces that are close to skills:
    - get_recording_outline / renderOutline — hierarchical prose (SESSION→PROCESS→TASK→ACTION). This is a "what was this for" summary.
    - get_flow / renderFlow — "recorded route as step-by-step procedural text." This is the closest thing to a SKILL: a named, repeated task with steps, variables (slots), and "how many times."
    - buildDigest — per-segment structured text.
    - printGraph (trace/language.ts) — a lossless, round-trippable text form of the whole graph, with predicates, actions, waits, slots.
    - MCP tools already serve these to external agents (read-only).

   So the raw material for "skill markdown" ALREADY EXISTS as prose. Two of the six MCP tools (list_flows, get_flow) are literally "here are your repeated tasks, step by step, with variables."

2. Skills (Claude Code) format: A skill is a markdown file, typically SKILL.md with a frontmatter (name, description) and a body of procedural instructions. Agent Skills = a directory with SKILL.md, optionally with supporting      
   files. The key question is how to generate these from recordings.

3. What's available as source material:
    - Routed graph: frequentRoutes groups recordings that walked similar state sequences, names them from composed summaries, counts how many times, discovers slots (variables) by comparing recordings.
    - Trace IR: nodes (states with predicates), edges (action sequences with waits, guards, outcomes = attempts/successes), slots (variables with samples), provenance (which recordings).
    - Composed hierarchy: session/process/task summaries (llm or template), the "purpose."
    - Per-segment digests/captions/transcripts.
    - Keyframes (images) with pHash + highlights.
    - AX snapshots (UI elements).

4. The strongest candidate for a "skill" is a Flow/route: it's a named, repeated procedure with:
    - a goal (route.name from composed summary)
    - preconditions (entry node predicates — which app/state you start in)
    - a sequence of steps (edges → actions: click Button "X", type into slot, wait for Y)
    - variables (slots with samples — "recipient", "url")
    - postcondition (terminal node predicates / outcome — did it succeed?)
    - frequency (count — evidence this is a genuine habit, not one-off)
    - "how it was actually done" — this is the killer differentiator: it's grounded in what the user ACTUALLY did, not a generic how-to.

5. How to turn it into SKILL.md: A new projection renderSkill(graph, route) that writes frontmatter + a body. The body could be:
    - Description (goal + when to use it — derived from route name + when the user did it)
    - Preconditions: which app/state you need to be in
    - Steps: numbered, in human words (describeAction/describeTarget already do this), with waits as "wait until..."
    - Variables/inputs: the slots
    - "Watch for": guards, warnings, and critically the outcome data (attempts vs successes) — a flow that sometimes failed, and the branch that succeeded.
    - Optional attachments: keyframes as reference images, a --plan executable via ax-exec (the executor!).

6. The deepest possible thing: the trace graph is machine-executable. The IR + executor (src/replay/) means a skill isn't just prose — it could ship as a playable skill: SKILL.md (the human/agent-readable prose) PLUS a serialized  
   graph + a plan that an agent could run via ax-exec with dry-run/arm gate. That's "skill as executable behavior." But per CLAUDE.md, the executor has no UI and is read-only-by-construction from the app; a skill that runs it      
   would be a new surface. Worth brainstorming but flag the safety boundary.

7. Feasibility / hard constraints to respect (from the invariants):
    - Skills must degrade gracefully: a flow recorded once is "not a habit" (renderFlow already says "Recorded once"). A skill from one observation is weak evidence.
    - Templates vs LLM summaries (source): disclose. A skill whose summary is a template rollup is lower confidence than one a model wrote or the user named.
    - No fabrication: gaps in capture (no keymap → no typed text; no AX → point-only anchors) must show as "unknown" / "needs input," not guessed. This is the repo's core ethic.
    - Scores are not confidences; ranking is relative. A skill's "confidence" should come from count + lane agreement + outcome ratio, not a number.
    - Privacy: typed text is NOT redacted (by design). Skills would carry whatever was typed. Some slots are secret: false always (secure-field content recorded verbatim). This is a real consideration for shipping skills to other  
      agents — the whole "local, never leaves your machine" property is in tension with "consumed by other agents." Flag this.
    - Anchors are point-with-display: a skill captured on a 2560px display and run on a 1440px display drifts. The IR resolves ax→visual→point at replay, so a skill should prefer AX anchors and mark point-only steps as brittle     
      (isLocatable, outcomes).
    - Skills should be keyed by the label sequence (what frequentRoutes proves is the only key that finds repetition), NOT by summaries (nondeterministic) or node/edge ids.

8. Design decisions:
    - Where to generate: a new pure module (src/trace/skill.ts or app-side app/src/main/mcp/skill.ts) that reuses graph-view + flow-text + outline. It stays a leaf / pure, root-tested, like everything else.
    - What triggers a skill: a route with count ≥ 2 (a genuine repeated task) OR a user-named route. Offer a "catalog" of skills (one file per route) + an index.
    - Format: Claude Code Agent Skills = SKILL.md with YAML frontmatter (name, description). Body = goal, preconditions, steps, inputs, gotchas, optional executable.
    - Discovery for the consuming agent: two paths — (a) ship a static folder of SKILL.md files the agent loads, (b) keep it live: a generative MCP tool get_skill(routeId) returning the markdown, and list_skills. This mirrors      
      list_flows/get_flow exactly.

Let me also verify whether "Claude Code skills" format is what user means — they said "skills (markdown), that could be consumed by other agents like Claude Code." So they mean the Agent Skills / SKILL.md format. I'll frame around
that.

Let me think about the layered design I'll propose — from "easily possible, small" to "ambitious":

Tier A — Skill = rendered flow (already 90% built). get_flow's output is nearly a skill body. Package it as SKILL.md. Add frontmatter, a "when to use" from route.name + the app/predicates, a "gotchas" from                          
liftWarnings/guards/outcomes. This is a pure render module, reuses everything, root-testable. This is the "yes, trivially feasible" answer.

Tier B — Skill catalog + synthesis. Not just per-route, but cluster routes into a coherent skill (a skill might span multiple routes / be a process-level summary). Use composed process/task summaries as skill names, route steps as
the procedure. This is where the hierarchy earns its keep.

Tier C — Executable skill. Ship the IR + a plan so the skill can be run, not just read. SKILL.md prose + a sibling plan.json/graph and an invocation of ax-exec in dry-run. Biggest value (agent literally replaying your behavior),   
biggest safety surface.

Tier D — Adaptive / retrieved skills. Instead of a static catalog, the consuming agent asks DeskRAG via MCP "have I done X?" and gets a freshly generated skill + screenshot + evidence. This is basically the current MCP server      
re-pointed; the skill is generated on demand and cited (provenance → frameId → get_moment screenshot). Ties retrieval to generation.

I should also discuss:
- The honest-evidence discipline that makes this BETTER than generic how-to skills: count, lane agreement, outcomes, source disclosure, gap-as-unknown, never-fabricate.
- The privacy/security tension (local-only vs consume-by-others; unredacted typed text; secret slots; no token on MCP).
- The brittleness/replay reality (point anchors, display scale, the executor's dry-run/arm gate).
- Where in the architecture it plugs in (a pure projection leaf, like outline.ts/flow-text.ts; optionally a new MCP tool; optionally a build:export script).
- What would need building vs what exists (the prose 90% exists; what's missing is: frontmatter/when-to-use assembly, clustering into a coherent skill, an outcomes/gotchas section, an index/catalog, and the executable wrapper).

Let me also note the retrieval→skill link: skills should be generated from evidence and citable back to it. That's the distinctive property.

Now, one nuance: I should double check the "frontmatter" and Claude Code skills format. Agent Skills (Claude) use SKILL.md with YAML frontmatter: name, description, and body. Skills live in a directory. There's also Anthropic's    
"skills" with progressive disclosure. I'll keep it accurate but not over-claim specifics; I'll note the general shape.

I don't need to modify anything. Let me write a thorough but well-organized brainstorm. Given CLAUDE.md's culture (measurements, honesty, provenance, no-fabrication, disclose source), I should write in that register. I'll keep it  
grounded and concrete, referencing the actual modules.

Let me structure the answer:
1. Short verdict: yes, and much of the raw material already exists.
2. What deskrag already produces that a skill needs (map each skill component to an existing surface).
3. Three tiers of ambition.
4. The distinctive advantage (citable, evidence-grounded, honest).
5. The hard problems / risks / things that would need deciding (privacy, brittleness, fabrication, format).
6. Where it plugs in architecturally.
7. Open questions for the user.

I'll keep it focused and not too long, but rich. Let me write it.

Actually, let me reconsider format length. The user wants a brainstorm — exploration of possibility and how. I'll give a substantial but scannable response. I won't create files. Let me write it as prose with structure.

Let me make sure I reference the actual mechanism names accurately:
- frequentRoutes groups by label sequence; nameRoute from composed summaries; slots are discovered variables; count = sessions; outcomes {attempts, successes} on edges.
- renderFlow already emits procedural text with steps, targets, slots, "walked N times."
- renderOutline for the hierarchy/prose.
- printGraph lossless round-trip.
- MCP list_flows/get_flow are the live "skill discovery" analogues.
- Executor src/replay/ + ax-exec, dry-run/arm.
- isLocatable marks brittle nodes; REACH_BY_KIND achievable/assertable = postconditions that can/can't be guaranteed.
- source: llm|template disclosure.
- No-redaction of typed text by design; secret: false slots; no MCP token.

Good. Writing now.

I've now read the load-bearing pieces: the dual store, the trace IR, the lift/merge pipeline, the composed hierarchy, the two existing prose renderers (outline.ts, flow-text.ts), the digest, and the live MCP surface. Here's my     
exploration — no files touched.

Verdict

Yes — and a surprising amount of the raw material already exists as prose. The question isn't "can DeskRAG express a skill in markdown"; two of its six MCP tools (list_flows, get_flow) essentially already generate a step-by-step   
description of a repeated task, and a third (get_recording_outline) renders the whole session hierarchy top-to-bottom. What's missing is the packaging and a couple of synthesis steps, not the source.

A skill already has every part — mapped to existing surfaces

A Claude Code skill (SKILL.md: frontmatter + a procedural body) has five components. Each maps onto something on disk or in a pure projection today:

┌────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐                                 
│ Skill part             │ Already exists as…                                                                                                                                                        │                                 
├────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤                                 
│ Goal / "when to use"   │ route.name, from nameRoute() — a route's name is a vote over its recordings' composed summaries (the process/task that covered the walk). list_flows prints this already. │                                 
├────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤                                 
│ Preconditions          │ The entry node's predicates (app, url, ax_focused…). "You start in Calculator" / "you start at github.com/…/pull/."                                                       │                                 
├────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤                                 
│ Steps                  │ renderFlow() already emits Step N — From ⟶ To with describeAction/describeTarget ("3× click", Button "Send"). This is a skill body in disguise.                           │                                 
├────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤                                 
│ Inputs / variables     │ graph.slots — discovered by recording a task twice, not declared. renderFlow already prints slot "recipient": "alice@…", "bob@…" — varies between recordings.             │                                 
├────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤                                 
│ Success / gotchas      │ Edge outcomes {attempts, successes}, guard predicates, liftWarnings. Not currently printed — this is the gap worth filling.                                               │                                 
├────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤                                 
│ Frequency / confidence │ route.count (n recordings "agreed"), and the retrieval lane-agreement idea from search_experience.                                                                        │                                 
├────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤                                 
│ Visual reference       │ Node visual → frameBlobId → pHash, servable as a keyframe image (get_moment).                                                                                             │                                 
├────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤                                 
│ Executable form        │ The whole graph is a lossless, round-trippable IR (printGraph), and src/replay/ + ax-exec can run it.                                                                     │                                 
└────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

The single most important realization: get_flow output is ~90% of a skill body, today. Adding YAML frontmatter, a "when to use" line, and a gotchas section closes most of the distance.

Three tiers of ambition

Tier A — "Skill = rendered flow." A new pure module, say skill.ts, sitting next to outline.ts/flow-text.ts (a leaf, root-testable, no store). It takes a FlowRouteDTO/Graph and writes SKILL.md:

 ```markdown                                                                                                                                                                                                                            
   ---                                                                                                                                                                                                                                  
   name: file a bug report on github                                                                                                                                                                                                    
   description: Opened 5×. You're in GitHub on a repo; file an issue.                                                                                                                                                                   
   confidence: 5 recordings, llm-named, 4/5 steps always succeeded                                                                                                                                                                      
   ---                                                                                                                                                                                                                                  
   ## When to use                                                                                                                                                                                                                       
   In Google Chrome, on github.com/<repo>. You mean to file, not just browse.                                                                                                                                                           
   ## Preconditions                                                                                                                                                                                                                     
   - app = Google Chrome, url = github.com/…  (reached by: navigate / click repo link)                                                                                                                                                  
   ## Steps                                                                                                                                                                                                                             
   1. From "PR #39" ⟶ "Issues":  click Button "Issues"                                                                                                                                                                                  
   2. From "Issues" ⟶ "New issue":  press Cmd+I                                                                                                                                                                                         
   3. type into slot `title`                                                                                                                                                                                                            
   4. wait until ax_exists(Heading "Title")                                                                                                                                                                                             
   ## Inputs                                                                                                                                                                                                                            
   - `title`: "Fix crash on …", "Race in …"   (varies)                                                                                                                                                                                  
   - `body`: …  (varies)                                                                                                                                                                                                                
   ## Watch for                                                                                                                                                                                                                         
   - Step 2 sometimes failed 1/5 times → then …                                                                                                                                                                                         
   ## Evidence                                                                                                                                                                                                                          
   Recorded 2026-08-09 / 08-09 / 08-11. See frames f… , f…                                                                                                                                                                              
 ```                                                                                                                                                                                                                                    

This is nearly free: reuses toGraphDTO, labelNode, describeAction/Target, slots, and frequentRoutes' label-sequence key (the one key that actually finds repetition — graph-view.ts measured that edge-id and node-id keys both split  
5 identical recordings into 9 distinct ×1 routes; the label sequence collapsed them to 5).

Tier B — "Skill catalog + synthesis." Not just per-route, but cluster a coherent process into one skill that may span several routes. The composed level:1/level:2 summaries already name these phases, so a skill's name is a process
summary and its steps are the route(s) that walk it. Add a catalog index (one file per skill, plus a SKILLS.md manifest), generated by a build:skills script analogous to gen:brand. Decisions a human should make: which routes       
become skills (count ≥ 2? user-named? a "promote" gesture), and whether a skill is one route or a bundle.

Tier C — "Executable skill." Ship the IR alongside the prose so the skill can run, not just be read. SKILL.md + a sibling graph/plan the consuming agent invokes through ax-exec, which already has a dry-run→arm gate. Biggest value  
(an agent literally replaying your behavior), biggest surface — see risks.

Tier D — "Retrieved, on-demand skills." Skip the static catalog: the consuming agent keeps a live link to DeskRAG's MCP server and asks get_skill(query) → a freshly generated skill with its screenshot and provenance, citable back  
to frameId → get_moment. This is basically the current read-only server re-pointed at skill generation, and it makes the citable-back-to-evidence property first-class.

The distinctive advantage (why this beats a generic how-to)

Generic skills are invented knowledge. A DeskRAG skill is evidence about what you actually did, and the code is already disciplined for exactly the honest-evidence properties that make an agent trust it:

- Frequency, not fiat. route.count plus "N of N recordings agreed on the name"; renderFlow already says "One recording is not a habit."
- Source disclosure. Every summary carries source: llm | template — a skill can honestly say "this procedure's name was rolled up structurally, not written by a model," so the consuming agent can weight it.
- No fabrication at the gaps. No keymap ⇒ no typed text; no AX ⇒ a point-only anchor. The IR's whole ethic is omit rather than guess. A skill should carry the same: ## Unknowns: step 3's target is a bare coordinate — verify before
  running.
- Outcome data. outcomes {attempts, successes} and guards give a "watch for / it sometimes failed" section no generic author has.
- Citation. Every node/edge carries sources (session + t_mono), so a skill can name which recordings and which frames back it — the one thing that separates "I did this" from "here's how people do it."

Two honesty rules the repo already enforces that a naive skill generator would break, and that I'd preserve:
- Name a skill by its label sequence, never by a summary. nameRoute is careful — summaries are nondeterministic across re-index, so keying identity on them would rename the skill every rebuild.
- Confidence is count + lane agreement, never a score. search_experience already refuses to print a number because the best hit of any query lands at 1.000; a skill "confidence: 0.87" would be the exact misreport it's avoiding.

The real risks / things to decide

1. Privacy is in direct tension with "other agents." DeskRAG's core property is local, never leaves your machine; the MCP server has no token on purpose, and typed text is not redacted by design (buildDigest folds it in). A skill  
   shipped to another agent (or another machine) would carry verbatim typed content — emails, code, secrets. Slot.secret is false by construction today. This is a genuine fork: stay local (generate skills read by a local agent),   
   and accept that typed text is unredacted — or build redaction, which the system currently refuses to do.
2. Replay is honest about brittleness — so should the skill. Point anchors drift across display resolutions/scaling; the IR resolves ax → visual → point and isLocatable marks the fragile ones, REACH_BY_KIND marks which             
   postconditions are assertable (can't be guaranteed) vs achievable. A skill that claims it "just works" when 3 of 8 nodes are app-only and unlocatable would be lying. The executable tier is where the dry-run/arm gate earns its   
   keep.
3. The executor has no UI and is guarded. test/replay.barrel.test.ts structurally forbids src/replay/ from posting events, and ax-exec is read-out-of-band by design. An executable skill is a new surface past a deliberately-drawn   
   line — a deliberate act, not a refactor.
4. Template- vs LLM-named skills need to be visibly different, or a structurally-rolled-up procedure masquerades as a curated one.
5. Format target is external. Claude Code / Agent Skills = a SKILL.md with YAML frontmatter + body, discoverable by a client. Confirm the exact frontmatter the target agent expects before freezing a schema.

Where it plugs in, respecting the seams

- A pure projection leaf (src/trace/skill.ts or app/src/main/mcp/skill.ts), root-testable like outline.ts/flow-text.ts — takes FlowRouteDTO/Graph + injected resolvers, returns text. No store, no native module.
- Optionally a new MCP tool pair list_skills / get_skill mirroring list_flows/get_flow (stays read-only, stays behind test/mcp.readonly.test.ts).
- Optionally a build:skills generation script (scripts/, like gen:brand) for the static-catalog path.
- Do not touch frequentRoutes' key, the source disclosure, or the redaction decision to improve anything — the docs show three times that tweaks here measure as noise or break an invariant.  