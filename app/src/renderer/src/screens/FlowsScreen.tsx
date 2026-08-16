/**
 * Flows — the graph of everything you have recorded, and the paths you took
 * through it.
 *
 * THIS SCREEN READS AND NEVER ACTS. The executor still exists in the library
 * (`src/replay/`) and is deliberately not wired to anything here: there is no
 * plan, no arming, and no observation of the live desktop, which is what lets
 * the app run without ever spawning a binary capable of clicking.
 *
 * Three panes, one selection. The routes column asks "what do I do repeatedly",
 * the canvas answers "where does that go", and the drawer answers "show me".
 * Every one of them ends at the same place — a recording, at the moment the
 * thing happened.
 */

import React, { useEffect, useMemo, useState } from "react";
import type { FlowsDTO } from "@shared/types";
import { api } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import { GraphCanvas, type Highlight, type Selection } from "./GraphCanvas.js";
import { InspectDrawer } from "./InspectDrawer.js";
import { RouteList } from "./RouteList.js";

/**
 * The same head every other screen carries — this one had none at all, so the
 * screen opened straight onto a stats chip and named itself nowhere.
 *
 * Shared by the populated and empty states rather than written twice: an empty
 * Flows still has to say what Flows IS, which is exactly when a reader most
 * needs telling.
 *
 * The copy says "a path you actually walked" because that is the screen's one
 * real promise: a route is only ever something a recording did, never a path
 * composed by walking the merged graph. Describing it as what the graph *can*
 * reach would advertise flows nobody has performed.
 */
function FlowsHead({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="page__head flows__head">
      <div className="flows__headtext">
        <span className="eyebrow">Flows</span>
        <h1>Paths through your recordings</h1>
        <p>
          Every session merges into one map of the states you passed through and the actions
          between them. A route is a path you actually walked — pick one to highlight it, then
          open the recording it came from.
        </p>
      </div>
      {children}
    </div>
  );
}

interface Props {
  /** Jump to the Library, at this moment of this recording. */
  onOpenRecording: (sessionId: string, atSec: number) => void;
}

export function FlowsScreen({ onOpenRecording }: Props): React.JSX.Element {
  const [flows, setFlows] = useState<FlowsDTO | null | undefined>(undefined);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [appFilter, setAppFilter] = useState<string | undefined>(undefined);

  useEffect(() => {
    void api.flows.graph().then(setFlows);
  }, []);

  const route = useMemo(
    () => flows?.routes.find((r) => r.id === routeId) ?? null,
    [flows, routeId],
  );

  const highlight = useMemo<Highlight | undefined>(
    () =>
      route === null
        ? undefined
        : { nodes: new Set(route.nodeIds), edges: new Set(route.edgeIds) },
    [route],
  );

  if (flows === undefined)
    return (
      <div className="page">
        <div className="loading">
          <div className="spinner" />
        </div>
      </div>
    );

  if (flows === null) {
    return (
      <div className="page flows">
        <FlowsHead />
        <div className="empty">
          <GhostLottie size={104} className="empty__ghost" playing />
          <h3>No flows yet</h3>
          <p>
            Record a session and its states will appear here. If you already have recordings,
            rebuild the trace graph from Settings.
          </p>
        </div>
      </div>
    );
  }

  const { graph, routes } = flows;

  /**
   * A graph whose states were observed but whose provenance is empty was built
   * before sources were captured. Without saying so, every Recordings list and
   * the whole routes column would be empty and the screen would read as broken.
   */
  const needsRebuild =
    graph.nodes.length > 0 && graph.nodes.every((n) => n.sources.length === 0);

  const node = selected?.kind === "node" ? (graph.nodes.find((n) => n.id === selected.id) ?? null) : null;
  const edge = selected?.kind === "edge" ? (graph.edges.find((e) => e.id === selected.id) ?? null) : null;
  const labelOf = (id: string): string => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const edgeCounts = {
    in: node === null ? 0 : graph.edges.filter((e) => e.to === node.id).length,
    out: node === null ? 0 : graph.edges.filter((e) => e.from === node.id).length,
  };

  return (
    <div className="page flows">
      {/* The counts and the active filters ride IN the head rather than in a
          row beneath it. Two stacked header rows were doing one job, and this
          screen pays for height in canvas: the bar cost the graph ~40px, on top
          of the head's own ~100. */}
      <FlowsHead>
        <div className="flows__bar">
          <span className="chip">
            <span className="dot" /> {graph.nodes.length} states · {graph.edges.length} actions
          </span>
          {route !== null && (
            <button className="flows__route" onClick={() => setRouteId(null)}>
              showing “{route.label}” · {route.count} recording{route.count === 1 ? "" : "s"} —
              clear
            </button>
          )}
          {appFilter !== undefined && (
            <button className="flows__route" onClick={() => setAppFilter(undefined)}>
              {appFilter} only — clear
            </button>
          )}
        </div>
      </FlowsHead>

      {/* Prose, and long — it stays a full-width row rather than being squeezed
          into the head's right-hand cluster beside two chips. */}
      {needsRebuild && (
        <p className="flows__warn">
          Built before recordings were tracked — rebuild the trace graph from Settings to link
          these states back to their sessions.
        </p>
      )}

      <div className="flows__stage">
        <RouteList
          routes={routes}
          selectedId={routeId}
          needsRebuild={needsRebuild}
          onSelect={setRouteId}
        />
        <div className="flows__main">
          <GraphCanvas
            graph={graph}
            selected={selected}
            highlight={highlight}
            appFilter={appFilter}
            onSelect={setSelected}
            onAppFilter={setAppFilter}
          />
          <InspectDrawer
            node={node}
            edge={edge}
            edgeEnds={
              edge === null ? undefined : { from: labelOf(edge.from), to: labelOf(edge.to) }
            }
            edgeCounts={edgeCounts}
            onOpenRecording={onOpenRecording}
            onClose={() => setSelected(null)}
          />
        </div>
      </div>
    </div>
  );
}
