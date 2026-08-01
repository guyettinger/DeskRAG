/**
 * Driving an armed plan.
 *
 * This module never touches a process: everything reaching the desktop goes
 * through the injected `Actuator`, which is what makes the test suite
 * structurally incapable of posting a real event.
 *
 * `wait` polls a PREDICATE and never sleeps a recorded duration — a dialog that
 * took 400ms while recording takes seconds on a cold start, and sleeping the
 * recorded time is the difference between a trace that works once and one that
 * works repeatedly.
 */

import { projectPath } from "../trace/paths.js";
import { predicateKey } from "../trace/predicates.js";
import { observe } from "./observe.js";
import { isRepairStep } from "./types.js";
import { strokesFor } from "./typing.js";
import type {
  ExecOutcome,
  Plan,
  PlannedAction,
  RepairStep,
  ReplayInput,
  ResolvedLayer,
  Vec2,
} from "./types.js";

export interface ExecuteOptions {
  /** Arm a plan whose edges are below the brittleness floor. */
  override?: boolean;
  /** Poll interval for `wait`. */
  pollMs?: number;
  /** How long to wait for an activated app to actually come forward. */
  activateTimeoutMs?: number;
}

export function canArm(plan: Plan, override = false): { ok: boolean; reason?: string } {
  if (plan.blockers.length > 0) {
    // Blockers are assertable: no UI action produces them, so an override would
    // only mean failing later and less clearly.
    return { ok: false, reason: plan.blockers.map((b) => b.reason).join("; ") };
  }
  const brittle = plan.brittleness.filter((b) => b.belowFloor);
  if (brittle.length > 0 && !override) {
    return {
      ok: false,
      reason: `brittle edges (majority of targets resolve to coordinates only): ${brittle
        .map((b) => `${b.edgeId} @ ${(b.axRate * 100).toFixed(0)}%`)
        .join(", ")}`,
    };
  }
  return { ok: true };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function executePlan(
  plan: Plan,
  input: ReplayInput,
  opts: ExecuteOptions = {},
): Promise<ExecOutcome> {
  const telemetry: { edgeId: string; layer: ResolvedLayer; confidence: number }[] = [];
  const armed = canArm(plan, opts.override ?? false);
  if (!armed.ok) {
    return {
      planId: plan.id,
      completed: false,
      stepsRun: 0,
      failure: { step: -1, reason: armed.reason ?? "cannot arm" },
      telemetry,
    };
  }

  const pollMs = opts.pollMs ?? 100;
  const activateTimeoutMs = opts.activateTimeoutMs ?? 5000;
  let stepsRun = 0;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    if (!isRepairStep(step) && step.resolution !== undefined) {
      telemetry.push({
        edgeId: step.edgeId,
        layer: step.resolution.layer,
        confidence: step.resolution.confidence,
      });
    }
    try {
      if (isRepairStep(step)) await runRepair(step, input, pollMs, activateTimeoutMs);
      else await runStep(step, input, pollMs);
    } catch (err) {
      return {
        planId: plan.id,
        completed: false,
        stepsRun,
        failure: { step: i, reason: err instanceof Error ? err.message : String(err) },
        telemetry,
      };
    }
    stepsRun++;
  }

  return { planId: plan.id, completed: true, stepsRun, telemetry };
}

async function runStep(step: PlannedAction, input: ReplayInput, pollMs: number): Promise<void> {
  const { action } = step;
  const { actuator } = input;

  switch (action.kind) {
    case "click": {
      const p = requirePoint(step);
      await actuator.moveTo(p);
      // CGEvent, never AXPress: AXPress is a DIFFERENT action (no hover, no
      // mouse-down, different event stream), so replaying with it would be a
      // silent divergence from what was recorded.
      await actuator.click(p, action.button, action.count);
      return;
    }
    case "hover": {
      const p = requirePoint(step);
      await actuator.moveTo(p);
      await sleep(action.dwellMs);
      return;
    }
    case "scroll": {
      const p = requirePoint(step);
      await actuator.scroll(p, action.delta, action.steps);
      return;
    }
    case "drag": {
      const from = requirePoint(step);
      // Projecting the unit-space curve onto the endpoints is ONE code path:
      // verbatim and retargeted replay differ only in where the endpoints landed.
      const to: Vec2 = { x: action.to.point.x, y: action.to.point.y };
      const points = projectPath(action.path, from, to);
      const stepMs = action.path.durationMs / Math.max(1, points.length - 1);
      const samples = points.map((p, i) => ({ p, atMs: Math.round(i * stepMs) }));
      await actuator.dragPath(samples, action.button);
      return;
    }
    case "type": {
      const value = step.slotBinding?.value ?? action.recorded;
      const strokes = strokesFor(value, input.keymap);
      if (strokes === null) {
        throw new Error(`"${value}" cannot be typed with layout ${input.keymap.layoutId}`);
      }
      for (const s of strokes) {
        await actuator.key(s.keycode, s.modifiers, true);
        await actuator.key(s.keycode, s.modifiers, false);
      }
      return;
    }
    case "chord": {
      const modifiers = action.keys.slice(0, -1);
      const last = action.keys[action.keys.length - 1];
      if (last === undefined) return;
      const stroke = strokesFor(last, input.keymap)?.[0];
      if (stroke === undefined) {
        throw new Error(`chord key "${last}" is not in layout ${input.keymap.layoutId}`);
      }
      await actuator.key(stroke.keycode, modifiers, true);
      await actuator.key(stroke.keycode, modifiers, false);
      return;
    }
    case "wait": {
      const deadline = Date.now() + action.timeoutMs;
      const want = predicateKey(action.until);
      for (;;) {
        // Through `observe`, so a wait can be satisfied by an app or window
        // predicate too — waiting for an app to come to the front is exactly the
        // kind of state a cold start makes slow.
        const observed = await observe(actuator);
        if (observed.some((p) => predicateKey(p) === want)) return;
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for ${want}`);
        }
        await sleep(pollMs);
      }
    }
  }
}

/**
 * Bring an application forward, then CONFIRM it by polling the `app` predicate.
 * Never sleeps a fixed duration: a cold app takes an unpredictable time to come
 * forward, and that is the difference between a replay that works once and one
 * that works repeatedly.
 */
async function runRepair(
  step: RepairStep,
  input: ReplayInput,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  const outcome = await input.actuator.activate(step.app, step.launch);
  if (outcome === "not-running") {
    throw new Error(`${step.app} is not running and launching was not permitted`);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = await observe(input.actuator);
    if (observed.some((p) => p.kind === "app" && p.args.app === step.app)) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${step.app} to come to the front`);
    }
    await sleep(pollMs);
  }
}

/** A spatial action with no resolution is aborted, never guessed at. */
function requirePoint(step: PlannedAction): Vec2 {
  if (step.resolution === undefined) {
    throw new Error(`step on edge ${step.edgeId} has no resolved target`);
  }
  return step.resolution.point;
}
