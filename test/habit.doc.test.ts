import { describe, expect, it } from "vitest";
import {
  briefFor,
  cautionsFor,
  MERGED_HEADING,
  mergedBody,
  recordedBlocks,
  renderHabitMarkdown,
  slugify,
  templateBody,
  type HabitDocInput,
} from "../app/src/main/habit-doc.js";
import { flowWalks } from "../app/src/main/flow-steps.js";
import type { FlowsDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

/**
 * The file, and the boundary inside it.
 *
 * A HABIT.md is prose above `## Recorded steps` and the record from there down.
 * The model writes only the prose, and that is enforced by construction:
 * `renderHabitMarkdown` concatenates prose-then-`recordedBlocks(...)`, and
 * `recordedBlocks` does not take a body, a prose object or a provider. The
 * adversarial case below is what makes that a measured property rather than a
 * sentence in a prompt.
 */

const node = (id: string, label: string, extra: Partial<GraphNodeDTO> = {}): GraphNodeDTO => ({
  id,
  label,
  chip: id,
  observations: 2,
  predicates: ["app(TextEdit)"],
  locatable: true,
  intervene: "none",
  rank: 0,
  sources: [],
  ...extra,
});

const edge = (
  id: string,
  from: string,
  to: string,
  extra: Partial<GraphEdgeDTO> = {},
): GraphEdgeDTO => ({
  id,
  from,
  to,
  actions: [],
  back: false,
  provenance: "recorded",
  observations: 2,
  // TWO sources for TWO observations. A count higher than the sources it can
  // point at is a real state — a recording deleted since — and leaving the
  // default fixture in it would fire that caution in every unrelated test.
  sources: [
    { sessionId: "s1", startedAt: 1_754_000_000_000, atSec: 2, throughSec: 6 },
    { sessionId: "s2", startedAt: 1_754_090_000_000, atSec: 3, throughSec: 7 },
  ],
  ...extra,
});

const SECRET = "hunter2-correct-horse";

function flows(): FlowsDTO {
  return {
    graph: {
      id: "g",
      entry: "n0",
      nodes: [
        node("n0", "Ghostty", { app: "Ghostty" }),
        node("n1", "Google Chrome — github.com/user/repo", { app: "Google Chrome" }),
      ],
      edges: [
        edge("e0", "n0", "n1", {
          actions: [
            { action: "click", target: 'Link "Issues"' },
            {
              action: "type",
              target: 'TextField "#issue_title"',
              slot: { name: "issue_title", samples: [SECRET, "second run"] },
            },
          ],
        }),
      ],
      slots: [{ name: "issue_title", samples: [SECRET, "second run"] }],
    },
    excludedApps: [],
    routes: [
      {
        id: "Ghostty → Google Chrome — github.com/user/repo",
        count: 2,
        label: "Ghostty → Google Chrome — github.com/user/repo",
        name: "file a bug report",
        nameObservations: 2,
        nodeIds: ["n0", "n1"],
        edgeIds: ["e0"],
        sessionIds: ["s1", "s2"],
        variants: [],
        walks: [
          { sessionId: "s1", edgeIds: ["e0"], atSec: 0, throughSec: 0 },
          { sessionId: "s2", edgeIds: ["e0"], atSec: 0, throughSec: 0 },
        ],
      },
    ],
  };
}

/**
 * A three-hop route walked three different ways.
 *
 * Timestamps are midday UTC on a Tuesday, Wednesday and Thursday ON PURPOSE:
 * `RhythmFacts` reads LOCAL time and the suite runs in whatever zone the machine
 * is in, so a ±14h shift must not be able to move the weekday. Midday mid-week
 * survives it; 23:00 on a Friday would not.
 */
const T_TUE = Date.UTC(2026, 2, 3, 12, 0, 0);
const DAY_MS = 86_400_000;

function divergent(): FlowsDTO {
  const mk = (
    id: string,
    from: string,
    to: string,
    sources: { sessionId: string; startedAt: number; atSec: number; throughSec: number }[],
  ): GraphEdgeDTO => ({
    id,
    from,
    to,
    actions: [],
    back: false,
    provenance: "recorded",
    observations: Math.max(1, sources.length),
    sources,
  });
  const at = (sessionId: string, day: number, atSec: number, throughSec: number) => ({
    sessionId,
    startedAt: T_TUE + day * DAY_MS,
    atSec,
    throughSec,
  });

  // THREE DISTINCT edge sequences, one recording each. That is what produces a
  // TIE, and the tie is what several assertions below are about — two
  // recordings walking the SAME sequence would be collapsed into one Way by
  // `flowWalks` and the majority rule would pick it outright.
  //
  //   s1 (Tue) e0,e1        — stops one step short
  //   s2 (Wed) e0,e3        — substitutes e3 for e1, then stops
  //   s3 (Thu) e0,e1,e2     — NEWEST, so the tiebreak makes it the standard
  return {
    graph: {
      id: "g",
      entry: "n0",
      nodes: [
        node("n0", "Calculator", { app: "Calculator" }),
        node("n1", "TextEdit", { app: "TextEdit" }),
        node("n2", "Finder", { app: "Finder" }),
      ],
      edges: [
        mk("e0", "n0", "n1", [at("s1", 0, 2, 6), at("s2", 1, 2, 5), at("s3", 2, 2, 6)]),
        mk("e1", "n1", "n2", [at("s1", 0, 8, 12), at("s3", 2, 8, 11)]),
        mk("e2", "n2", "n0", [at("s3", 2, 14, 18)]),
        mk("e3", "n1", "n0", [at("s2", 1, 9, 10)]),
      ],
      slots: [],
    },
    excludedApps: [],
    routes: [
      {
        id: "Calculator → TextEdit",
        count: 3,
        label: "Calculator → TextEdit",
        name: null,
        nameObservations: 0,
        nodeIds: ["n0", "n1", "n2"],
        edgeIds: ["e0", "e1", "e2", "e3"],
        sessionIds: ["s1", "s2", "s3"],
        variants: [],
        walks: [
          { sessionId: "s1", edgeIds: ["e0", "e1"], atSec: 2, throughSec: 12 },
          { sessionId: "s2", edgeIds: ["e0", "e3"], atSec: 2, throughSec: 10 },
          { sessionId: "s3", edgeIds: ["e0", "e1", "e2"], atSec: 2, throughSec: 18 },
        ],
      },
    ],
  };
}

/**
 * What the fixture aligns to, traced by hand so the assertions below are not
 * guesses. Baseline is s3's way `[e0, e1, e2]` (three Ways tie at one recording
 * each; the newest holds the tiebreak).
 *
 *   s1 [e0,e1]    e0 ok, e1 ok, e2 unreached  -> 1 skipped,               stops short
 *   s2 [e0,e3]    e0 ok, e1/e3 SUBSTITUTION,
 *                 e2 unreached                -> 2 skipped, 1 inserted,   stops short
 *   s3 [e0,e1,e2] exact                       -> followed the standard
 *
 * Durations on the baseline's steps: e0 has all three recordings, e1 has two
 * (s1, s3), e2 has one (s3). Step 2 is therefore the case where a recording is
 * OMITTED rather than given a zero.
 */

const rec = (f: FlowsDTO): string =>
  recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });

