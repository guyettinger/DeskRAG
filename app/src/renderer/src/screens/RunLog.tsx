/**
 * The whole run, not just the current segment.
 *
 * The gates keep the library's asymmetry exactly. Blockers can NEVER be
 * overridden — `assertable` means no UI action produces the predicate, so there
 * is nothing an override could mean. Brittleness can be, behind a tick that
 * names what is being accepted.
 *
 * The gate bar is PINNED. Arm used to sit below blockers, the cut, the
 * remainder and the brittleness table, so authorizing a click meant scrolling
 * past everything that might argue against it.
 */

import React, { useState } from "react";
import type { ReplayStopReason } from "@shared/types";
import { PlanSegment } from "./PlanSegment.js";
import type { LoggedSegment } from "./run-log.js";

export function stopMessage(reason: ReplayStopReason, detail?: string): string {
  switch (reason) {
    case "cancelled":
      return "Cancelled — no event was posted.";
    case "handoff-failed":
      return `${detail ?? "The app"} did not come forward; nothing was posted.`;
    case "observe-blocked":
      return "DeskRAG stayed frontmost, so there was nothing to observe. Nothing was posted.";
    case "not-located":
      return "The desktop matches no recorded state.";
    case "no-path":
      return "No recorded path from here to that state.";
    case "no-progress":
      return "The first action's target is gone from this screen.";
    case "max-segments":
      return "Stopped after the segment limit.";
    case "failed":
      return detail ?? "A step failed; the run stopped.";
  }
}

export function RunLog({
  segments,
  status,
  busy,
  onArm,
  onCancel,
}: {
  segments: LoggedSegment[];
  status: string | null;
  busy: boolean;
  onArm: (override: boolean) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [override, setOverride] = useState(false);
  /**
   * Only the segment being decided is open by default; finished ones collapse.
   * `null` means "no explicit choice yet"; `""` is the collapse sentinel, and
   * is never a real plan id.
   */
  const [openId, setOpenId] = useState<string | null>(null);

  const pending = segments.find((s) => s.outcome.state === "awaiting");
  const plan = pending?.plan;
  const brittle = plan === undefined ? [] : plan.brittleness.filter((b) => b.belowFloor);
  const blocked = plan !== undefined && plan.blockers.length > 0;
  const needsOverride = brittle.length > 0;

  return (
    <div className="runlog">
      <div className="runlog__list">
        {segments.map((s) => (
          <PlanSegment
            key={s.plan.id}
            plan={s.plan}
            outcome={s.outcome}
            expanded={openId === null ? s.outcome.state === "awaiting" : openId === s.plan.id}
            onToggle={() => setOpenId((cur) => (cur === s.plan.id ? "" : s.plan.id))}
          />
        ))}
        {status !== null && <p className="runlog__status">{status}</p>}
      </div>

      <div className="runlog__gate">
        {blocked && plan !== undefined && (
          <section className="gate__block">
            <h3>Blocked</h3>
            <ul>
              {plan.blockers.map((b, i) => (
                <li key={i}>
                  {b.reason} <span className="muted">({b.scope})</span>
                </li>
              ))}
            </ul>
            <p className="muted">No UI action produces these, so there is no override.</p>
          </section>
        )}

        {needsOverride && !blocked && (
          <label className="gate__override">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            Arm anyway — {brittle.length} edge(s) resolve mostly to coordinates, which click
            whatever has moved into that spot.
          </label>
        )}

        <div className="gate__actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy || plan === undefined}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy || plan === undefined || blocked || (needsOverride && !override)}
            onClick={() => onArm(override)}
          >
            {plan === undefined ? "Arm" : `Arm segment ${plan.segment}`}
          </button>
        </div>
      </div>
    </div>
  );
}
