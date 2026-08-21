/**
 * The note written after a recording: what it was for, what worked, what
 * stalled, and what order would have been better.
 *
 * Everything else the pipeline derives answers "what happened". A digest names
 * a gesture, a caption describes a screen, a composed summary names a stretch of
 * work — and all three are silent about whether the work went WELL. So a skill
 * built from them can only ever describe a task as though it went smoothly,
 * because nothing it reads is capable of saying otherwise. That gap is what this
 * fills, and it is the one thing here that has to be a judgement rather than a
 * measurement.
 *
 * Which is exactly why it is MODEL-ONLY and has no template path. A structural
 * rollup can honestly name a group of actions; it cannot honestly say a session
 * stalled. `segment_summary.source` exists so a templated summary cannot
 * masquerade as a composed one — here the equivalent guarantee is stronger: with
 * no model there is simply no note, the stage says so, and `SkillBrief.
 * reflections` is empty.
 *
 * The seam is drawn the same way `skill-prose.ts` draws its: `SessionReflection`
 * has four string fields and none of them is a step. A reflection reaches a
 * skill only through `SkillBrief.reflections`, where the prompt labels it as an
 * opinion — so a note that invented a keyboard shortcut still cannot put one in
 * the record, which `recordedBlocks()` renders from the trace graph alone.
 *
 * Barrel-safe: interfaces, pure functions and a deterministic fake. The Ollama
 * adapter in `ollama-reflection.ts` is barrel-safe too (plain fetch).
 */

import { firstJsonObject } from "./json-reply.js";

/**
 * What the model is told about one recording.
 *
 * Composed levels rather than raw actions, deliberately: a 40-minute recording
 * is hundreds of actions and a handful of tasks, and the question here is about
 * the shape of the session, not about any one click. It also means this brief
 * can only exist AFTER composing, which is what fixes the stage's position.
 *
 * No typed text and no captured values, for the reason `SkillBrief` withholds
 * them: recorded typing is verbatim and unredacted, and this note is written
 * into a document that gets pasted elsewhere.
 */
export interface ReflectionBrief {
  /** What the composed root called the session, or null when nothing named it. */
  purpose: string | null;
  /** ISO date of the recording. The note is about a specific day's work. */
  recordedOn: string;
  /** How long the recording ran. */
  durationSec: number;
  /**
   * The composed steps in order, each with what it cost.
   *
   * `seconds` and `actions` are the only evidence a model has for "stalled" —
   * a step that took a fifth of the session, or one that spent forty actions
   * where its neighbours spent four. Handing over names alone would leave it
   * inventing the answer.
   */
  steps: { name: string; seconds: number; actions: number }[];
  /** Applications reached, in the order they were first reached. */
  apps: string[];
}

/**
 * What comes back. Four fields, and none of them is a step.
 *
 * `better` is the one that can overreach, and the prompt is written to let it
 * decline: a recording is evidence about what was done, not about what the
 * alternatives would have cost, and "nothing in the recording suggests a
 * different order" is a correct answer that a model asked for advice will not
 * volunteer unless it is told it may.
 */
export interface SessionReflection {
  goal: string;
  worked: string;
  stalled: string;
  better: string;
}

export interface ReflectionProvider {
  readonly id: string;
  readonly model: string;
  /**
   * THROWS rather than guessing when the daemon is unreachable or the reply is
   * torn — the `SkillProseProvider.write` contract. There is no template to fall
   * back to here, so the caller's only options are a note or no note, and no
   * note is the honest one.
   */
  write(brief: ReflectionBrief): Promise<SessionReflection>;
}

