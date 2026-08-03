/**
 * Two modes, not a split.
 *
 * The stage holds ONE component. Browse is the graph plus its bottom sheet;
 * review is the route strip plus the run log. The base mode is derived, never
 * stored — `plan or log exists` — so there is no mode variable to desynchronize
 * from the data.
 *
 * `⟵ graph` is a PEEK, not a cancel. Looking at the graph while deciding
 * whether to arm is the loop this screen exists for, so the back affordance
 * works while a segment awaits approval; it sets one flag and posts nothing.
 * Browse then carries a bar saying an approval is outstanding, so an unanswered
 * authorization cannot be lost by navigating away. Only Cancel declines.
 */

import React, { useEffect, useMemo, useState } from "react";
import type { GraphDTO, LocationDTO, RunEventDTO } from "@shared/types";
import { api } from "../api.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { NodeSheet } from "./NodeSheet.js";
import { RouteStrip } from "./RouteStrip.js";
import { RunLog, stopMessage } from "./RunLog.js";
import { reduceRunEvent, type LoggedSegment } from "./run-log.js";

export function ReplayScreen(): React.JSX.Element {
  const [graph, setGraph] = useState<GraphDTO | null>(null);
  const [location, setLocation] = useState<LocationDTO | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segments, setSegments] = useState<LoggedSegment[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [allowLaunch, setAllowLaunch] = useState(false);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  /** Closed explicitly, so the diagnosis does not reopen on the next poll. */
  const [diagnosisClosed, setDiagnosisClosed] = useState(false);

  useEffect(() => {
    void api.replay.graph().then(setGraph);
    void api.replay.watch(true);
    const offLoc = api.replay.onLocation(setLocation);
    const offEvt = api.replay.onEvent((e: RunEventDTO) => {
      setSegments((cur) => reduceRunEvent(cur, e));
      if (e.type === "segment-planned") {
        setBusy(false);
        setStatus(null);
        // A new decision is due: stop peeking and show it.
        setPeeking(false);
      } else if (e.type === "armed") {
        setBusy(true);
        setStatus(e.app === undefined ? "Arming…" : `Returning focus to ${e.app}…`);
      } else if (e.type === "segment-done") {
        setStatus(null);
      } else {
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

  const pending = segments.find((s) => s.outcome.state === "awaiting");
  const reviewing = segments.length > 0 && !peeking;
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const edgeCounts = {
    in: graph.edges.filter((e) => e.to === selectedId).length,
    out: graph.edges.filter((e) => e.from === selectedId).length,
  };

  return (
    <div className="page page--fill replay">
      <div className="replay__bar">
        <button
          className={`chip${location?.nodeId !== undefined ? " live" : ""}`}
          onClick={() => setDiagnosisClosed(false)}
          title="Show why nothing matched"
        >
          <span className="dot" /> {here}
        </button>
        {peeking && pending !== undefined && (
          <button className="replay__pending" onClick={() => setPeeking(false)}>
            Segment {pending.plan.segment} awaiting approval · return to review
          </button>
        )}
        {/* A run can stop BEFORE any segment is planned — `not-located`,
            `no-path`, `observe-blocked` — and then there is no run log to
            carry the message. The old empty review column was its only home,
            so without this, pressing Run against a desktop that matches
            nothing looks like nothing happening at all. */}
        {!reviewing && status !== null && <span className="replay__status">{status}</span>}
      </div>

      {reviewing ? (
        <div className="replay__stage">
          <RouteStrip
            plan={pending?.plan ?? segments[segments.length - 1]?.plan ?? null}
            graph={graph}
            pending={pending !== undefined}
            onBack={() => {
              // A finished run leaves review for real; a pending one peeks.
              if (pending === undefined) setSegments([]);
              else setPeeking(true);
            }}
          />
          <RunLog
            segments={segments}
            status={status}
            busy={busy}
            onArm={(override) => {
              setBusy(true);
              void api.replay.arm({
                segment: pending?.plan.segment ?? 1,
                approve: true,
                override,
              });
            }}
            onCancel={() => void api.replay.cancel()}
          />
        </div>
      ) : (
        <div className="replay__stage">
          <GraphCanvas
            graph={graph}
            selectedId={selectedId}
            locationNodeId={location?.nodeId}
            onSelect={(id) => {
              setSelectedId(id);
              if (id !== null) setDiagnosisClosed(false);
            }}
          />
          <NodeSheet
            node={selected}
            nearest={diagnosisClosed ? undefined : location?.nearest}
            slots={graph.slots}
            bindings={bindings}
            allowLaunch={allowLaunch}
            busy={busy}
            edgeCounts={edgeCounts}
            onBind={(name, value) => setBindings((b) => ({ ...b, [name]: value }))}
            onAllowLaunch={setAllowLaunch}
            onRun={() => {
              if (selectedId === null) return;
              setStatus("Planning…");
              setBusy(true);
              setPeeking(false);
              void api.replay.start({
                goalNodeId: selectedId,
                slotBindings: bindings,
                allowLaunch,
              });
            }}
            onClose={() => {
              if (selected !== null) setSelectedId(null);
              else setDiagnosisClosed(true);
            }}
          />
        </div>
      )}
    </div>
  );
}
