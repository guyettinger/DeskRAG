/**
 * The review column: every Plan field, and the two gates.
 *
 * The gates keep the library's asymmetry exactly. Blockers can NEVER be
 * overridden — `assertable` means no UI action produces the predicate, so there
 * is nothing an override could mean. Brittleness can be, behind a tick that
 * names what is being accepted.
 */

import React, { useState } from "react";
import type { PlanDTO, ReplayStopReason } from "@shared/types";

export function stopMessage(reason: ReplayStopReason, detail?: string): string {
  switch (reason) {
    case "cancelled":
      return "Cancelled — no event was posted.";
    case "handoff-failed":
      return `${detail ?? "The app"} did not come forward; nothing was posted.`;
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

const pct = (n: number): string => `${Math.round(n * 100)}%`;

interface Props {
  plan: PlanDTO | null;
  status: string | null;
  busy: boolean;
  onArm: (override: boolean) => void;
  onCancel: () => void;
}

export function PlanReview({ plan, status, busy, onArm, onCancel }: Props): React.JSX.Element {
  const [override, setOverride] = useState(false);

  if (plan === null) {
    return (
      <aside className="review review--empty">
        <h2 className="review__title">Plan</h2>
        <p className="muted">{status ?? "Pick a goal on the graph, then run."}</p>
      </aside>
    );
  }

  const brittle = plan.brittleness.filter((b) => b.belowFloor);
  const blocked = plan.blockers.length > 0;
  const needsOverride = brittle.length > 0;

  return (
    <aside className="review">
      {/* Segment N, never "N of M": the loop does not know a total, and
          inventing a denominator would be a claim the executor never makes. */}
      <h2 className="review__title">Segment {plan.segment}</h2>
      <p className="review__route">
        {plan.fromLabel} → {plan.toLabel}
      </p>

      {plan.drift !== undefined && (
        <div className="review__banner is-warn">
          Last segment expected <code>{plan.drift.expected}</code>, landed on{" "}
          <code>{plan.drift.observed}</code>.
        </div>
      )}

      <ol className="steps">
        {plan.steps.map((s, i) => {
          if (s.kind === "handoff") {
            return (
              <li key={i} className="step step--handoff">
                <span className="step__kind">hide DeskRAG, return focus to {s.app}</span>
              </li>
            );
          }
          if (s.kind === "repair") {
            return (
              <li key={i} className="step step--repair">
                <span className="step__kind">activate {s.app}</span>
                <span className="step__note">
                  {s.reason}
                  {s.launch ? " · may launch it" : " · will not launch it"}
                </span>
              </li>
            );
          }
          if (s.kind === "superseded") {
            return (
              <li key={i} className="step step--superseded">
                <span className="step__kind">{s.action}</span>
                <span className="step__note">not posted — {s.reason}</span>
              </li>
            );
          }
          return (
            <li key={i} className="step">
              <span className="step__kind">{s.action}</span>
              <span className="step__target">{s.target}</span>
              {s.slot !== undefined && (
                <span className="step__slot">
                  {s.slot.name} = “{s.slot.value}”
                </span>
              )}
              {s.layer !== undefined && (
                <span className="step__res">
                  {s.layer} {s.confidence !== undefined ? s.confidence.toFixed(2) : ""}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {blocked && (
        <section className="review__block">
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

      {plan.cut !== undefined && (
        <section className="review__cut">
          <h3>Resolution stopped</h3>
          <p>
            at edge <code>{plan.cut.edgeId}</code>; the run resumes from{" "}
            <code>{plan.cut.resumeAt}</code> after re-observing.
          </p>
          <ul className="attempts">
            {plan.cut.attempts.map((a, i) => (
              <li key={i}>
                <code>{a.layer}</code> — {a.rejected}
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.remainder.length > 0 && (
        <section className="review__remainder">
          <h3>Beyond the cut · {plan.remainder.length} edge(s)</h3>
          <p className="muted">Disclosed, deliberately unresolved.</p>
          {plan.remainder.map((r) => (
            <div key={r.edgeId} className="remainder">
              <code>{r.edgeId}</code> → <code>{r.toNodeId}</code>
              <ul>
                {r.actions.map((a, i) => (
                  <li key={i}>
                    {a.kind}
                    {a.descriptors !== undefined && ` · recorded: ${a.descriptors.join(", ")}`}
                    {/* Provenance, never a target. */}
                    {a.recordedPoint !== undefined &&
                      ` · recorded at (${Math.round(a.recordedPoint.x)}, ${Math.round(
                        a.recordedPoint.y,
                      )})`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {plan.brittleness.length > 0 && (
        <section className="review__brittle">
          <h3>Anchor quality</h3>
          <ul>
            {plan.brittleness.map((b) => (
              <li key={b.edgeId} className={b.belowFloor ? "is-low" : ""}>
                <code>{b.edgeId}</code> — {pct(b.axRate)} resolved to an AX rung
                {b.bound === "upper" && <span className="muted"> (upper bound)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {needsOverride && !blocked && (
        <label className="review__override">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          Arm anyway — {brittle.length} edge(s) resolve mostly to coordinates, which click
          whatever has moved into that spot.
        </label>
      )}

      <div className="review__actions">
        <button className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn"
          disabled={busy || blocked || (needsOverride && !override)}
          onClick={() => onArm(override)}
        >
          Arm segment {plan.segment}
        </button>
      </div>
    </aside>
  );
}