const docInput = (over: Partial<HabitDocInput> = {}): HabitDocInput => {
  const f = flows();
  return {
    flows: f,
    route: f.routes[0]!,
    slug: "file-a-bug-report",
    version: "0.1.0",
    title: "File a bug report",
    description: "Use when filing a GitHub issue.",
    body: "Some prose.\n\n## When to use\n\nWhen filing.",
    bodySource: "llm",
    bodyModel: "ollama qwen3:4b",
    showSamples: false,
    habitId: "01K3W8QF5T3M2Q7V6N0X4C1B8D",
    ...over,
  };
};

describe("frontmatter", () => {
  it("carries only name, description and metadata at the top level", () => {
    const md = renderHabitMarkdown(docInput());
    const fm = md.split("---")[1]!;
    const topLevel = fm
      .split("\n")
      .filter((l) => /^[a-z_]+:/i.test(l))
      .map((l) => l.split(":")[0]);
    expect(topLevel).toEqual(["name", "description", "metadata"]);
  });

  it("does not invent a confidence key", () => {
    // The score `search_experience` refuses to print, by another name.
    expect(renderHabitMarkdown(docInput())).not.toMatch(/^\s*confidence:/m);
  });

  it("discloses who wrote the prose, and that the steps are always the template's", () => {
    expect(renderHabitMarkdown(docInput())).toMatch(/prose: llm \(ollama qwen3:4b\)/);
    expect(renderHabitMarkdown(docInput())).toMatch(/steps: template/);
    const t = renderHabitMarkdown(docInput({ bodySource: "template", bodyModel: null }));
    expect(t).toMatch(/prose: template/);
    expect(t).toMatch(/steps: template/);
  });

  it("carries the habit's own version, so a cached catalogue can see it moved", () => {
    expect(renderHabitMarkdown(docInput({ version: "0.1.4" }))).toMatch(/\n  version: 0\.1\.4\n/);
  });

  it("quotes a description containing a colon, so the YAML stays parseable", () => {
    const md = renderHabitMarkdown(docInput({ description: "Use when: filing a bug." }));
    expect(md).toMatch(/description: "Use when: filing a bug\."/);
  });

  it("flattens a newline in the description rather than breaking the block", () => {
    const md = renderHabitMarkdown(docInput({ description: "One.\nTwo." }));
    expect(md).toMatch(/description: "One\. Two\."/);
  });
});