export const REFLECTION_SYSTEM =
  "You are looking at a recording of one working session on this user's own " +
  "computer, summarised as an ordered list of steps with how long each took and " +
  "how many actions it contained. Write a short note about how the session " +
  "went, for the user's own later reference.\n" +
  "Judge only what the list shows. Do not name an application, a file, a menu " +
  "or a step that is not in it, and do not guess what was typed — the values " +
  "are withheld from you on purpose. Time and action counts are your evidence " +
  "for what dragged; a step that took a large share of the session, or spent " +
  "many more actions than its neighbours, is what 'stalled' means here.\n" +
  "You may say that nothing stalled and that no better order is visible. That " +
  "is a real answer and is preferred to inventing advice: this note is read " +
  "beside the record, where anything you made up is visible.\n" +
  'Reply with JSON only: {"goal":"...","worked":"...","stalled":"...",' +
  '"better":"..."}. `goal` is one sentence on what this session was for. ' +
  "`worked` is one or two sentences on what went smoothly. `stalled` is one or " +
  "two sentences on what took longer than the rest, or says plainly that " +
  "nothing did. `better` is one or two sentences on what order would have been " +
  "faster, or says plainly that the recording does not show one. No preamble.";

/** The brief as the user turn. Deterministic, so a test can pin it exactly. */
export function reflectionPrompt(b: ReflectionBrief): string {
  const out: string[] = [];
  out.push(`Recorded ${b.recordedOn}, ${round(b.durationSec)}s in total.`);
  if (b.purpose !== null) out.push(`The recording was composed under the name: ${b.purpose}`);
  if (b.apps.length > 0) out.push(`Applications: ${b.apps.join(", ")}`);

  out.push("", "Steps, in order:");
  b.steps.forEach((s, i) => {
    // The SHARE is stated rather than left to be computed. It is the whole
    // evidence for "stalled", and a model asked to divide two numbers in its
    // head across a dozen rows will get some of them wrong — quietly, and in
    // the direction of whichever step it already decided to name.
    const share =
      b.durationSec > 0 ? ` (${Math.round((s.seconds / b.durationSec) * 100)}% of the session)` : "";
    out.push(`${i + 1}. ${s.name} — ${round(s.seconds)}s${share}, ${s.actions} actions`);
  });

  return out.join("\n");
}

const round = (n: number): string => (Math.round(n * 10) / 10).toString();

const FIELDS = ["goal", "worked", "stalled", "better"] as const;

/**
 * Parse a reply, or reject it WHOLESALE.
 *
 * The malformed-partition rule again: a reply missing a field is a reply from a
 * model that did not do the task, and there is nothing here to repair it with.
 * A reply carrying a `steps` key is rejected outright even when the four fields
 * are present — the model was told the record is not its to write.
 */
export function parseReflectionResponse(text: string): SessionReflection | undefined {
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
  return out as unknown as SessionReflection;
}

/** The headings the stored note carries, in order. Exported so a reader can find them. */
export const REFLECTION_HEADINGS: readonly { key: keyof SessionReflection; head: string }[] = [
  { key: "goal", head: "Goal" },
  { key: "worked", head: "What worked" },
  { key: "stalled", head: "What stalled" },
  { key: "better", head: "A better order" },
];

/**
 * The note as the one string that gets stored.
 *
 * Rendered here rather than stored as JSON because the note is PROSE and its
 * only consumers read it as prose — the skill prompt quotes it whole. Four
 * columns or a JSON blob would both mean every reader re-deciding how to lay it
 * out, and two readers laying one thing out differently is the drift this repo
 * has already paid for twice.
 */
export function renderReflection(r: SessionReflection): string {
  return REFLECTION_HEADINGS.map(({ key, head }) => `${head}: ${r[key].trim()}`).join("\n");
}

/**
 * A deterministic stand-in: the brief's own facts, rearranged.
 *
 * It invents nothing, which makes it a usable example of the floor this seam
 * guarantees — and it is NOT a template path. Nothing in the app ever
 * constructs it; a missing model means a missing note.
 */
export class FakeReflectionProvider implements ReflectionProvider {
  readonly id = "fake";
  readonly model = "fake-reflection";

  async write(brief: ReflectionBrief): Promise<SessionReflection> {
    const longest = [...brief.steps].sort((a, b) => b.seconds - a.seconds)[0];
    return {
      goal: brief.purpose ?? `A ${round(brief.durationSec)}s session across ${brief.apps.length} application(s).`,
      worked: `${brief.steps.length} step(s) were recorded in order.`,
      stalled:
        longest === undefined
          ? "No steps were composed, so nothing can be called slow."
          : `${longest.name} took the longest, at ${round(longest.seconds)}s.`,
      better: "This is a deterministic stand-in and proposes no reordering.",
    };
  }
}
