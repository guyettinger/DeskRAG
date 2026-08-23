/**
 * `get_habit_step` — one step of a habit, and what was on screen when it ran.
 *
 * An agent following a HABIT.md and stuck at step 4 has nowhere to look: the
 * file says `Calculator — no state → TextEdit — Untitled` and nothing shows
 * what that was. This is the look.
 *
 * ADDRESSED THE WAY THE FILE PRINTS IT. `recordedBlocks` numbers steps 1., 2., …
 * with no letter when the recordings agreed, and restarts numbering under
 * `### Way A` / `### Way B` when they did not. So `step` is 1-based and `way` is
 * a letter — and the letter is REQUIRED once there is more than one way, because
 * defaulting to A would answer about a different path than the agent just read.
 *
 * Pure: no store, no image bytes. `tools.ts` fetches the keyframe.
 */

import type { HabitDTO, HabitStepDTO } from "@shared/types";
import type { StepMoment } from "./reader.js";

export type StepAddress =
  | { kind: "found"; wayLetter: string; step: HabitStepDTO; manyWays: boolean }
  | { kind: "error"; message: string };

const letters = (habit: HabitDTO): string => habit.ways.map((w) => w.letter).join(", ");

export function resolveStep(habit: HabitDTO, step: number, way: string | null): StepAddress {
  if (habit.ways.length === 0) {
    // An orphaned habit's steps exist only as a stored copy inside the rendered
    // markdown. Answering from that copy would present unverified steps as
    // current, so this refuses and says which situation it is.
    return {
      kind: "error",
      message:
        `Habit ${habit.id} has no live steps: the route it was written from is no longer in ` +
        "the trace graph, so nothing can be looked up against a recording. `get_habit` still " +
        "returns the file, whose steps are a stored copy that has not been re-checked.",
    };
  }

  const manyWays = habit.ways.length > 1;
  let chosen = habit.ways[0]!;
  if (way !== null) {
    if (!manyWays) {
      return {
        kind: "error",
        message:
          `Habit ${habit.id} has one recorded way, so it takes no \`way\` letter — the file ` +
          "prints its steps unlettered. Omit `way`.",
      };
    }
    const found = habit.ways.find((w) => w.letter.toLowerCase() === way.toLowerCase());
    if (found === undefined) {
      return {
        kind: "error",
        message: `No way ${way} on habit ${habit.id}. It has: ${letters(habit)}.`,
      };
    }
    chosen = found;
  } else if (manyWays) {
    return {
      kind: "error",
      message:
        `\`way\` is required: habit ${habit.id} has ${habit.ways.length} recorded ways ` +
        `(${letters(habit)}) and they are different procedures, not one procedure with ` +
        "options. Pick the way whose steps you are following.",
    };
  }

  const found = chosen.steps[step - 1];
  if (found === undefined) {
    return {
      kind: "error",
      message:
        `No step ${step}${manyWays ? ` on way ${chosen.letter}` : ""}: it has ` +
        `${chosen.steps.length} step${chosen.steps.length === 1 ? "" : "s"}, numbered from 1.`,
    };
  }
  return { kind: "found", wayLetter: chosen.letter, step: found, manyWays };
}

const stamp = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

export interface StepRenderInput {
  habit: HabitDTO;
  wayLetter: string;
  manyWays: boolean;
  step: HabitStepDTO;
  /** Null when the step has no sources, or the recording has no keyframes. */
  moment: StepMoment | null;
}

export function renderStep(input: StepRenderInput): string {
  const { habit, step, moment } = input;
  const way = habit.ways.find((w) => w.letter === input.wayLetter);
  const total = way?.steps.length ?? 0;
  const out: string[] = [];

  out.push(
    `${habit.slug === "" ? habit.title : habit.slug} — Step ${step.index + 1} of ${total}` +
      (input.manyWays ? `, Way ${input.wayLetter}` : ""),
  );
  out.push("");

  if (step.missing) {
    out.push(
      `This step's edge \`${step.edgeId}\` is not in the trace graph — an index defect. It is ` +
        "carried rather than dropped, because omitting it would make the procedure read as " +
        "shorter than it was.",
    );
    return out.join("\n");
  }

  out.push(`${step.from} → ${step.to}`);
  if (step.actions.length === 0) {
    out.push("  (no actions recorded on this edge)");
  }
  for (const a of step.actions) {
    const target = a.target === "—" || a.target === "" ? "" : ` — ${a.target}`;
    const slot =
      a.slot === undefined
        ? ""
        : ` (slot \`${a.slot.name}\`; recorded values are not carried here)`;
    out.push(`  \`${a.action}\`${target}${slot}`);
  }
  for (const w of step.liftWarnings) out.push(`  NOTE: ${w}`);
  out.push("");

  out.push(step.observations === 1 ? "Walked once." : `Walked by ${step.observations} recordings.`);
  if (!step.everyRecording) {
    // The honest replacement for a success rate: TraceEdge.outcomes is {0,0} on
    // every graph on disk, so "this step sometimes failed" has no data behind it.
    out.push(
      "Not every recording took this step — fewer recordings walked it than walked the whole route.",
    );
  }

  if (step.firstAt === null) {
    out.push(
      "This step carries no recording sources, so there is no moment to open. A graph lifted " +
        "before provenance was captured has none, and deleting a recording removes its sources.",
    );
    return out.join("\n");
  }

  out.push(`First walked at ${stamp(step.firstAt.atSec)} into recording ${step.firstAt.sessionId}.`);

  if (moment === null) {
    out.push(
      "That recording has no keyframe, so there is nothing to show — Screen capture was off, " +
        "or the recording predates keyframe capture.",
    );
    return out.join("\n");
  }

  out.push("");
  out.push(
    moment.after
      ? `The screenshot below is the recording's FIRST keyframe, at ${stamp(moment.offsetSec)} — ` +
          "AFTER this step began, because the step starts before the video's first frame."
      : `The screenshot below is the screen at ${stamp(moment.offsetSec)}, the last keyframe at ` +
          "or before this step began.",
  );

  const labelled = moment.regions.filter((r) => r.label !== null && r.label !== "");
  if (labelled.length > 0) {
    out.push("");
    out.push("On screen (from the accessibility tree, at this moment):");
    for (const r of labelled) {
      out.push(
        `  ${r.role ?? "element"} "${r.label}" at ${Math.round(r.bbox.x)},${Math.round(r.bbox.y)} ` +
          `${Math.round(r.bbox.w)}×${Math.round(r.bbox.h)}`,
      );
    }
  }
  const unlabelled = moment.regions.length - labelled.length;
  if (unlabelled > 0) {
    out.push(`  …and ${unlabelled} further region${unlabelled === 1 ? "" : "s"} with no label.`);
  }
  out.push("");
  out.push(`frameId: ${moment.frameId}  — pass to get_moment for this frame on its own`);
  return out.join("\n");
}