/**
 * The boundary. This is the test the whole design of `recordedBlocks` exists to
 * make possible.
 */
describe("a model cannot reach the record", () => {
  it("renders the record byte-identically for an adversarial body", () => {
    const honest = renderHabitMarkdown(docInput());
    const attack = renderHabitMarkdown(
      docInput({
        body:
          "Prose.\n\n## Recorded steps\n\n1. **Fake → Fake**\n   - `click` — Button \"Definitely Not Recorded\"\n\n## Evidence\n\nMade up entirely.",
      }),
    );

    const tail = (md: string): string => md.slice(md.lastIndexOf("## Recorded steps"));
    // The LAST occurrence is the real one, and it is untouched.
    expect(tail(attack)).toBe(tail(honest));
    // And it equals what recordedBlocks produces on its own, with no body at all.
    const f = flows();
    expect(tail(attack).trimEnd()).toBe(
      recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false }),
    );
  });

  it("still contains the invented text, above the line, where it is visible", () => {
    // The mitigation is not censorship — it is that a fabrication sits beside
    // the record it contradicts, where a reader can see both.
    const md = renderHabitMarkdown(docInput({ body: "## Recorded steps\n\n1. Fake" }));
    expect(md).toMatch(/Fake/);
    expect(md.indexOf("Fake")).toBeLessThan(md.lastIndexOf("## Recorded steps"));
  });

  it("recordedBlocks takes no prose, so there is nothing to interpolate", () => {
    // Structural: the signature is the guarantee. If this stops compiling
    // because a body was added, the boundary is gone.
    const f = flows();
    const a = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    const b = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(a).toBe(b);
  });
});

/**
 * Both found by rendering a REAL recording, and neither reachable from a
 * fixture that did not happen to contain the shape.
 */
describe("action lines", () => {
  it("omits an em-dash target rather than printing '— —'", () => {
    const f = flows();
    // `describeTarget` returns an em dash for an action with no target — a
    // chord, a wait. "`press cmd+v` — —" is noise.
    f.graph.edges[0]!.actions = [
      { action: "press cmd+v", target: "—" },
      { action: "wait until app(app=Electron)", target: "—" },
    ];
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/- `press cmd\+v`$/m);
    expect(md).not.toMatch(/— —/);
  });

  it("does not name the slot twice", () => {
    const f = flows();
    // `describeTarget` already renders a `type` target as "slot textarea".
    f.graph.edges[0]!.actions = [
      { action: "type", target: "slot textarea", slot: { name: "textarea", samples: ["a"] } },
    ];
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/- `type` — slot textarea$/m);
    expect(md).not.toMatch(/slot textarea — slot/);
  });
});

