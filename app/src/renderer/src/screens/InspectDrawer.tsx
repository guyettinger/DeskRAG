/**
 * The graph's detail surface: one drawer, whichever of a node or an edge is
 * selected.
 *
 * It rises from the bottom rather than sitting beside the canvas. A downward
 * flow is tall and narrow, so horizontal room is exactly what the transpose
 * freed; an inspector column would take it straight back.
 *
 * The class prefix is `drawer`, NOT `sheet`: `.sheet` was then SearchScreen's
 * contact-sheet grid (`display: grid; repeat(auto-fill, minmax(232px, 1fr))`).
 * Reusing the name made this element inherit that grid, so its header and body
 * became side-by-side grid items and the body's three columns collapsed into
 * one ~250px track — predicates wrapped one character per line. A base rule
 * that does not reset `display` inherits whatever the colliding rule set.
 *
 * Search has since become a list of `.result` rows and `.sheet` no longer
 * exists. That does not make the name safe — the failure was a silent
 * inheritance nothing typechecks, and it is waiting for whoever takes it next.
 */

import React from "react";
import type { EdgeSourceDTO, GraphEdgeDTO, GraphNodeDTO, NodeSourceDTO } from "@shared/types";
import { timecode, wallClock } from "../api.js";

interface Props {
  node: GraphNodeDTO | null;
  edge: GraphEdgeDTO | null;
  /** The labels of the nodes an edge runs between, for its header. */
  edgeEnds?: { from: string; to: string } | undefined;
  edgeCounts: { in: number; out: number };
  onOpenRecording: (sessionId: string, atSec: number) => void;
  onClose: () => void;
}

/**
 * The recordings a state or an action came from, each a way back into the
 * Library at the moment it happened. This is the whole point of the screen:
 * the graph summarizes, and one click gets you to the thing it summarized.
 *
 * `observations` is the count and `sources` is what can still be looked at, and
 * they legitimately disagree: a graph built before provenance was captured has
 * none, and deleting a recording removes its sources while leaving the count it
 * contributed. Both cases are stated rather than smoothed over — a silently
 * short list would read as a bug in the graph.
 */
function Recordings({
  sources,
  observations,
  onOpen,
}: {
  sources: (NodeSourceDTO | EdgeSourceDTO)[];
  observations: number;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const missing = observations - sources.length;
  return (
    <section className="drawer__recs">
      <h3 className="eyebrow">Recordings</h3>
      {sources.length === 0 ? (
        <p className="muted">
          {observations > 0
            ? "No recordings are linked to this yet — rebuild the trace graph from Settings " +
              "to link states back to the sessions they came from."
            : "Never observed."}
        </p>
      ) : (
        <ul className="reclist">
          {sources.map((s, i) => (
            <li key={`${s.sessionId}:${i}`}>
              <button
                className="reclist__item"
                onClick={() => onOpen(s.sessionId, s.atSec)}
                title={`Open this recording at ${timecode(s.atSec * 1000)}`}
              >
                <span className="reclist__when">{wallClock(s.startedAt)}</span>
                <span className="reclist__at mono">
                  {timecode(s.atSec * 1000)}
                  {"throughSec" in s && ` – ${timecode(s.throughSec * 1000)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {missing > 0 && sources.length > 0 && (
        <p className="drawer__warn">
          {sources.length} of {observations} observations — {missing} recording
          {missing === 1 ? " has" : "s have"} been deleted.
        </p>
      )}
    </section>
  );
}

export function InspectDrawer({
  node,
  edge,
  edgeEnds,
  edgeCounts,
  onOpenRecording,
  onClose,
}: Props): React.JSX.Element | null {
  if (node !== null) {
    return (
      <aside className="drawer">
        <header className="drawer__head">
          <span className="drawer__chip">{node.chip}</span>
          <span className="drawer__title">{node.label}</span>
          <span className="muted">
            {node.observations} observation{node.observations === 1 ? "" : "s"} · {edgeCounts.in} in
            · {edgeCounts.out} out
          </span>
          {/* Two DIFFERENT reasons a state cannot be told apart from another,
              and saying the wrong one is worse than saying nothing. An empty
              set is vacuously a subset of every observation, so such a node
              matches any desktop at all; an `app`-only set is satisfied by
              every state in that one application. Measured on the real graph:
              the entry node has NO predicates and was being told its identity
              was "only `app`". */}
          {node.predicates.length === 0 ? (
            <span className="drawer__warn">
              no predicates — this state carries no identity at all, because an empty set is
              vacuously true of every desktop
            </span>
          ) : (
            !node.locatable && (
              <span className="drawer__warn">
                identity is only `app`, which every state in that application satisfies — so this
                state cannot be told apart from its neighbours
              </span>
            )
          )}
          <button className="drawer__close" onClick={onClose} title="Close (Esc)">
            ╳
          </button>
        </header>

        <div className="drawer__body">
          {node.frameBlobId !== undefined ? (
            <img className="drawer__shot" src={`deskrag://frame/${node.frameBlobId}`} alt="" />
          ) : (
            <div className="drawer__shot drawer__shot--none">no keyframe</div>
          )}

          <section className="drawer__preds">
            <h3 className="eyebrow">Predicates</h3>
            {node.predicates.length === 0 ? (
              <p className="muted">No predicates — this state describes nothing.</p>
            ) : (
              <ul>
                {node.predicates.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
          </section>

          <Recordings
            sources={node.sources}
            observations={node.observations}
            onOpen={onOpenRecording}
          />
        </div>
      </aside>
    );
  }

  if (edge !== null) {
    return (
      <aside className="drawer">
        <header className="drawer__head">
          <span className="drawer__chip">
            {edge.actions.length} act{edge.actions.length === 1 ? "" : "s"}
          </span>
          <span className="drawer__title">
            {edgeEnds === undefined ? "action" : `${edgeEnds.from} → ${edgeEnds.to}`}
          </span>
          <span className="muted">
            {edge.observations} recording{edge.observations === 1 ? "" : "s"} · {edge.provenance}
            {edge.back && " · loops back"}
          </span>
          <button className="drawer__close" onClick={onClose} title="Close (Esc)">
            ╳
          </button>
        </header>

        <div className="drawer__body drawer__body--edge">
          <section className="drawer__acts">
            <h3 className="eyebrow">Actions</h3>
            {edge.actions.length === 0 ? (
              <p className="muted">
                No actions — the two states are adjacent with nothing recorded between them.
              </p>
            ) : (
              <ol className="acts">
                {edge.actions.map((a, i) => (
                  <li key={i}>
                    <span className="acts__kind">{a.action}</span>
                    <span className="acts__target">{a.target}</span>
                    {/* Two or more samples is a DISCOVERED VARIABLE — the thing
                        recording a task twice produces — and this edge is the
                        one place that fact is about something specific. */}
                    {a.slot !== undefined && (
                      <span className="acts__slot">
                        {a.slot.samples.length > 1 && (
                          <span className="acts__var" title="Recorded with more than one value">
                            variable
                          </span>
                        )}
                        {a.slot.samples.map((s, j) => (
                          <code key={j}>{s}</code>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {edge.liftWarnings !== undefined && edge.liftWarnings.length > 0 && (
              <ul className="drawer__warn">
                {edge.liftWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </section>

          <Recordings
            sources={edge.sources}
            observations={edge.observations}
            onOpen={onOpenRecording}
          />
        </div>
      </aside>
    );
  }

  return null;
}
