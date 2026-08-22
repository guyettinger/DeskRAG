/**
 * The prose half of a HABIT.md, and only the prose half.
 *
 * A habit file has two parts and they are written by different things. The
 * RECORD — the steps, what varies, the cautions, the evidence — is rendered from
 * the trace graph by a template and is never model-written. The PROSE — a title,
 * a description, an overview, and when to use it — is what a model is for,
 * because the frontmatter `description` is what decides whether an agent ever
 * LOADS the habit, and the alternative is a mechanical join of route labels.
 * (`nameRoute` cannot fill that gap: it votes by exact string match, so four
 * recordings agreeing semantically about what a task was report as 1-of-4.)
 *
 * This module is the seam between the two, and it is drawn so the model
 * physically cannot cross it: `HabitProse` has four string fields and none of
 * them is a step. A provider that wanted to rewrite the record has nowhere to
 * put it.
 *
 * `SummaryProvider.compose` is NOT the right shape to reuse. It partitions a
 * list and names the parts — one act, deliberately — where this takes a whole
 * brief and returns prose about it. Bending one into the other would give the
 * composer a second reply shape to validate.
 *
 * Barrel-safe: an interface, a deterministic fake, and two pure functions. The
 * Ollama adapter in `ollama-habit-prose.ts` is barrel-safe too (plain fetch).
 */

import { firstJsonObject } from "./json-reply.js";

/**
 * What the model is told about a route.
 *
 * **Slot NAMES and counts only — never a sample.** Recorded typing is verbatim
 * and unredacted by design (`Slot.secret` is `false` by construction), and a
 * habit is a document that gets pasted elsewhere, which makes it a different
 * exposure from a search result the user is looking at. Whether the RENDERED
 * file prints recorded values is a per-habit toggle; whether the MODEL sees them
 * is not a toggle, it is never. One fewer place a typed password can travel, and
 * `test/habit.prose.test.ts` asserts it.
 */
export interface HabitBrief {
  /** The route's place sequence — "Ghostty → Google Chrome → github.com/…". */
  routeLabel: string;
  /** What the composed hierarchy called it, or null when no level qualified. */
  routeName: string | null;
  /** How many recordings walked this exact route. One is not a habit. */
  recordings: number;
  /** ISO dates, for "recorded between". Equal when there is only one. */
  firstRecorded: string;
  lastRecorded: string;
  /** The applications involved, in the order they were reached. */
  apps: string[];
  /** The recorded steps as plain lines — the record, for context only. */
  steps: string[];
  /** Discovered variables. `samples` is a COUNT, never the values. */
  variables: { name: string; samples: number }[];
  /** What the evidence does not say, already in words. */
  cautions: string[];
  /**
   * The reflection written after each recording this route was built from —
   * what the session was for, what stalled, what order would have been better.
   *
   * Model-written text, fed back to a model, which is why it arrives in its own
   * field and is labelled as an opinion in the prompt rather than mixed into
   * `steps`. It exists so the prose can say what went WRONG: the steps record
   * what happened and are silent about whether it went well, so without this a
   * habit can only ever describe a task as though it went smoothly. Empty on a
   * default install, and on any recording indexed before reflections existed.
   */
  reflections: string[];
}

/**
 * What comes back. Four fields, and none of them is a step.
 *
 * `title` and `description` become the frontmatter an agent matches on;
 * `overview` and `whenToUse` become the two prose sections. Everything else in
 * the file is rendered from the graph.
 */
export interface HabitProse {
  title: string;
  description: string;
  overview: string;
  whenToUse: string;
}

export interface HabitProseProvider {
  readonly id: string;
  readonly model: string;
  /**
   * May return anything. Implementations THROW rather than guess when the daemon
   * is unreachable or the reply is torn; the caller catches and takes the
   * template path, exactly as the composer does. Same split as
   * `SummaryProvider.compose`.
   */
  write(brief: HabitBrief): Promise<HabitProse>;
}

export const HABIT_SYSTEM =
  "You write the prose for a HABIT.md file describing something this user has " +
  "actually done on their own computer, recorded and replayed back to you as a " +
  "list of steps. You are writing for another AI agent that may carry the task " +
  "out later.\n" +
  "Write about what the steps SHOW. Do not add a step, a keyboard shortcut, a " +
  "menu, a URL or a tool that is not in the list you are given — the steps are " +
  "the record and are published beside your text, where anything you invented " +
  "will be visible. If the record is thin, say less.\n" +
  "Never guess what a variable contained: you are given names and counts on " +
  "purpose, and the values are withheld.\n" +
  'Reply with JSON only: {"title":"...","description":"...","overview":"...",' +
  '"whenToUse":"..."}. `title` is a short noun phrase naming the task. ' +
  "`description` is ONE sentence beginning \"Use when\" — it is how an agent " +
  "decides whether to load this file at all, so it must say the situation, not " +
  "the mechanics. `overview` is two or three sentences on what this accomplishes. " +
  "`whenToUse` is a short paragraph on the conditions that make it the right " +
  "move, and anything about the recorded route worth knowing first. No preamble.";