describe("dates", () => {
  /**
   * By DATE, never by millisecond. Two steps of one recording are minutes
   * apart, so an ms comparison is never equal — every single-day habit read
   * "between 2026-08-17 and 2026-08-17".
   */
  it("says 'on <date>' when a route was walked within one day", () => {
    const f = flows();
    f.graph.edges[0]!.sources = [
      { sessionId: "s1", startedAt: 1_754_000_000_000, atSec: 2, throughSec: 6 },
      { sessionId: "s2", startedAt: 1_754_000_000_000, atSec: 900, throughSec: 950 },
    ];
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).not.toMatch(/between (\d{4}-\d{2}-\d{2}) and \1/);
    expect(md).toMatch(/Recorded 2 times on \d{4}-\d{2}-\d{2}/);
  });
});

describe("recorded values", () => {
  it("names slots and withholds the values by default", () => {
    const md = renderHabitMarkdown(docInput());
    expect(md).toMatch(/`issue_title` — 2 recorded values, varies between recordings/);
    expect(md).not.toContain(SECRET);
    expect(md).toMatch(/recorded values are not printed/i);
  });

  it("prints them with the toggle on, and carries the warning IN THE FILE", () => {
    const md = renderHabitMarkdown(docInput({ showSamples: true }));
    expect(md).toContain(SECRET);
    // The file is the thing that gets pasted somewhere else, so the warning has
    // to travel with it rather than living in the UI that produced it.
    expect(md).toMatch(/may include anything that was typed, including a password/);
    expect(md).toMatch(/recorded_values: included/);
  });

  it("distinguishes a discovered variable from a value typed once", () => {
    const f = flows();
    f.graph.edges[0]!.actions[1]!.slot = { name: "issue_title", samples: ["only once"] };
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/1 recorded value \(typed once; not established as a variable\)/);
    expect(md).not.toMatch(/varies between recordings/);
  });

  it("says so when nothing was typed, rather than printing an empty list", () => {
    const f = flows();
    f.graph.edges[0]!.actions = [{ action: "click", target: 'Link "Issues"' }];
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/no recorded inputs/);
  });
});

describe("what this evidence does not say", () => {
  it("leads with 'recorded once' for a single walk", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    const c = cautionsFor(f, f.routes[0]!, flowWalks(f, f.routes[0]!));
    expect(c[0]).toMatch(/Recorded once/);
    expect(c[0]).toMatch(/nothing has confirmed it repeats/);
  });

  it("reports disagreement about the route's name", () => {
    const f = flows();
    f.routes[0]!.count = 4;
    f.routes[0]!.nameObservations = 2;
    expect(cautionsFor(f, f.routes[0]!, flowWalks(f, f.routes[0]!)).join("\n")).toMatch(
      /only 2 of those recordings agreed/,
    );
  });

  it("reports a step not every recording walked", () => {
    const f = flows();
    f.routes[0]!.count = 5;
    f.graph.edges[0]!.observations = 4;
    expect(cautionsFor(f, f.routes[0]!, flowWalks(f, f.routes[0]!)).join("\n")).toMatch(
      /Step 1 was in 4 of the 5 recordings/,
    );
  });

  it("reports a state that can be verified but never located", () => {
    const f = flows();
    f.graph.nodes[1]!.locatable = false;
    expect(cautionsFor(f, f.routes[0]!, flowWalks(f, f.routes[0]!)).join("\n")).toMatch(
      /identified only by which application was in front/,
    );
  });

  it("carries a lifting note through verbatim", () => {
    const f = flows();
    f.graph.edges[0]!.liftWarnings = ["dropped a wait whose predicate was already true"];
    expect(cautionsFor(f, f.routes[0]!, flowWalks(f, f.routes[0]!)).join("\n")).toMatch(
      /dropped a wait whose predicate was already true/,
    );
  });

  it("reports evidence deleted since", () => {
    const f = flows();
    f.graph.edges[0]!.observations = 3;
    f.graph.edges[0]!.sources = [
      { sessionId: "s1", startedAt: 1_754_000_000_000, atSec: 2, throughSec: 6 },
    ];
    f.routes[0]!.count = 3;
    expect(cautionsFor(f, f.routes[0]!, flowWalks(f, f.routes[0]!)).join("\n")).toMatch(
      /a recording it came from has been deleted/,
    );
  });

  /**
   * There is deliberately NO success-rate line. `TraceEdge.outcomes` is
   * {attempts: 0, successes: 0} on every graph on disk, so any such line would
   * be empty forever or invented.
   */
  it("never claims a step failed", () => {
    const f = flows();
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).not.toMatch(/success|attempts|failed \d/i);
  });

  it("omits the section entirely when there is nothing to caution about", () => {
    const md = recordedBlocks({ flows: flows(), route: flows().routes[0]!, showSamples: false });
    expect(md).not.toMatch(/## What this evidence does not say/);
  });

  it("says when a near-miss walk was folded into the route", () => {
    // The merge inflates `count`, so the count and the caveat must arrive
    // together — a route that says "recorded 3 times" while one of the three
    // detoured is the merge claiming more agreement than it found.
    const f = flows();
    const route = {
      ...f.routes[0]!,
      count: 3,
      variants: [
        {
          key: "TextEdit → Finder → TextEdit → Chrome",
          label: "TextEdit → Finder → TextEdit → Chrome",
          count: 1,
          extraHops: 2,
          sessionIds: ["s3"],
        },
      ],
    };
    const out = cautionsFor(f, route, flowWalks(f, route));
    expect(out.some((c) => /1 of the 3 recordings took 2 extra states/.test(c))).toBe(true);
    expect(out.some((c) => c.includes("TextEdit → Finder → TextEdit → Chrome"))).toBe(true);
  });

});

