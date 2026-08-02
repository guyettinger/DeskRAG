/**
 * The graph's detail surface: one drawer, three possible contents, in strict
 * precedence — selected node, then the locating diagnosis, then nothing.
 *
 * It rises from the bottom rather than sitting beside the canvas. A downward
 * flow is tall and narrow, so horizontal room is exactly what the transpose
 * freed; an inspector column would take it straight back.
 *
 * The class prefix is `drawer`, NOT `sheet`: `.sheet` is already SearchScreen's
 * contact-sheet grid (`display: grid; repeat(auto-fill, minmax(232px, 1fr))`).
 * Reusing the name made this element inherit that grid, so its header and body
 * became side-by-side grid items and the body's three columns collapsed into
 * one ~250px track — predicates wrapped one character per line. A base rule
 * that does not reset `display` inherits whatever the colliding rule set.
 */

import React from "react";
import type { GraphDTO, GraphNodeDTO, NearestNodeDTO } from "@shared/types";

interface Props {
  node: GraphNodeDTO | null;
  nearest?: NearestNodeDTO[] | undefined;
  slots: GraphDTO["slots"];
  bindings: Record<string, string>;
  allowLaunch: boolean;
  busy: boolean;
  edgeCounts: { in: number; out: number };
  onBind: (name: string, value: string) => void;
  onAllowLaunch: (on: boolean) => void;
  onRun: () => void;
  onClose: () => void;
}

export function NodeSheet({
  node,
  nearest,
  slots,
  bindings,
  allowLaunch,
  busy,
  edgeCounts,
  onBind,
  onAllowLaunch,
  onRun,
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
          {/* Two DIFFERENT reasons a node cannot be located, and saying the
              wrong one is worse than saying nothing. An empty set is vacuously
              a subset of every observation, so a zero-predicate node would
              match any desktop at all and `locateNode` excludes it outright;
              an `app`-only set is satisfied by every state in that one
              application. Measured on the real graph: n0 has NO predicates and
              was being told its identity was "only `app`". */}
          {node.predicates.length === 0 ? (
            <span className="drawer__warn">
              no predicates — it can neither be verified nor located, because an empty set is
              vacuously true of every desktop
            </span>
          ) : (
            !node.locatable && (
              <span className="drawer__warn">
                verifies but never locates — its identity is only `app`, which every state in that
                application satisfies
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
              <p className="muted">No predicates — this state cannot be verified or located.</p>
            ) : (
              <ul>
                {node.predicates.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="drawer__run">
            <h3 className="eyebrow">Run</h3>
            {/* Only when the graph actually has slots — an empty control is
                worse than no control. */}
            {slots.map((s) => (
              <label key={s.name} className="drawer__slot">
                {s.name}
                <input
                  list={`slot-${s.name}`}
                  value={bindings[s.name] ?? ""}
                  onChange={(e) => onBind(s.name, e.target.value)}
                />
                <datalist id={`slot-${s.name}`}>
                  {s.samples.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </label>
            ))}
            <label className="drawer__launch">
              <input
                type="checkbox"
                checked={allowLaunch}
                onChange={(e) => onAllowLaunch(e.target.checked)}
              />
              allow launching apps
            </label>
            <button
              className="btn"
              disabled={busy || !node.locatable}
              onClick={onRun}
              title={
                node.locatable
                  ? undefined
                  : node.predicates.length === 0
                    ? "This state carries no predicates, so it matches every desktop and cannot be a goal"
                    : "This state cannot be located, so it cannot be reached as a goal"
              }
            >
              Run to here
            </button>
          </section>
        </div>
      </aside>
    );
  }

  if (nearest !== undefined && nearest.length > 0) {
    return (
      <aside className="drawer">
        <header className="drawer__head">
          <span className="drawer__title">Why nothing matched</span>
          <button className="drawer__close" onClick={onClose} title="Close (Esc)">
            ╳
          </button>
        </header>
        <div className="drawer__body drawer__body--diagnosis">
          <p className="muted">
            Locating is a subset check — every predicate a state claims must hold.
          </p>
          {nearest.map((n) => (
            <div key={n.nodeId} className="nearby">
              <div className="nearby__head">
                <span title={n.nodeId}>{n.label}</span>
                <span className="nearby__score">
                  {n.held}/{n.total}
                </span>
              </div>
              <ul>
                {n.missing.map((m, i) => (
                  <li key={i}>✗ {m}</li>
                ))}
                {n.more > 0 && <li className="muted">+{n.more} more</li>}
              </ul>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return null;
}