/** The brief as the user turn. Deterministic, so a test can pin it exactly. */
export function habitPrompt(b: HabitBrief): string {
  const out: string[] = [];
  out.push(
    b.recordings === 1
      ? "Recorded ONCE. Kept from a single observation, and nothing has confirmed it repeats — say so rather than describing it as something the user routinely does."
      : `Recorded ${b.recordings} times, between ${b.firstRecorded} and ${b.lastRecorded}.`,
  );
  if (b.routeName !== null) out.push(`The recordings were composed under the name: ${b.routeName}`);
  out.push(`States passed through: ${b.routeLabel}`);
  if (b.apps.length > 0) out.push(`Applications: ${b.apps.join(", ")}`);

  out.push("", "Steps:");
  b.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));

  if (b.variables.length > 0) {
    out.push("", "Variables (names and how many distinct values were recorded; the values themselves are withheld):");
    // The count IS the evidence: two or more samples is a discovered variable,
    // which is what recording a task twice produces. One is a value that
    // happened to be typed, and calling it a variable would overstate it.
    for (const v of b.variables) {
      out.push(
        v.samples >= 2
          ? `- ${v.name}: ${v.samples} distinct values — varies between recordings`
          : `- ${v.name}: 1 value, typed once — not established as a variable`,
      );
    }
  }

  if (b.cautions.length > 0) {
    out.push("", "What this evidence does not say:");
    for (const c of b.cautions) out.push(`- ${c}`);
  }

  // LAST, and labelled twice over. These notes are themselves model output, so
  // they are an opinion about the recording and not part of the record — a
  // reflection that hallucinated a step must not be able to launder it into the
  // steps list by sitting next to it. Naming them as such is also what lets the
  // prose repeat a warning: the steps say what happened, never how it went.
  if (b.reflections.length > 0) {
    out.push(
      "",
      "Notes written by a model after watching each recording. These are readings of how the session went, NOT part of the record — do not treat anything here as a step, and do not repeat a claim from a note that the steps above do not show:",
    );
    for (const r of b.reflections) out.push("", r.trim());
  }

  return out.join("\n");
}

const FIELDS = ["title", "description", "overview", "whenToUse"] as const;

/**
 * Parse a reply, or reject it WHOLESALE.
 *
 * No partial acceptance and no repair — the malformed-partition rule. A reply
 * missing any of the four fields is not a nearly-right habit, it is a reply from
 * a model that did not do the task, and filling the gap with a template string
 * would produce a document half-written by each with nothing saying which half.
 *
 * A reply carrying a `steps` or `recorded` key is rejected outright even if the
 * four fields are present: the model was told the record is not its to write,
 * and one that returned one anyway has misunderstood the job badly enough that
 * its prose should not be trusted either.
 */
export function parseHabitResponse(text: string): HabitProse | undefined {
  const obj = firstJsonObject(text);
  if (obj === undefined) return undefined;

  for (const forbidden of ["steps", "recorded", "recordedSteps"]) {
    if (forbidden in obj) return undefined;
  }

  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = obj[f];
    if (typeof v !== "string" || v.trim().length === 0) return undefined;
    out[f] = v.trim();
  }
  return out as unknown as HabitProse;
}

/**
 * A deterministic stand-in: the brief's own facts, rearranged.
 *
 * Deterministic input -> deterministic output is what lets a test assert an
 * exact document, the same contract `FakeSummaryProvider` and the fake embedder
 * hold. It invents nothing, which also makes it a usable example of the floor
 * this seam is meant to guarantee.
 */
export class FakeHabitProseProvider implements HabitProseProvider {
  readonly id = "fake";
  readonly model = "fake-habit-prose";

  async write(brief: HabitBrief): Promise<HabitProse> {
    const name = brief.routeName ?? brief.routeLabel;
    return {
      title: name,
      description: `Use when you need to ${name}.`,
      overview: `Recorded ${brief.recordings} time(s) across ${brief.apps.length} application(s).`,
      whenToUse: `States passed through: ${brief.routeLabel}`,
    };
  }
}