/**
 * The defect: `route.edgeIds` is the UNION of every recording's walk, documented
 * as the canvas highlight, and the renderer numbered it into a procedure.
 *
 * Measured on the real store: two recordings walked 8 edges each, shared 2, and
 * the file published a 14-step numbered list that neither recording ever walked.
 * The prose model then described the artifact accurately — "a second variant
 * repeats the entry and copy steps" — which is a true sentence about a bug.
 */
describe("recordings that did NOT take the same path", () => {
  /** Two walks sharing only their first edge, the real store's shape in little. */
  function diverged(): FlowsDTO {
    const f = flows();
    f.graph.nodes.push(node("n2", "TextEdit", { app: "TextEdit" }));
    f.graph.edges.push(
      edge("e1", "n1", "n2", { actions: [{ action: "click", target: 'Button "Save"' }] }),
      edge("e2", "n1", "n2", { actions: [{ action: "press cmd+s", target: "—" }] }),
    );
    const r = f.routes[0]!;
    r.edgeIds = ["e0", "e1", "e2"];
    r.walks = [
      { sessionId: "s1", edgeIds: ["e0", "e1"], atSec: 0, throughSec: 0 },
      { sessionId: "s2", edgeIds: ["e0", "e2"], atSec: 0, throughSec: 0 },
    ];
    return f;
  }

  it("renders each way separately instead of numbering the union", () => {
    const f = diverged();
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/### Way A — 2 steps, 1 recording/);
    expect(md).toMatch(/### Way B — 2 steps, 1 recording/);
    // Scoped to the steps section: `## Where the time goes` numbers the
    // baseline's steps too, and this assertion is about the procedure, not
    // about every numeral in the file.
    const steps = md.split("## What varies")[0]!;
    // The union has three edges; NO way is three steps long, so no "3." exists.
    expect(steps).not.toMatch(/^3\. /m);
    // Each way restarts at 1 — they are alternatives, not a continued sequence.
    expect(steps.match(/^1\. /gm)).toHaveLength(2);
  });

  it("tells the reader to follow ONE way, not all of them in sequence", () => {
    const f = diverged();
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/follow one of them, not all of them in sequence/i);
  });

  it("states the disagreement ONCE rather than once per step", () => {
    const f = diverged();
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    const cautions = md.split("## What this evidence does not say")[1] ?? "";
    // The bullet this replaces fired per-step: on the real store it printed
    // "Step N was in 1 of the 2 recordings" TWELVE times in eighteen bullets.
    expect(cautions).not.toMatch(/was in 1 of the 2 recordings/);
    expect(cautions).toMatch(/did NOT do this the same way/);
  });

  it("collapses recordings that DID walk the same path into one way", () => {
    // The healthy case, and the one every well-behaved route is in: no variant
    // heading at all, exactly what the file looked like before variants existed.
    const md = recordedBlocks({ flows: flows(), route: flows().routes[0]!, showSamples: false });
    expect(md).not.toMatch(/### Way /);
    expect(md).not.toMatch(/follow one of them/i);
  });

  it("gathers slots across every way, since a slot IS the disagreement", () => {
    const f = diverged();
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/`issue_title` — 2 recorded values/);
  });
});

