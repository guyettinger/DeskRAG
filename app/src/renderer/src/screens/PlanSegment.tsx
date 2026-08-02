/**
 * One segment, as ONE narrative.
 *
 * Brittleness, the cut and the remainder are all per-edge facts, and steps
 * carry `edgeId` — rendering them as separate sections is what forced the
 * reader to correlate `shortId(edgeId)` against the step list by eye. They are
 * annotations here.
 *
 * The remainder is BULLETED, never numbered. `buildPlan` cuts at an edge
 * boundary and discloses the rest as "action kinds, recorded descriptors,
 * recorded points, explicitly not targets"; the run re-observes at `resumeAt`
 * and re-plans. A step number is a claim of authorization, and this list is the
 * one place in the app where that distinction is the entire point.
 */

import React from "react";
import { shortId, type PlanDTO } from "@shared/types";
import type { SegmentOutcome } from "./run-log.js";

const pct = (n: number): string => `${Math.round(n * 100)}%`;

export function PlanSegment({
  plan,
  outcome,
  expanded,
  onToggle,
}: {
  plan: PlanDTO;
  outcome: SegmentOutcome;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const brittleEdges = new Set(plan.brittleness.filter((b) => b.belowFloor).map((b) => b.edgeId));
  const axRate = new Map(plan.brittleness.map((b) => [b.edgeId, b]));

  /** ✓ / ✗ / not attempted, derived from the outcome alone. */
  const markOf = (i: number): string => {
    if (outcome.state === "completed") return "✓";
    if (outcome.state !== "failed") return "";
    if (outcome.failedStep === undefined) return "";
    if (i < outcome.failedStep) return "✓";
    return i === outcome.failedStep ? "✗" : "·";
  };

  return (
    <section className={`seg is-${outcome.state}`}>
      <button className="seg__head" onClick={onToggle}>
        <span className="seg__caret">{expanded ? "▾" : "▸"}</span>
        <span className={`seg__state is-${outcome.state}`}>
          {outcome.state === "completed"
            ? "✓"
            : outcome.state === "failed"
              ? "✗"
              : outcome.state === "running"
                ? "●"
                : ""}
        </span>
        <span className="seg__title">Segment {plan.segment}</span>
        <span className="muted">
          {plan.fromLabel} → {plan.toLabel}
        </span>
        <span className="muted seg__count">
          {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
        </span>
      </button>

      {!expanded && outcome.state === "failed" && outcome.reason !== undefined && (
        <p className="seg__failline">{outcome.reason}</p>
      )}

      {expanded && (
        <>
          {plan.drift !== undefined && (
            <div className="seg__banner is-warn">
              Last segment expected{" "}
              <code title={plan.drift.expected}>{shortId(plan.drift.expected)}</code>, landed on{" "}
              <code title={plan.drift.observed}>{shortId(plan.drift.observed)}</code>.
            </div>
          )}

          <ol className="steps">
            {plan.steps.map((s, i) => {
              const mark = markOf(i);
              if (s.kind === "handoff") {
                return (
                  <li key={i} className="step step--handoff">
                    <span className="step__mark">↺</span>
                    <span className="step__kind">hide DeskRAG, return focus to {s.app}</span>
                  </li>
                );
              }
              const brittle = brittleEdges.has(s.edgeId);
              if (s.kind === "repair") {
                return (
                  <li key={i} className="step step--repair">
                    <span className="step__mark">{mark}</span>
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
                    <span className="step__mark" />
                    <span className="step__kind">{s.action}</span>
                    <span className="step__note">not posted — {s.reason}</span>
                  </li>
                );
              }
              return (
                <li key={i} className={`step${brittle ? " is-brittle" : ""}`}>
                  <span className="step__mark">{mark}</span>
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
                  {brittle && (
                    <span className="step__brittle">
                      ⚠ {pct(axRate.get(s.edgeId)?.axRate ?? 0)} resolved to an AX rung
                      {axRate.get(s.edgeId)?.bound === "upper" ? " (upper bound)" : ""} — mostly
                      coordinates, which click whatever has moved into that spot
                    </span>
                  )}
                  {outcome.state === "failed" &&
                    outcome.failedStep === i &&
                    outcome.reason !== undefined && (
                      <span className="step__fail">{outcome.reason}</span>
                    )}
                </li>
              );
            })}
          </ol>

          {plan.cut !== undefined && (
            <div className="cut">
              <div className="cut__rule">
                resolution stopped · resumes at{" "}
                <code title={plan.cut.resumeAt}>{shortId(plan.cut.resumeAt)}</code> after
                re-observing
              </div>
              <ul className="cut__attempts">
                {plan.cut.attempts.map((a, i) => (
                  <li key={i}>
                    <code>{a.layer}</code> — {a.rejected}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.remainder.length > 0 && (
            <ul className="remainder">
              {plan.remainder.flatMap((r) =>
                r.actions.map((a, i) => (
                  <li key={`${r.edgeId}-${i}`}>
                    {/* A bullet, never a number: these are disclosed, not authorized. */}
                    <span className="step__mark">·</span>
                    <span className="step__kind">{a.kind}</span>
                    <span className="step__target">
                      {a.descriptors !== undefined && `recorded: ${a.descriptors.join(", ")}`}
                      {a.slot !== undefined && ` ⟨${a.slot}⟩`}
                      {/* Provenance, never a target. */}
                      {a.recordedPoint !== undefined &&
                        ` · recorded at (${Math.round(a.recordedPoint.x)}, ${Math.round(
                          a.recordedPoint.y,
                        )})`}
                    </span>
                    <span className="step__res">unresolved</span>
                  </li>
                )),
              )}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
