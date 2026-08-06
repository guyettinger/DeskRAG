/**
 * The flows recorded through the graph, most-walked first.
 *
 * A route is ONE RECORDING'S OWN PATH — see `frequentRoutes`. Nothing here is
 * inferred, which is why an empty list points at the rebuild rather than
 * quietly showing a graph traversal instead.
 */

import React from "react";
import type { FlowRouteDTO } from "@shared/types";

interface Props {
  routes: FlowRouteDTO[];
  selectedId: string | null;
  /** True when the graph carries no provenance at all — a different emptiness. */
  needsRebuild: boolean;
  onSelect: (routeId: string | null) => void;
}

export function RouteList({
  routes,
  selectedId,
  needsRebuild,
  onSelect,
}: Props): React.JSX.Element {
  return (
    <aside className="routes">
      <div className="routes__head">
        <span className="eyebrow">Flows</span>
        {routes.length > 0 && (
          <span className="muted">
            {routes.length} route{routes.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {routes.length === 0 ? (
        <p className="routes__empty muted">
          {needsRebuild
            ? "This graph was built before recordings were tracked. Rebuild it from the Library " +
              "and the paths you took will appear here."
            : "No recorded paths yet. Record a session, then record it again — a route you take " +
              "twice is what makes it a flow."}
        </p>
      ) : (
        <ul className="routes__list">
          {routes.map((r) => (
            <li key={r.id}>
              <button
                className={`routes__item${selectedId === r.id ? " is-active" : ""}`}
                onClick={() => onSelect(selectedId === r.id ? null : r.id)}
                title={`${r.count} recording${r.count === 1 ? "" : "s"} took this path`}
              >
                <span className={`routes__count${r.count > 1 ? " is-repeated" : ""}`}>
                  ×{r.count}
                </span>
                <span className="routes__label">{r.label}</span>
                <span className="routes__steps mono">
                  {r.edgeIds.length} step{r.edgeIds.length === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
