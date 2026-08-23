/**
 * A kept route as a HABIT.md.
 *
 * The file has two halves and they are written by different things. Above
 * `## Recorded steps` is PROSE — a model's, or the template's. From that heading
 * down is the RECORD, rendered from the trace graph, and a model never touches
 * it.
 *
 * That split is enforced by construction, not by instruction:
 * `renderHabitMarkdown` calls `recordedBlocks()` and concatenates prose-then-
 * record, so there is no code path by which a model's string reaches the record.
 * `test/habit.doc.test.ts` asserts it with an adversarial body containing its own
 * `## Recorded steps` and a fake step list.
 *
 * Frontmatter carries `name`, `description` and `metadata:` and nothing else at
 * the top level. Surveyed across the 139 HABIT.md files installed on this
 * machine, those two are the only keys present in all of them, and `metadata` is
 * the sanctioned nested extension. An invented top-level `confidence:` would be
 * both non-standard and the exact number `search_experience` refuses to print.
 *
 * Pure: no store, no model, no Electron.
 */

import type { FlowRouteDTO, FlowsDTO } from "@shared/types";
import type { HabitBrief, HabitProse } from "deskrag";
import {
  allSteps,
  flowApps,
  flowVariables,
  flowWalks,
  variantLetter,
  type FlowStep,
  type FlowStepAction,
  type FlowWalk,
} from "./flow-steps.js";
import type { HabitBinding } from "./habit-bind.js";
import { runPhrase, secs, wayFork, type WayFork } from "./way-fork.js";
import {
  walkAnalysis,
  type PrefixFact,
  type RhythmFacts,
  type StepCost,
  type WalkAnalysis,
  type WalkFit,
} from "./walk-analysis.js";

/**
 * Re-exported from its new home in `flow-steps.ts`, which owns `FlowWalk.index`.
 * It moved because `way-fork.ts` needs it and this file imports `way-fork.ts`.
 */
export { variantLetter } from "./flow-steps.js";

