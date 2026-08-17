/**
 * A kept route as a SKILL.md.
 *
 * The file has two halves and they are written by different things. Above
 * `## Recorded steps` is PROSE — a model's, or the template's. From that heading
 * down is the RECORD, rendered from the trace graph, and a model never touches
 * it.
 *
 * That split is enforced by construction, not by instruction:
 * `renderSkillMarkdown` calls `recordedBlocks()` and concatenates prose-then-
 * record, so there is no code path by which a model's string reaches the record.
 * `test/skill.doc.test.ts` asserts it with an adversarial body containing its own
 * `## Recorded steps` and a fake step list.
 *
 * Frontmatter carries `name`, `description` and `metadata:` and nothing else at
 * the top level. Surveyed across the 139 SKILL.md files installed on this
 * machine, those two are the only keys present in all of them, and `metadata` is
 * the sanctioned nested extension. An invented top-level `confidence:` would be
 * both non-standard and the exact number `search_experience` refuses to print.
 *
 * Pure: no store, no model, no Electron.
 */

import type { FlowRouteDTO, FlowsDTO } from "@shared/types";
import type { SkillBrief, SkillProse } from "deskrag";
import { flowApps, flowSteps, flowVariables, type FlowStep } from "./flow-steps.js";
import type { SkillBinding } from "./skill-bind.js";

/** Frontmatter `name`: lowercase, hyphens, and never empty. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s.length > 0 ? s : "recorded-skill";
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function stepAt(step: FlowStep): number | null {
  return step.firstAt === null ? null : step.firstAt.startedAt + step.firstAt.atSec * 1000;
}

/** Earliest and latest moment any step of this route was walked. */
function span(steps: readonly FlowStep[]): { first: number | null; last: number | null } {
  const times = steps.map(stepAt).filter((t): t is number => t !== null);
  if (times.length === 0) return { first: null, last: null };
  return { first: Math.min(...times), last: Math.max(...times) };
}

/**
 * What this evidence does not say.
 *
 * Every line here is a limit on the claim, and every one is a fact that actually
 * exists. `TraceEdge.outcomes` is deliberately absent: it is
 * `{attempts: 0, successes: 0}` on every graph on disk, because nothing
 * increments it and passive recording cannot observe a failure — the user did
 * the thing, so it succeeded. A "this step sometimes failed" section would have
 * been the strongest line in the file and would have been empty forever.
 */
export function cautionsFor(
  flows: FlowsDTO,
  route: FlowRouteDTO,
  steps: readonly FlowStep[],
): string[] {
  const out: string[] = [];

  if (route.count === 1) {
    out.push(
      "Recorded once. This is a single observation, not an established habit — one walk is not evidence that this is how the task is done.",
    );
  } else if (route.name !== null && route.nameObservations < route.count) {
    out.push(
      `Recorded ${route.count} times, but only ${route.nameObservations} of those recordings agreed on what it was for. Several recordings can share a shape and disagree about the purpose.`,
    );
  }

  for (const step of steps) {
    if (step.missing) {
      out.push(
        `Step ${step.index + 1} refers to an edge that is not in the graph (an index defect). It is named rather than skipped, because a step that vanished would make this read as shorter than it was.`,
      );
      continue;
    }
    if (!step.everyRecording) {
      out.push(
        `Step ${step.index + 1} was in ${step.observations} of the ${route.count} recordings. The others stopped before it or went another way.`,
      );
    }
    if (step.sourcesBelowObservations) {
      out.push(
        `Step ${step.index + 1} counts more observations than it can now point at: a recording it came from has been deleted.`,
      );
    }
    for (const w of step.liftWarnings) {
      out.push(`Lifting note on step ${step.index + 1}: ${w}`);
    }
  }

  // A node identified only by its application VERIFIES perfectly and LOCATES
  // never — every observation in that app satisfies it. An agent told to "go to
  // that state" cannot.
  const nodeById = new Map(flows.graph.nodes.map((n) => [n.id, n]));
  const vague = route.nodeIds.filter((id) => nodeById.get(id)?.locatable === false);
  if (vague.length > 0) {
    out.push(
      `${vague.length} of the ${route.nodeIds.length} states on this route are identified only by which application was in front. An agent can confirm it arrived in one, but cannot find it on screen.`,
    );
  }

  return out;
}

const varLine = (name: string, samples: readonly string[], showSamples: boolean): string => {
  const n = samples.length;
  if (!showSamples) {
    return n >= 2
      ? `- \`${name}\` — ${n} recorded values, varies between recordings`
      : `- \`${name}\` — 1 recorded value (typed once; not established as a variable)`;
  }
  const shown = samples.map((s) => `\n  - ${JSON.stringify(s)}`).join("");
  return n >= 2
    ? `- \`${name}\` — ${n} recorded values, varies between recordings${shown}`
    : `- \`${name}\` — 1 recorded value (typed once; not established as a variable)${shown}`;
};