describe("a missing edge", () => {
  it("is printed rather than skipped, in both the steps and the cautions", () => {
    const f = flows();
    // Into the WALKS, which is what renders steps. `edgeIds` is the canvas
    // highlight and no longer reaches a step list.
    for (const w of f.routes[0]!.walks) w.edgeIds = ["e0", "nope"];
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/edge `nope` is not in the graph/);
    expect(md).toMatch(/index defect/);
  });
});

describe("templateBody", () => {
  it("says it was not composed, rather than passing as written prose", () => {
    const f = flows();
    const t = templateBody(f, f.routes[0]!);
    expect(t.overview).toMatch(/generated from the recording rather than written by a model/);
  });

  /**
   * It says WHAT it is and never WHY.
   *
   * An earlier version claimed "No summary model was configured when this was
   * written", which was FALSE on a machine that had one — `acceptHabit` writes a
   * template body deliberately, so that keeping a proposal is instant. Asserting
   * a cause it cannot observe is the exact fabrication this file exists to
   * avoid, and no fixture could show it: it took a rendered habit printed beside
   * the settings it was rendered under.
   */
  it("does not claim WHY it is a template", () => {
    const f = flows();
    const t = templateBody(f, f.routes[0]!);
    expect(t.overview).not.toMatch(/no summary model/i);
    expect(t.overview).not.toMatch(/not configured|unavailable|could not/i);
  });

  it("is deterministic", () => {
    const f = flows();
    expect(templateBody(f, f.routes[0]!)).toEqual(templateBody(f, f.routes[0]!));
  });

  it("marks a single observation in the description an agent matches on", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    expect(templateBody(f, f.routes[0]!).description).toMatch(/Recorded once/);
  });
});

describe("briefFor", () => {
  it("carries variable names and counts, never a sample", () => {
    const f = flows();
    const brief = briefFor(f, f.routes[0]!);
    expect(JSON.stringify(brief)).not.toContain(SECRET);
    expect(brief.variables).toEqual([{ name: "issue_title", samples: 2 }]);
  });

  it("has no parameter by which samples could be requested", () => {
    // `showSamples` is deliberately not an argument: printing values is a
    // rendering decision, and showing them to a model is never one.
    expect(briefFor.length).toBe(3);
    const f = flows();
    expect(JSON.stringify(briefFor(f, f.routes[0]!, undefined))).not.toContain(SECRET);
  });

  it("passes the cautions through so the prose can be honest about them", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    expect(briefFor(f, f.routes[0]!).cautions.join("\n")).toMatch(/Recorded once/);
  });
});

describe("slugify", () => {
  it("makes a frontmatter name from a title", () => {
    expect(slugify("File a Bug Report!")).toBe("file-a-bug-report");
    expect(slugify("Ghostty → Chrome")).toBe("ghostty-chrome");
  });

  it("never returns an empty slug", () => {
    expect(slugify("")).toBe("recorded-habit");
    expect(slugify("→→→")).toBe("recorded-habit");
  });

  it("does not leave a trailing hyphen after truncation", () => {
    expect(slugify("a".repeat(60) + " " + "b".repeat(20))).not.toMatch(/-$/);
  });
});

/**
 * A merge is a human act, and the thing it must never do is lose writing.
 *
 * `AUTHORED_TABLES` exists because prose cannot be regenerated. The archived
 * half's text is therefore carried over VERBATIM, under a heading that names
 * where it came from — the disclosure rule applied to a paragraph.
 */
