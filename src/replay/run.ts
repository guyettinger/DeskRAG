/**
 * The segment loop — observe, locate, plan, ask, execute, repeat.
 *
 * `buildPlan` stops where anchor resolution stops working, so a multi-step plan
 * arrives in segments. This drives them, and the arming decision is INJECTED:
 * `replay/` never decides to act on its own, the same seam as `Actuator` and
 * `VisualMatcher`. An AI-in-the-loop caller can supply `arm` later without this
 * package growing a policy of its own.
 *
 * The promise the loop preserves is exact, and unchanged in substance from
 * single-shot arming: nothing is posted from a plan the caller has not reviewed
 * at exact resolution. Segmentation costs approvals, not safety.
 *
 * Re-planning after a segment is the SAME operation as planning the first one,
 * so recovering from an unexpected landing is the loop rather than a mechanism —
 * which is what `achievable` already promised about setup.
 *
 * Never touches a process: everything reaching the desktop goes through the
 * injected `Actuator`.
 */

import { executePlan } from "./execute.js";
import { locateNode } from "./locate.js";
import { predicatesOf, windowOriginOf } from "./observe.js";
import { buildPlan, findPath } from "./plan.js";
import type { ExecOutcome, Plan, RunInput, RunOutcome, RunStop } from "./types.js";

const DEFAULT_MAX_SEGMENTS = 8;

export async function executeRun(input: RunInput): Promise<RunOutcome> {
  const segments: { plan: Plan; outcome: ExecOutcome }[] = [];
  const maxSegments = input.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const stop = (stopped: RunStop): RunOutcome => ({
    goalNodeId: input.goalNodeId,
    reached: false,
    segments,
    stopped,
  });

  /** Where the previous segment said it would land, so drift can be disclosed. */
  let expected: string | undefined;

  for (let turn = 0; turn < maxSegments; turn++) {
    // ONE dump serving location and resolution geometry. Sourcing two halves of
    // a single observation separately is what made boundary snapshots describe
    // the previous application, and `AxObservation` bundles them for that reason.
    const observation = await input.actuator.dump();
    const observed = predicatesOf(observation);
    const origin = windowOriginOf(observation);

    const located = locateNode(observed, input.graph.nodes);
    if (located.nodeId === undefined) return stop("not-located");

    const path = findPath(input.graph, located.nodeId, input.goalNodeId);
    if (path === null) return stop("no-path");
    if (path.length === 0) {
      return { goalNodeId: input.goalNodeId, reached: true, segments };
    }

    const plan = await buildPlan({
      graph: input.graph,
      fromNodeId: located.nodeId,
      toNodeId: input.goalNodeId,
      observed,
      locate: (d) => input.actuator.locate(d),
      keymap: input.keymap,
      runningApps: await input.actuator.runningApps(),
      ...(input.slotBindings !== undefined ? { slotBindings: input.slotBindings } : {}),
      ...(origin !== undefined ? { windowOrigin: origin } : {}),
      ...(input.allowLaunch !== undefined ? { allowLaunch: input.allowLaunch } : {}),
    });

    // Drift is not a mechanism: the turn above re-located regardless of where the
    // previous segment claimed it would end. It only has to be disclosed, and
    // the caller has to arm again in any case, so it costs nothing to surface.
    if (expected !== undefined && expected !== located.nodeId) {
      plan.drift = { expected, observed: located.nodeId };
    }

    // A segment with nothing in it that resumes where it started cannot advance,
    // and is the loop's only way to spin forever. It also means something
    // specific: the first edge begins at the node just located, so an anchor
    // that cannot resolve there is GONE rather than not-yet-arrived. The
    // reviewer is never asked to arm an empty plan.
    if (plan.steps.length === 0 && plan.cut?.resumeAt === located.nodeId) {
      return stop("no-progress");
    }

    if (!(await input.arm(plan))) return stop("declined");

    const outcome = await executePlan(plan, input, {
      ...(input.override !== undefined ? { override: input.override } : {}),
      ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
    });
    segments.push({ plan, outcome });
    if (!outcome.completed) return stop("failed");

    expected = plan.cut?.resumeAt ?? input.goalNodeId;
  }

  return stop("max-segments");
}