export interface RecordedInput {
  flows: FlowsDTO;
  route: FlowRouteDTO;
  /** When true, print recorded keystrokes. Off by default; see the warning. */
  showSamples: boolean;
}

/**
 * The record: steps, what varies, what the evidence does not say, evidence.
 *
 * Generated from the graph and NOTHING ELSE. This function does not take prose,
 * a body, or a provider, which is what makes "a model cannot rewrite the record"
 * a property of the code rather than a promise in a prompt.
 */
export function recordedBlocks(input: RecordedInput): string {
  const { flows, route, showSamples } = input;
  const steps = flowSteps(flows, route);
  const out: string[] = [];

  out.push("## Recorded steps");
  out.push("");
  out.push(
    "Generated by DeskRAG from the recordings. Not written by a model, not editable, and not affected by anything above this line — this block is the record.",
  );
  out.push("");

  steps.forEach((step) => {
    if (step.missing) {
      out.push(
        `${step.index + 1}. **edge \`${step.edgeId}\` is not in the graph (index defect)**`,
        "",
      );
      return;
    }
    out.push(`${step.index + 1}. **${step.from} → ${step.to}**`);
    if (step.actions.length === 0) {
      out.push("   - (no actions recorded on this edge)");
    }
    for (const a of step.actions) {
      // Two things NOT to print. `describeTarget` returns an em dash for an
      // action with no target (a chord, a wait), and "`press cmd+v` — —" is
      // noise; and for a `type` the target already reads "slot textarea", so
      // appending the slot again said it twice. Both were only visible in a
      // rendered file — the fixtures had neither shape.
      const target = a.target === "—" || a.target === "" ? "" : ` — ${a.target}`;
      out.push(`   - \`${a.action}\`${target}`);
    }
    const walked =
      step.observations === 1 ? "walked once" : `walked by ${step.observations} recordings`;
    const at = stepAt(step);
    out.push("");
    out.push(`   *${walked}${at === null ? "" : ` · first at ${iso(at)}`}*`);
    out.push("");
  });

  const vars = flowVariables(steps);
  out.push("## What varies");
  out.push("");
  if (vars.length === 0) {
    out.push("Nothing was typed on this route, so it has no recorded inputs.");
  } else {
    out.push(
      "A slot exists because two recordings of this flow differed there — variation comes from recording the task twice, not from anything inventing it.",
    );
    out.push("");
    if (showSamples) {
      // The warning travels IN THE FILE, not only in the UI that produced it.
      // The file is the thing that gets pasted somewhere else.
      out.push(
        "Recorded values are printed below because this skill has “Show recorded values” turned on. They are verbatim keystrokes from the recordings and may include anything that was typed, including a password.",
      );
    } else {
      out.push(
        "The recorded values are not printed. Turn on “Show recorded values” for this skill if you need them.",
      );
    }
    out.push("");
    for (const v of vars) out.push(varLine(v.name, v.samples, showSamples));
  }
  out.push("");

  const cautions = cautionsFor(flows, route, steps);
  if (cautions.length > 0) {
    out.push("## What this evidence does not say");
    out.push("");
    for (const c of cautions) out.push(`- ${c}`);
    out.push("");
  }

  const { first, last } = span(steps);
  out.push("## Evidence");
  out.push("");
  const times = route.count === 1 ? "once" : `${route.count} times`;
  const between =
    first === null || last === null
      ? ""
      : iso(first) === iso(last)
        ? ` on ${iso(first)}`
        : `, between ${iso(first)} and ${iso(last)}`;
  out.push(`Recorded ${times}${between}, on this machine.`);
  if (route.sessionIds.length > 0) {
    out.push(`Recordings: ${route.sessionIds.join(", ")}`);
  }
  out.push(`Route: ${route.id}`);

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export interface SkillDocInput {
  flows: FlowsDTO;
  route: FlowRouteDTO;
  slug: string;
  title: string;
  description: string;
  /** The PROSE half only. Emitted strictly above `## Recorded steps`. */
  body: string;
  bodySource: "llm" | "template";
  /** "ollama qwen3:4b", or null when the template wrote it. */
  bodyModel: string | null;
  showSamples: boolean;
  skillId: string;
}

/** YAML-safe scalar: quoted, with embedded quotes and newlines neutralised. */
function yamlString(s: string): string {
  return JSON.stringify(s.replace(/\r?\n/g, " ").trim());
}

/**
 * The whole file.
 *
 * Order is load-bearing: frontmatter, then prose, then `recordedBlocks(...)`
 * verbatim. The body is interpolated once, above, and never parsed — so a body
 * that contains its own `## Recorded steps` produces a document with two such
 * headings, of which the LAST is still the real one, byte for byte.
 */
export function renderSkillMarkdown(input: SkillDocInput): string {
  const { route, flows } = input;
  const steps = flowSteps(flows, route);
  const { first, last } = span(steps);
  const apps = flowApps(flows, route);

  const meta: string[] = [
    "metadata:",
    "  source: deskrag",
    `  skill_id: ${input.skillId}`,
    `  recordings: ${route.count}`,
    `  step_count: ${route.edgeIds.length}`,
  ];
  if (first !== null && last !== null) {
    meta.push(
      iso(first) === iso(last)
        ? `  recorded_on: ${iso(first)}`
        : `  recorded_between: ${iso(first)} / ${iso(last)}`,
    );
  }
  if (apps.length > 0) meta.push(`  apps: ${yamlString(apps.join(", "))}`);
  meta.push(
    `  prose: ${input.bodySource === "llm" ? `llm (${input.bodyModel ?? "unknown model"})` : "template"}`,
  );
  // ALWAYS template, and stated rather than implied: it is the one line that
  // tells a reader which half of this file a model could have invented.
  meta.push("  steps: template");
  meta.push(`  route: ${yamlString(route.id)}`);
  if (input.showSamples) meta.push("  recorded_values: included");

  const out: string[] = [
    "---",
    `name: ${input.slug}`,
    `description: ${yamlString(input.description)}`,
    ...meta,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body.trim(),
    "",
    recordedBlocks({ flows, route, showSamples: input.showSamples }),
    "",
  ];
  return out.join("\n");
}

/**
 * The deterministic body, for a default install with no summary model.
 *
 * It says what it is rather than pretending to be written: a reader who cannot
 * tell whether prose was composed or rolled up cannot weigh it, which is the
 * `source: llm | template` rule applied to a paragraph instead of a row.
 */
export function templateBody(flows: FlowsDTO, route: FlowRouteDTO): SkillProse {
  const steps = flowSteps(flows, route);
  const { first, last } = span(steps);
  const apps = flowApps(flows, route);
  const name = route.name ?? route.label;
  // By DATE, never by millisecond. Two steps of one recording are minutes
  // apart, so an ms comparison is never equal and every single-day skill read
  // "between 2026-08-17 and 2026-08-17".
  const when =
    first === null || last === null
      ? ""
      : iso(first) === iso(last)
        ? ` on ${iso(first)}`
        : ` between ${iso(first)} and ${iso(last)}`;

  const times = route.count === 1 ? "once" : `${route.count} times`;
  return {
    title: name,
    description:
      route.count === 1
        ? `Use when you need to ${name}. Recorded once, so this is one observation rather than an established habit.`
        : `Use when you need to ${name}. Recorded ${route.count} times${apps.length > 0 ? ` across ${apps.join(", ")}` : ""}.`,
    // It says WHAT it is, never WHY. An earlier version claimed "no summary
    // model was configured", which was false on a machine that had one —
    // `acceptSkill` writes a template body deliberately, so that a keep is
    // instant. Asserting a cause it cannot observe is the exact fabrication this
    // file exists to avoid, and it was invisible until the probe printed a
    // rendered skill beside the settings it was rendered under.
    overview:
      `DeskRAG recorded this flow ${times}${when}. This description is generated from the ` +
      `recording rather than written by a model — press “Generate with model” for prose. ` +
      `The steps below are the record either way.`,
    whenToUse:
      `The recordings passed through: ${route.label}.` +
      (apps.length > 0 ? ` Applications involved: ${apps.join(", ")}.` : ""),
  };
}

/**
 * What a model is told about this route.
 *
 * **Names and counts, never a sample.** Whether the rendered file prints
 * recorded values is a per-skill toggle; whether the model sees them is not a
 * toggle, it is never — `showSamples` is deliberately not a parameter here.
 */
export function briefFor(
  flows: FlowsDTO,
  route: FlowRouteDTO,
  binding?: SkillBinding,
): SkillBrief {
  const steps = flowSteps(flows, route);
  const { first, last } = span(steps);
  const cautions = cautionsFor(flows, route, steps);
  if (binding?.note != null) cautions.push(binding.note);

  return {
    routeLabel: route.label,
    routeName: route.name,
    recordings: route.count,
    firstRecorded: first === null ? "unknown" : iso(first),
    lastRecorded: last === null ? "unknown" : iso(last),
    apps: flowApps(flows, route),
    steps: steps.map((s) =>
      s.missing
        ? `(edge ${s.edgeId} is not in the graph)`
        : `${s.from} → ${s.to}: ${s.actions.map((a) => `${a.action} ${a.target}`).join("; ") || "no actions recorded"}`,
    ),
    variables: flowVariables(steps).map((v) => ({ name: v.name, samples: v.samples.length })),
    cautions,
  };
}
