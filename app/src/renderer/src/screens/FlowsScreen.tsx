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
import { GraphCanvas, type Highlight, type Selection } from "./GraphCanvas.js";
import { InspectDrawer } from "./InspectDrawer.js";
import { RouteList } from "./RouteList.js";

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

  if (flows === undefined) return <div className="spinner" />;

  if (flows === null) {
    return (
      <div className="page flows">
        <p className="muted">
          No trace graph yet. Record a session — or, if you have recordings already, rebuild the
          graph from Settings.
        </p>
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
    <div className="page page--fill flows">
      <div className="flows__bar">
        <span className="chip">
          <span className="dot" /> {graph.nodes.length} states · {graph.edges.length} actions
        </span>
        {route !== null && (
          <button className="flows__route" onClick={() => setRouteId(null)}>
            showing “{route.label}” · {route.count} recording{route.count === 1 ? "" : "s"} — clear
          </button>
        )}
        {appFilter !== undefined && (
          <button className="flows__route" onClick={() => setAppFilter(undefined)}>
            {appFilter} only — clear
          </button>
        )}
        {needsRebuild && (
          <span className="flows__warn">
            Built before recordings were tracked — rebuild the trace graph from Settings to link
            these states back to their sessions.
          </span>
        )}
      </div>

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
