import { describe, expect, it } from "vitest";
import {
  briefFor,
  cautionsFor,
  MERGED_HEADING,
  mergedBody,
  recordedBlocks,
  renderSkillMarkdown,
  slugify,
  templateBody,
  type SkillDocInput,
} from "../app/src/main/skill-doc.js";
import { flowWalks } from "../app/src/main/flow-steps.js";
import type { FlowsDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

/**
 * The file, and the boundary inside it.
 *
 * A SKILL.md is prose above `## Recorded steps` and the record from there down.
 * The model writes only the prose, and that is enforced by construction:
 * `renderSkillMarkdown` concatenates prose-then-`recordedBlocks(...)`, and
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
          { sessionId: "s1", edgeIds: ["e0"] },
          { sessionId: "s2", edgeIds: ["e0"] },
        ],
      },
    ],
  };
}

const docInput = (over: Partial<SkillDocInput> = {}): SkillDocInput => {
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
    skillId: "01K3W8QF5T3M2Q7V6N0X4C1B8D",
    ...over,
  };
};

describe("frontmatter", () => {
  it("carries only name, description and metadata at the top level", () => {
    const md = renderSkillMarkdown(docInput());
    const fm = md.split("---")[1]!;
    const topLevel = fm
      .split("\n")
      .filter((l) => /^[a-z_]+:/i.test(l))
      .map((l) => l.split(":")[0]);
    expect(topLevel).toEqual(["name", "description", "metadata"]);
  });

  it("does not invent a confidence key", () => {
    // The score `search_experience` refuses to print, by another name.
    expect(renderSkillMarkdown(docInput())).not.toMatch(/^\s*confidence:/m);
  });

  it("discloses who wrote the prose, and that the steps are always the template's", () => {
    expect(renderSkillMarkdown(docInput())).toMatch(/prose: llm \(ollama qwen3:4b\)/);
    expect(renderSkillMarkdown(docInput())).toMatch(/steps: template/);
    const t = renderSkillMarkdown(docInput({ bodySource: "template", bodyModel: null }));
    expect(t).toMatch(/prose: template/);
    expect(t).toMatch(/steps: template/);
  });

  it("carries the skill's own version, so a cached catalogue can see it moved", () => {
    expect(renderSkillMarkdown(docInput({ version: "0.1.4" }))).toMatch(/\n  version: 0\.1\.4\n/);
  });

  it("quotes a description containing a colon, so the YAML stays parseable", () => {
    const md = renderSkillMarkdown(docInput({ description: "Use when: filing a bug." }));
    expect(md).toMatch(/description: "Use when: filing a bug\."/);
  });

  it("flattens a newline in the description rather than breaking the block", () => {
    const md = renderSkillMarkdown(docInput({ description: "One.\nTwo." }));
    expect(md).toMatch(/description: "One\. Two\."/);
  });
});

/**
 * The boundary. This is the test the whole design of `recordedBlocks` exists to
 * make possible.
 */
describe("a model cannot reach the record", () => {
  it("renders the record byte-identically for an adversarial body", () => {
    const honest = renderSkillMarkdown(docInput());
    const attack = renderSkillMarkdown(
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
    const md = renderSkillMarkdown(docInput({ body: "## Recorded steps\n\n1. Fake" }));
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
   * apart, so an ms comparison is never equal — every single-day skill read
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
    const md = renderSkillMarkdown(docInput());
    expect(md).toMatch(/`issue_title` — 2 recorded values, varies between recordings/);
    expect(md).not.toContain(SECRET);
    expect(md).toMatch(/recorded values are not printed/i);
  });

  it("prints them with the toggle on, and carries the warning IN THE FILE", () => {
    const md = renderSkillMarkdown(docInput({ showSamples: true }));
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
    expect(c[0]).toMatch(/not an established habit/);
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
      { sessionId: "s1", edgeIds: ["e0", "e1"] },
      { sessionId: "s2", edgeIds: ["e0", "e2"] },
    ];
    return f;
  }

  it("renders each way separately instead of numbering the union", () => {
    const f = diverged();
    const md = recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
    expect(md).toMatch(/### Way A — 2 steps, 1 recording/);
    expect(md).toMatch(/### Way B — 2 steps, 1 recording/);
    // The union has three edges; NO way is three steps long, so no "3." exists.
    expect(md).not.toMatch(/^3\. /m);
    // Each way restarts at 1 — they are alternatives, not a continued sequence.
    expect(md.match(/^1\. /gm)).toHaveLength(2);
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
   * written", which was FALSE on a machine that had one — `acceptSkill` writes a
   * template body deliberately, so that keeping a proposal is instant. Asserting
   * a cause it cannot observe is the exact fabrication this file exists to
   * avoid, and no fixture could show it: it took a rendered skill printed beside
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
    expect(slugify("")).toBe("recorded-skill");
    expect(slugify("→→→")).toBe("recorded-skill");
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

  it("still discloses the merge when the archived skill had no prose at all", () => {
    // The merge HAPPENED. A silent one would leave a reader unable to tell why
    // two routes became one file.
    const out = mergedBody({ body: "My words." }, { ...other, body: "   " });
    expect(out).toContain(MERGED_HEADING);
    expect(out.trimEnd()).toBe(out);
  });

  it("cannot reach the record — it composes PROSE and nothing else", () => {
    const body = mergedBody({ body: "Prose." }, { ...other, body: "## Recorded steps\n\n1. Fake" });
    const honest = renderSkillMarkdown(docInput());
    const attack = renderSkillMarkdown(docInput({ body }));
    const tail = (md: string): string => md.slice(md.lastIndexOf("## Recorded steps"));
    expect(tail(attack)).toBe(tail(honest));
  });
});