/** Frontmatter `name`: lowercase, hyphens, and never empty. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s.length > 0 ? s : "recorded-habit";
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
  walks: readonly FlowWalk[],
  /**
   * Routes whose places are a strict PREFIX of this one's — the same work begun
   * and abandoned partway.
   *
   * Passed in rather than computed here, and OPTIONAL so no existing caller
   * moves. A's committed carry-over: the fact reaches `get_habit` before any
   * pixel exists, because both the record and the model's brief already read
   * this function.
   */
  droppedEarly: readonly PrefixFact[] = [],
): string[] {
  const out: string[] = [];
  const many = walks.length > 1;
  const where = (w: FlowWalk, step: FlowStep): string =>
    many ? `Way ${variantLetter(w.index)} step ${step.index + 1}` : `Step ${step.index + 1}`;

  if (route.count === 1) {
    out.push(
      "Recorded once. Kept from a single observation, and nothing has confirmed it repeats — one walk is not evidence that this is how the task is done.",
    );
  } else if (route.name !== null && route.nameObservations < route.count) {
    out.push(
      `Recorded ${route.count} times, but only ${route.nameObservations} of those recordings agreed on what it was for. Several recordings can share a shape and disagree about the purpose.`,
    );
  }

  // A merged near-miss is a claim about the recording count, so it is stated
  // wherever that count is. `route.count` includes the variants' recordings —
  // saying "recorded 3 times" without saying that one of the three took a
  // different path would be the merge asserting more agreement than it found.
  for (const v of route.variants) {
    const hops =
      v.extraHops < 0
        ? "a different path through the same places"
        : `${v.extraHops} extra ${v.extraHops === 1 ? "state" : "states"}`;
    out.push(
      `${v.count} of the ${route.count} recordings took ${hops} and were folded into this route: ` +
        `${v.label}. They are counted here because they start and end in the same place and pass ` +
        `through everything below in order — not because anything checked that the detour was ` +
        `incidental.`,
    );
  }

  // The headline when a route is not one procedure. It replaces a per-step
  // bullet that fired on nearly every step of every variant: on the real store,
  // "Step N was in 1 of the 2 recordings" appeared TWELVE times in an
  // eighteen-bullet section, which is one fact printed twelve times. Inside a
  // variant that fact is not news — every recording of a variant walked all of
  // its steps by construction — so it is stated once, about the route.
  if (many) {
    const shape = walks.map((w) => `${w.steps.length}`).join(" and ");
    out.push(
      `The ${route.count} recordings did NOT do this the same way. They are shown below as ` +
        `${walks.length} separate ways of ${shape} steps — follow ONE of them, not all of them in ` +
        `sequence. They share this route only because they passed through the same applications ` +
        `in the same order, which is a coarse key; it is not evidence that they are one procedure.`,
    );
  }

  for (const w of walks) {
    for (const step of w.steps) {
      if (step.missing) {
        out.push(
          `${where(w, step)} refers to an edge that is not in the graph (an index defect). It is named rather than skipped, because a step that vanished would make this read as shorter than it was.`,
        );
        continue;
      }
      // Only worth saying when there is ONE way: with variants, "not every
      // recording did this" is what having variants already means.
      if (!many && !step.everyRecording) {
        out.push(
          `Step ${step.index + 1} was in ${step.observations} of the ${route.count} recordings. The others stopped before it or went another way.`,
        );
      }
      if (step.sourcesBelowObservations) {
        out.push(
          `${where(w, step)} counts more observations than it can now point at: a recording it came from has been deleted.`,
        );
      }
      for (const w2 of step.liftWarnings) {
        // NOT lower-cased: "way a step 7" reads as a typo, and only a rendered
        // file showed it — `where` returns a sentence-initial label.
        out.push(`Lifting note on ${where(w, step)}: ${w2}`);
      }
    }
  }

  // An action anchored to a bare screen coordinate is unusable by an agent and
  // drifts with display resolution. The states version of this caution is
  // directly below; measured on the real store, 9 of 53 actions were points and
  // the file said nothing, printing them in the same voice as the 35 that carry
  // an AX target.
  // By DISTINCT EDGE, never by flattened variant step: an edge two ways share is
  // printed twice but recorded once, and counting it twice inflated the
  // denominator against the real store (54 where the graph holds 53).
  const seenEdges = new Set<string>();
  const acts: FlowStepAction[] = [];
  for (const w of walks) {
    for (const st of w.steps) {
      if (st.missing || seenEdges.has(st.edgeId)) continue;
      seenEdges.add(st.edgeId);
      acts.push(...st.actions);
    }
  }
  const points = acts.filter((a) => /^point \(/.test(a.target)).length;
  if (points > 0) {
    out.push(
      `${points} of the ${acts.length} recorded actions are anchored to a bare screen coordinate rather than to an element. Those cannot be located by an agent, and they were recorded on this machine's display — they drift on a different resolution.`,
    );
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

  // A DISCLOSURE, in the shape of `duplicates`, and never a merge: `route.count`
  // is untouched and nothing is folded in. DeskRAG's route partition gives every
  // recording exactly one route key, which is what makes `bindHabit`'s
  // strict-majority rule a proof rather than a threshold — and it is also why
  // abandonment is invisible from the full route's side without this line.
  for (const p of droppedEarly) {
    const n = p.count;
    out.push(
      `This work was started and dropped early ${n} further time${n === 1 ? "" : "s"}: ` +
        `${n === 1 ? "a recording" : `${n} recordings`} went as far as ${p.places.join(" → ")} ` +
        `and stopped. Those are not counted among the ${route.count} above.`,
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

/** A recording's name in a record block: its date, or its id when nothing can date it. */
const walkName = (w: WalkFit): string => (w.at === null ? w.sessionId : iso(w.at));

/**
 * Where the ways fork.
 *
 * REPLACES `## How the recordings differ`, and nothing is lost. That block
 * reported per-RECORDING deviation counts against a baseline which, on the real
 * store, is chosen by tiebreak and moves between runs; this names which
 * recordings took each way directly and needs no standard at all. Keeping both
 * would print one fact twice — `cautionsFor` already paid for that shape once,
 * printing one fact TWELVE times in an eighteen-bullet section.
 *
 * The agreement sentence is preserved verbatim, for `differBlock`'s own stated
 * reason: going silent when they all did the same thing would make that
 * indistinguishable from nothing having been measured.
 */
function forkBlock(fork: WayFork | null, count: number): string[] {
  if (count < 2) return [];
  if (fork === null) {
    return ["## Where the ways fork", "", `All ${count} recordings took the same path.`, ""];
  }

  const out = [
    "## Where the ways fork",
    "",
    "The numbered steps are the part every way has in common. The indented lines are where they differ — a way with nothing indented under a step did only that step there.",
    "",
  ];
  for (const w of fork.ways) {
    const n = w.sessionIds.length;
    const times = w.totalsMs.length === 0 ? "no timed recording" : w.totalsMs.map(secs).join(", ");
    out.push(
      `- **Way ${w.letter}** — ${w.steps} step${w.steps === 1 ? "" : "s"}, ` +
        `${n === 1 ? "1 recording" : `${n} recordings`}, ${times}`,
    );
  }
  out.push("");

  const letterOf = new Map(fork.ways.map((w) => [w.wayIndex, w.letter]));
  let n = 0;
  for (const row of fork.rows) {
    if (row.kind === "spine") {
      n += 1;
      out.push(`${n}. **${row.from} → ${row.to}**`);
      continue;
    }
    for (const run of row.runs) {
      if (run.steps.length === 0) continue;
      const letter = letterOf.get(run.wayIndex) ?? String(run.wayIndex);
      // A leading fork has no numbered step to sit under, so it is a top-level
      // bullet. Everything else indents beneath the step it followed.
      const indent = row.after < 0 ? "- " : "   - ";
      out.push(`${indent}Way ${letter}: ${runPhrase(run, row.after)}`);
    }
  }

  out.push("");
  out.push(fork.verdict.kind === "named" ? fork.verdict.text : fork.verdict.reason);
  out.push("");
  return out;
}

/**
 * Each recording's own time on each step.
 *
 * A step's duration is its OWN span (`throughSec - atSec` from that recording's
 * `EdgeSourceDTO`), never the gap to the next step — differencing consecutive
 * starts folds the idle before the next step into this one's cost and hides the
 * hesitation. The idle is reported separately, and only when some of it is
 * non-zero: a tight sequence should not carry a row of noughts.
 *
 * `StepCost.stepIndex` indexes the BASELINE Way's steps, so the label is read
 * from that Way directly rather than looked up from the graph. One lookup fewer
 * is also one drift hazard fewer: `walk-analysis.ts` has its own `edgeLabel`,
 * and two functions naming one edge is the `ax-dump`/`ax-exec` shape.
 */
function timeBlock(
  steps: readonly StepCost[],
  baseWay: FlowWalk | undefined,
  letter: string,
): string[] {
  if (baseWay === undefined) return [];
  const rows = steps.filter((s) => s.durations.length > 0);
  if (rows.length === 0) return [];

  // EVERY row holding exactly one duration is the normal case on a real store
  // and it is not obvious from the output: the comma list reads like a
  // comparison. Measured — the ways share no steps, so a step's durations can
  // only ever come from the recordings of the ONE way it belongs to.
  const single = rows.every((r) => r.durations.length === 1);

  const out = [
    "## Where the time goes",
    "",
    `These are Way ${letter}'s steps, each with its own recorded span. They are durations, not targets.` +
      (single
        ? " Every step below was walked by one recording each, so these are observations rather than a comparison."
        : ""),
    "",
  ];
  for (const cost of rows) {
    const step = baseWay.steps[cost.stepIndex];
    const label =
      step === undefined || step.missing
        ? `edge \`${cost.edgeId}\` is not in the graph`
        : `${step.from} → ${step.to}`;
    out.push(`${cost.stepIndex + 1}. ${label} — ${cost.durations.map((d) => secs(d.ms)).join(", ")}`);
    if (cost.gapsAfter.some((g) => g.ms > 0)) {
      out.push(`   *idle before the next step: ${cost.gapsAfter.map((g) => secs(g.ms)).join(", ")}*`);
    }
  }
  out.push("");
  return out;
}

/** Sat and Sun as `Date#getDay` numbers them. Local, like everything in `RhythmFacts`. */
const WEEKEND = new Set([0, 6]);

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A gap in whole days, or in hours when it is under one. */
const gapText = (ms: number): string => {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"}`;
};

/**
 * When the work happens, and why nothing says what preceded it.
 *
 * The second paragraph is the POINT of this block, not a footnote. A's
 * `AntecedentFact` anticipated an app cue reached through `antecedentAt`, and
 * against the real store the naive implementation is wrong in a way no corpus
 * growth fixes: for all three recordings of the only recurring route, the only
 * application in front before the work begins is DeskRAG's own Recorder. That is
 * structural — a recording begins when you press record, so the cue happens
 * before the evidence exists — and reporting it would violate "the recorder is
 * not part of the work it records". Excluding it, as that invariant requires,
 * leaves null every time. So the block says so, because an absent cue and an
 * unobservable one are different facts.
 *
 * Weekday-shape and an hour RANGE are the two statements this data supports.
 * Anything sharper ("every Tuesday at 9") needs a corpus this library does not
 * have, and is C's rhythm strip to draw rather than this file's to assert.
 */
function rhythmBlock(rhythm: RhythmFacts): string[] {
  const n = rhythm.days.length;
  if (n < 2) return [];

  const weekend = rhythm.days.filter((d) => WEEKEND.has(d)).length;
  const shape =
    weekend === 0
      ? "on a weekday"
      : weekend === n
        ? "at the weekend"
        : `on ${n - weekend} weekday${n - weekend === 1 ? "" : "s"} and ${weekend} weekend day${weekend === 1 ? "" : "s"}`;

  const lo = Math.min(...rhythm.hours);
  const hi = Math.max(...rhythm.hours);
  const when =
    rhythm.hours.length === 0
      ? ""
      : lo === hi
        ? `, around ${pad2(lo)}:00 local time`
        : `, between ${pad2(lo)}:00 and ${pad2(hi + 1)}:00 local time`;

  const out = ["## When it happens", "", `All ${n} recordings ${shape}${when}.`];
  if (rhythm.intervalsMs.length > 0) {
    out.push(`Gaps between them: ${rhythm.intervalsMs.map(gapText).join(", ")}.`);
  }
  out.push(
    "",
    "The application in front beforehand cannot be recovered: recording starts when you press record, so a recording contains no evidence of what preceded it.",
    "",
  );
  return out;
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
  const walks = flowWalks(flows, route);
  const many = walks.length > 1;
  const out: string[] = [];

  out.push("## Recorded steps");
  out.push("");
  out.push(
    "Generated by DeskRAG from the recordings. Not written by a model, not editable, and not affected by anything above this line — this block is the record.",
  );
  out.push("");

  // ONE way is the healthy case and renders exactly as it always did: no
  // heading, no letter, just the numbered procedure. The variant machinery
  // appears only when the recordings actually disagreed, so a route walked five
  // times the same way is unchanged byte for byte.
  if (many) {
    out.push(
      `The ${route.count} recordings did not take the same path. Each way below is a complete ` +
        `walk that a recording actually made — **follow one of them, not all of them in sequence.**`,
    );
    out.push("");
  }

  walks.forEach((walk) => {
    if (many) {
      const n = walk.sessionIds.length;
      out.push(
        `### Way ${variantLetter(walk.index)} — ${walk.steps.length} steps, ` +
          `${n === 1 ? "1 recording" : `${n} recordings`}`,
      );
      out.push("");
    }
    walk.steps.forEach((step) => {
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
      // Inside a variant the step's own observation count is still the graph's,
      // not the variant's: an edge shared with another way was genuinely walked
      // by more recordings than this way has, and saying otherwise would
      // undercount real evidence.
      const walked =
        step.observations === 1 ? "walked once" : `walked by ${step.observations} recordings`;
      const at = stepAt(step);
      out.push("");
      out.push(`   *${walked}${at === null ? "" : ` · first at ${iso(at)}`}*`);
      out.push("");
    });
  });

  const vars = flowVariables(allSteps(walks));
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
        "Recorded values are printed below because this habit has “Show recorded values” turned on. They are verbatim keystrokes from the recordings and may include anything that was typed, including a password.",
      );
    } else {
      out.push(
        "The recorded values are not printed. Turn on “Show recorded values” for this habit if you need them.",
      );
    }
    out.push("");
    for (const v of vars) out.push(varLine(v.name, v.samples, showSamples));
  }
  out.push("");

  // The projection needs exactly `flows` and `route`, which this function already
  // holds — so it is computed HERE rather than passed in. A `WalkAnalysis`
  // parameter would be the first crack in the property this signature exists to
  // guarantee: `recordedBlocks` takes no body, no prose and no provider, and
  // that is what makes "a model cannot rewrite the record" structural.
  const analysis = walkAnalysis({ flows, route });
  out.push(...forkBlock(wayFork({ flows, route }), route.count));

  const baseIndex = analysis.baseline.wayIndex;
  const baseWay = baseIndex === null ? undefined : walks[baseIndex];
  // Only when there is a second recording to read a duration AGAINST. One
  // recording's timings are a fact about one afternoon, not about a habit.
  if (route.count > 1 && baseIndex !== null) {
    out.push(...timeBlock(analysis.steps, baseWay, variantLetter(baseIndex)));
  }

  out.push(...rhythmBlock(analysis.rhythm));

  const cautions = cautionsFor(flows, route, walks, analysis.droppedEarly);
  if (cautions.length > 0) {
    out.push("## What this evidence does not say");
    out.push("");
    for (const c of cautions) out.push(`- ${c}`);
    out.push("");
  }

  const { first, last } = span(allSteps(walks));
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

export interface HabitDocInput {
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
  habitId: string;
  /** `0.1.0` on a doc written before versioning. Rendered, never computed here. */
  version: string;
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
export function renderHabitMarkdown(input: HabitDocInput): string {
  const { route, flows } = input;
  const walks = flowWalks(flows, route);
  const { first, last } = span(allSteps(walks));
  const apps = flowApps(flows, route);

  const meta: string[] = [
    "metadata:",
    "  source: deskrag",
    `  habit_id: ${input.habitId}`,
    // The artifact's own version. It moves when the FILE moves — an edit, a
    // regeneration, a re-bind, or the record changing underneath it — so an
    // agent that cached this catalogue can see that it did.
    `  version: ${input.version}`,
    `  recordings: ${route.count}`,
    // The union's length is not a step count — it is the size of a highlight
    // set. When the recordings walked one path it is the same number; when they
    // did not, it counts steps no single recording ever took.
    `  step_count: ${walks.map((w) => w.steps.length).join(" / ")}`,
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

/** The heading a merged habit's prose is appended under. Named once. */
export const MERGED_HEADING = "## Also written for this route";

/**
 * The keeper's prose after a merge, with the archived habit's appended.
 *
 * A merge NEVER discards prose. `AUTHORED_TABLES` exists because a person's
 * writing is the one thing in this repo nothing can regenerate, so the losing
 * half is carried over verbatim under a heading naming where it came from,
 * and the habit it came from is archived rather than deleted.
 *
 * Prose only, and only the prose HALF: the record below `## Recorded steps` is
 * re-rendered from the live route either way, and both habits answer to the
 * same route — which is what made them duplicates.
 */
export function mergedBody(
  keep: { readonly body: string },
  other: { readonly title: string; readonly slug: string; readonly body: string },
): string {
  const provenance =
    `The text below was written for a separate habit, ${JSON.stringify(other.title)} ` +
    `(\`${other.slug}\`), which described this same recorded route. That habit was ` +
    `archived when the two were merged; nothing here has been re-checked.`;
  const carried = other.body.trim();
  return [
    keep.body.trim(),
    "",
    MERGED_HEADING,
    "",
    provenance,
    ...(carried === "" ? [] : ["", carried]),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * The deterministic body, for a default install with no summary model.
 *
 * It says what it is rather than pretending to be written: a reader who cannot
 * tell whether prose was composed or rolled up cannot weigh it, which is the
 * `source: llm | template` rule applied to a paragraph instead of a row.
 */
export function templateBody(flows: FlowsDTO, route: FlowRouteDTO): HabitProse {
  const walks = flowWalks(flows, route);
  const { first, last } = span(allSteps(walks));
  const apps = flowApps(flows, route);
  const name = route.name ?? route.label;
  // By DATE, never by millisecond. Two steps of one recording are minutes
  // apart, so an ms comparison is never equal and every single-day habit read
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
        ? `Use when you need to ${name}. Recorded once, so nothing has confirmed yet that it repeats.`
        : `Use when you need to ${name}. Recorded ${route.count} times${apps.length > 0 ? ` across ${apps.join(", ")}` : ""}.`,
    // It says WHAT it is, never WHY. An earlier version claimed "no summary
    // model was configured", which was false on a machine that had one —
    // `acceptHabit` writes a template body deliberately, so that a keep is
    // instant. Asserting a cause it cannot observe is the exact fabrication this
    // file exists to avoid, and it was invisible until the probe printed a
    // rendered habit beside the settings it was rendered under.
    overview:
      `DeskRAG recorded this flow ${times}${when}. This description is generated from the ` +
      `recording rather than written by a model. The steps below are the record either way.` +
      (walks.length > 1
        ? ` The recordings did not take the same path, so the record shows ${walks.length} separate ways — follow one of them, not all of them in sequence.`
        : ""),
    whenToUse:
      `The recordings passed through: ${route.label}.` +
      (apps.length > 0 ? ` Applications involved: ${apps.join(", ")}.` : ""),
  };
}

/**
 * The consistency facts a model may state.
 *
 * COUNTS, and deliberately not the per-recording breakdown the record carries:
 * the model is writing four short prose fields, and handing it three lines per
 * recording invites it to narrate the ledger instead of describing the work.
 */
function consistencyFacts(analysis: WalkAnalysis, count: number): string[] {
  if (count < 2 || analysis.baseline.wayIndex === null || analysis.walks.length < 2) return [];
  const deviant = analysis.walks.filter((w) => w.deviations.length > 0 || !w.reachedEnd).length;
  const out = [
    deviant === 0
      ? `All ${analysis.walks.length} recordings took the same path.`
      : `${deviant} of the ${analysis.walks.length} recordings took a different path from the standard.`,
  ];
  const days = analysis.rhythm.days;
  if (days.length >= 2 && days.every((d) => d !== 0 && d !== 6)) {
    out.push("Every recording was made on a weekday.");
  }
  return out;
}

/**
 * What a model is told about this route.
 *
 * **Names and counts, never a sample.** Whether the rendered file prints
 * recorded values is a per-habit toggle; whether the model sees them is not a
 * toggle, it is never — `showSamples` is deliberately not a parameter here.
 */
export function briefFor(
  flows: FlowsDTO,
  route: FlowRouteDTO,
  binding?: HabitBinding,
  /**
   * The reflection written after each recording this route was built from.
   *
   * Passed IN rather than read here, because this module is pure and a
   * reflection lives in the store. Empty is the normal case: on a default
   * install nothing writes one, and no recording indexed before the stage
   * existed has one either.
   */
  reflections: readonly string[] = [],
): HabitBrief {
  const walks = flowWalks(flows, route);
  const many = walks.length > 1;
  const { first, last } = span(allSteps(walks));
  const analysis = walkAnalysis({ flows, route });
  const cautions = cautionsFor(flows, route, walks, analysis.droppedEarly);
  if (binding?.note != null) cautions.push(binding.note);

  // The variant is carried IN the step line rather than as a new `HabitBrief`
  // field, so the barrel type does not widen for it. It has to be carried
  // somehow: handed a flat concatenation of two different walks, the model
  // described the concatenation accurately — "a second variant repeats the entry
  // and copy steps" — which is a true sentence about a defect, and exactly the
  // output this change exists to stop it having to write.
  const line = (w: FlowWalk, st: FlowStep): string => {
    const head = many ? `Way ${variantLetter(w.index)} — ` : "";
    return st.missing
      ? `${head}(edge ${st.edgeId} is not in the graph)`
      : `${head}${st.from} → ${st.to}: ${st.actions.map((a) => `${a.action} ${a.target}`).join("; ") || "no actions recorded"}`;
  };

  return {
    routeLabel: route.label,
    routeName: route.name,
    recordings: route.count,
    firstRecorded: first === null ? "unknown" : iso(first),
    lastRecorded: last === null ? "unknown" : iso(last),
    apps: flowApps(flows, route),
    steps: walks.flatMap((w) => w.steps.map((st) => line(w, st))),
    variables: flowVariables(allSteps(walks)).map((v) => ({
      name: v.name,
      samples: v.samples.length,
    })),
    cautions,
    consistency: consistencyFacts(analysis, route.count),
    reflections: [...reflections],
  };
}
