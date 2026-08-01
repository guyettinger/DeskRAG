import React, { useEffect, useMemo, useState } from "react";
import type { GraphDTO, LocationDTO, PlanDTO, RunEventDTO } from "@shared/types";
import { api } from "../api.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { PlanReview, stopMessage } from "./PlanReview.js";

export function ReplayScreen(): React.JSX.Element {
  const [graph, setGraph] = useState<GraphDTO | null>(null);
  const [location, setLocation] = useState<LocationDTO | null>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanDTO | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowLaunch, setAllowLaunch] = useState(false);
  const [bindings, setBindings] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.replay.graph().then(setGraph);
    void api.replay.watch(true);
    const offLoc = api.replay.onLocation(setLocation);
    const offEvt = api.replay.onEvent((e: RunEventDTO) => {
      if (e.type === "segment-planned") {
        setPlan(e.plan);
        setBusy(false);
        setStatus(null);
      } else if (e.type === "armed") {
        setBusy(true);
        setStatus(e.app === undefined ? "Arming…" : `Returning focus to ${e.app}…`);
      } else if (e.type === "segment-done") {
        setStatus(
          e.completed
            ? `Segment ${e.segment} completed.`
            : `Segment ${e.segment} failed at step ${(e.failure?.step ?? 0) + 1}: ${
                e.failure?.reason ?? "unknown"
              }`,
        );
      } else {
        setPlan(null);
        setBusy(false);
        setStatus(
          e.reached
            ? "Reached the goal."
            : e.reason === undefined
              ? "Stopped."
              : stopMessage(e.reason, e.detail),
        );
      }
    });
    return () => {
      offLoc();
      offEvt();
      void api.replay.watch(false);
    };
  }, []);

  const here = useMemo(() => {
    if (location === null) return "Looking…";
    const where =
      location.nodeId !== undefined
        ? `${location.app ?? "?"}${location.window !== undefined ? ` — ${location.window}` : ""}`
        : location.ambiguous
          ? `ambiguous — ${location.candidates} candidates`
          : "no recorded state matches";
    // While DeskRAG is frontmost the reading describes the reviewer, so the
    // service re-emits the last foreign one with its age. Say so.
    return location.staleMs !== undefined && location.staleMs > 0
      ? `last seen: ${where}, ${Math.round(location.staleMs / 1000)}s ago`
      : where;
  }, [location]);

  if (graph === null) {
    return (
      <div className="page replay">
        <p className="muted">No trace graph yet. Record a session, or rebuild from the Library.</p>
      </div>
    );
  }

  return (
    <div className="page page--fill replay">
      <div className="replay__bar">
        <span className={`chip${location?.nodeId !== undefined ? " live" : ""}`}>
          <span className="dot" /> {here}
        </span>
        <span className="muted">
          {goalId === null ? "Pick a goal on the graph" : `Goal: ${goalId}`}
        </span>
        <label className="replay__launch">
          <input
            type="checkbox"
            checked={allowLaunch}
            onChange={(e) => setAllowLaunch(e.target.checked)}
          />
          allow launching apps
        </label>
        {graph.slots.map((s) => (
          <label key={s.name} className="replay__slot">
            {s.name}
            <input
              list={`slot-${s.name}`}
              value={bindings[s.name] ?? ""}
              onChange={(e) => setBindings((b) => ({ ...b, [s.name]: e.target.value }))}
            />
            <datalist id={`slot-${s.name}`}>
              {s.samples.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
        ))}
        <button
          className="btn"
          disabled={goalId === null || busy || plan !== null}
          onClick={() => {
            if (goalId === null) return;
            setStatus("Planning…");
            setBusy(true);
            void api.replay.start({ goalNodeId: goalId, slotBindings: bindings, allowLaunch });
          }}
        >
          Run
        </button>
      </div>

      <div className="replay__stage">
        <GraphCanvas
          graph={graph}
          goalId={goalId}
          locationNodeId={location?.nodeId}
          onPick={setGoalId}
        />
        <PlanReview
          plan={plan}
          status={status}
          busy={busy}
          onArm={(override) => {
            setBusy(true);
            void api.replay.arm({ segment: plan?.segment ?? 1, approve: true, override });
          }}
          onCancel={() => void api.replay.cancel()}
        />
      </div>
    </div>
  );
}