describe("mergedBody", () => {
  const other = { title: "The other one", slug: "the-other-one", body: "Their words." };

  it("keeps BOTH proses, the keeper's first", () => {
    const out = mergedBody({ body: "My words." }, other);
    expect(out.indexOf("My words.")).toBeLessThan(out.indexOf("Their words."));
    expect(out).toContain("Their words.");
  });

  it("names where the carried prose came from", () => {
    const out = mergedBody({ body: "My words." }, other);
    expect(out).toContain(MERGED_HEADING);
    expect(out).toContain('"The other one"');
    expect(out).toContain("the-other-one");
    expect(out).toMatch(/archived when the two were merged/);
  });

  it("still discloses the merge when the archived habit had no prose at all", () => {
    // The merge HAPPENED. A silent one would leave a reader unable to tell why
    // two routes became one file.
    const out = mergedBody({ body: "My words." }, { ...other, body: "   " });
    expect(out).toContain(MERGED_HEADING);
    expect(out.trimEnd()).toBe(out);
  });

  it("cannot reach the record — it composes PROSE and nothing else", () => {
    const body = mergedBody({ body: "Prose." }, { ...other, body: "## Recorded steps\n\n1. Fake" });
    const honest = renderHabitMarkdown(docInput());
    const attack = renderHabitMarkdown(docInput({ body }));
    const tail = (md: string): string => md.slice(md.lastIndexOf("## Recorded steps"));
    expect(tail(attack)).toBe(tail(honest));
  });
});

