/**
 * The event stream, folded into the run log the reviewer reads.
 *
 * WHY OUTCOMES ARE INFERRED. `replay-service.report()` emits `segment-done` for
 * EVERY segment at once, after the whole run returns — `executeRun` has no
 * per-segment callback, only `arm`, and reporting one segment would discard the
 * telemetry of every earlier one. So while segment 2 is being reviewed,
 * segment 1's outcome has not been reported yet.
 *
 * It is still sound to conclude segment 1 completed: `executeRun` plans segment
 * N+1 only if segment N completed. The final burst confirms the inference and
 * supplies the failure detail. That is why this needs no new IPC event.
 *
 * The two shapes below live HERE rather than beside their components because
 * the root suite tests this reducer, and the root tsconfig sets no `jsx` — a
 * test that reached into a `.tsx` for a type would break `npm run typecheck`.
 * They are data, not components, so this is where they belong regardless.
 */

import type { PlanDTO, RunEventDTO } from "@shared/types";

export interface SegmentOutcome {
  state: "awaiting" | "running" | "completed" | "failed";
  /** Index into the RENDERED `plan.steps`; already DTO-space. */
  failedStep?: number;
  reason?: string;
}

export interface LoggedSegment {
  plan: PlanDTO;
  outcome: SegmentOutcome;
}

const withOutcome = (s: LoggedSegment, outcome: SegmentOutcome): LoggedSegment => ({
  plan: s.plan,
  outcome,
});

export function reduceRunEvent(segments: LoggedSegment[], event: RunEventDTO): LoggedSegment[] {
  switch (event.type) {
    case "segment-planned": {
      const at = segments.findIndex((s) => s.plan.segment === event.plan.segment);
      const entry: LoggedSegment = { plan: event.plan, outcome: { state: "awaiting" } };
      // A re-plan of the same segment replaces it. Appending would show the
      // reviewer two versions of one decision.
      if (at >= 0) return segments.map((s, i) => (i === at ? entry : s));
      // Every EARLIER segment must have completed, or this one would not exist.
      return [
        ...segments.map((s) =>
          s.outcome.state === "awaiting" || s.outcome.state === "running"
            ? withOutcome(s, { state: "completed" })
            : s,
        ),
        entry,
      ];
    }

    case "armed":
      return segments.map((s) =>
        s.plan.segment === event.segment ? withOutcome(s, { state: "running" }) : s,
      );

    case "segment-done":
      return segments.map((s) => {
        if (s.plan.segment !== event.segment) return s;
        if (event.completed) return withOutcome(s, { state: "completed" });
        return withOutcome(s, {
          state: "failed",
          // Already DTO space — `report()` converts with `failedStepIndex`, and
          // re-shifting here would undo that fix. Absent when the segment
          // refused to start, because then no step ran.
          ...(event.failure !== undefined
            ? { failedStep: event.failure.step, reason: event.failure.reason }
            : {}),
        });
      });

    case "stopped":
      // A segment left RUNNING when the run stops never got its own report —
      // a failed handoff or a blocked observation ends the run before
      // execution. One still AWAITING was cancelled, which is not a failure.
      return segments.map((s) =>
        s.outcome.state === "running" ? withOutcome(s, { state: "failed" }) : s,
      );
  }
}