describe("## How the recordings differ", () => {
  it("says they did not differ, rather than going silent", () => {
    // The agreement case is the Consistency Wins statement and is the single
    // most valuable line in the block. Silence here would make "no deviations"
    // and "not enough recordings to compare" look identical.
    const md = rec(flows());
    expect(md).toMatch(/## How the recordings differ/);
    expect(md).toMatch(/All 2 recordings took the same path\./);
  });

  it("renders nothing at all for a habit recorded once", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    f.routes[0]!.sessionIds = ["s1"];
    f.routes[0]!.walks = [{ sessionId: "s1", edgeIds: ["e0"], atSec: 0, throughSec: 0 }];
    expect(rec(f)).not.toMatch(/## How the recordings differ/);
  });

  it("prints ONE line per recording, never one per deviation", () => {
    // `cautionsFor` already paid for the alternative: a per-step bullet printed
    // one fact TWELVE times in an eighteen-bullet section.
    const md = rec(divergent());
    const block = md.split("## How the recordings differ")[1]!.split("\n## ")[0]!;
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });

  it("carries Baseline.reason verbatim, so the file and the probe agree", () => {
    const md = rec(divergent());
    // Three ways, one recording each: a tie, decided by the newest walk.
    expect(md).toMatch(/Ways tie at 1 recording each; the standard is the one holding the newest walk\./);
  });

  it("warns that a tiebroken standard can move, and only on a tie", () => {
    expect(rec(divergent())).toMatch(/could become the standard as soon as one more is made/);
    expect(rec(flows())).not.toMatch(/could become the standard/);
  });

  it("names each recording by date, and counts what it did differently", () => {
    const md = rec(divergent());
    expect(md).toMatch(/- 2026-03-03 — 1 of the standard's steps not taken\./);
    expect(md).toMatch(/- 2026-03-04 — 1 step not in the standard, 2 of the standard's steps not taken\./);
  });

  it("says when a recording stopped before the end", () => {
    // s1 and s2 both stop short of the baseline's last step.
    const md = rec(divergent());
    const block = md.split("## How the recordings differ")[1]!.split("\n## ")[0]!;
    expect(block.match(/Stopped before the end\./g)).toHaveLength(2);
  });

  it("says a recording followed the standard when it did", () => {
    // s3 IS the baseline, so it can only agree with itself.
    expect(rec(divergent())).toMatch(/- 2026-03-05 — followed the standard\./);
  });

  it("names an undated recording by its session id rather than inventing a date", () => {
    const f = divergent();
    // Strip s3's only source, so nothing can date it.
    f.graph.edges = f.graph.edges.map((e) => ({
      ...e,
      sources: e.sources.filter((s) => s.sessionId !== "s3"),
    }));
    expect(rec(f)).toMatch(/- s3 — /);
  });

  it("prints no score, ratio or percentage", () => {
    const md = rec(divergent());
    expect(md).not.toMatch(/\d+%/);
    expect(md).not.toMatch(/consisten(t|cy) (score|rating)/i);
  });
});

describe("## Where the time goes", () => {
  it("gives each recording's own duration for each step", () => {
    // The fixture's one edge runs 2s→6s for s1 and 3s→7s for s2.
    const md = rec(flows());
    expect(md).toMatch(/## Where the time goes/);
    expect(md).toMatch(/4\.0s, 4\.0s/);
  });

  it("says these are durations and not targets, IN THE FILE", () => {
    // The file is the thing that gets pasted somewhere else — the same reason
    // the showSamples warning travels in the file rather than only in the UI.
    expect(rec(flows())).toMatch(/durations, not targets/);
  });

  it("renders nothing for a habit recorded once", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    f.routes[0]!.sessionIds = ["s1"];
    f.routes[0]!.walks = [{ sessionId: "s1", edgeIds: ["e0"], atSec: 0, throughSec: 0 }];
    expect(rec(f)).not.toMatch(/## Where the time goes/);
  });

  it("omits a recording that did not walk the step instead of writing a zero", () => {
    // Zero is a real duration. Only s1 and s2 walk e0, so its list has two
    // entries even though the route has three recordings.
    // The baseline's step 2 (e1) was walked by s1 and s3 but not s2, so its
    // list carries two durations for a route with three recordings.
    const md = rec(divergent());
    const block = md.split("## Where the time goes")[1]!.split("\n## ")[0]!;
    const second = block.split("\n").find((l) => l.startsWith("2. "))!;
    expect(second.match(/\d+\.\ds/g)).toHaveLength(2);
  });

  it("names the step by the places it moves between", () => {
    expect(rec(flows())).toMatch(/1\. Ghostty → Google Chrome — github\.com\/user\/repo — /);
  });

  it("reports the idle between steps separately from the steps", () => {
    // s1 and s3 both leave 2s between e0 ending and e1 starting.
    expect(rec(divergent())).toMatch(/idle before the next step: 2\.0s, 2\.0s/);
  });

  it("prints no total, no average and no fastest", () => {
    const md = rec(divergent());
    const block = md.split("## Where the time goes")[1]!.split("\n## ")[0]!;
    expect(block).not.toMatch(/total|average|mean|median|fastest|slowest/i);
  });
});

describe("## When it happens", () => {
  it("reports the weekday shape and an hour range", () => {
    // NOT a literal hour: RhythmFacts reads LOCAL time and the suite runs in
    // whatever zone the machine is in. The fixture's midday-mid-week timestamps
    // are what make the WEEKDAY half safe under a ±14h shift; the hour half is
    // asserted structurally for the same reason.
    const md = rec(divergent());
    expect(md).toMatch(/## When it happens/);
    expect(md).toMatch(/All 3 recordings on a weekday/);
    expect(md).toMatch(/(between \d\d:\d\d and \d\d:\d\d|around \d\d:\d\d) local time/);
  });

  it("reports the gaps between recordings", () => {
    expect(rec(divergent())).toMatch(/Gaps between them: 1 day, 1 day/);
  });

  it("states that the cue cannot be recovered, whenever the block renders", () => {
    // Measured: for all 3 recordings of the real store's only recurring route,
    // the sole application in front before the work is DeskRAG's own Recorder.
    // Without this paragraph an absent cue reads as "there was no cue".
    const md = rec(divergent());
    expect(md).toMatch(/recording starts when you press record/);
    expect(md).toMatch(/cannot be recovered/);
  });

  it("never claims what preceded the work", () => {
    const md = rec(divergent());
    expect(md).not.toMatch(/## What preceded it/);
    expect(md).not.toMatch(/after (Mail|Slack|Finder|DeskRAG|Electron)/i);
  });

  it("renders nothing when fewer than two recordings can be dated", () => {
    const f = divergent();
    f.graph.edges = f.graph.edges.map((e) => ({ ...e, sources: e.sources.slice(0, 1) }));
    f.routes[0]!.walks = [{ sessionId: "s1", edgeIds: ["e0"], atSec: 2, throughSec: 6 }];
    f.routes[0]!.sessionIds = ["s1"];
    f.routes[0]!.count = 1;
    expect(rec(f)).not.toMatch(/## When it happens/);
  });
});
