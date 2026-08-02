/**
 * The graph's detail surface: one sheet, three possible contents, in strict
 * precedence — selected node, then the locating diagnosis, then nothing.
 *
 * It rises from the bottom rather than sitting beside the canvas. A downward
 * flow is tall and narrow, so horizontal room is exactly what the transpose
 * freed; an inspector column would take it straight back.
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
      <aside className="sheet">
        <header className="sheet__head">
          <span className="sheet__chip">{node.chip}</span>
          <span className="sheet__title">{node.label}</span>
          <span className="muted">
            {node.observations} observation{node.observations === 1 ? "" : "s"} · {edgeCounts.in} in
            · {edgeCounts.out} out
          </span>
          {!node.locatable && (
            <span className="sheet__warn">
              verifies but never locates — its identity is only `app`, which every state in that
              application satisfies
            </span>
          )}
          <button className="sheet__close" onClick={onClose} title="Close (Esc)">
            ╳
          </button>
        </header>

        <div className="sheet__body">
          {node.frameBlobId !== undefined ? (
            <img className="sheet__shot" src={`deskrag://frame/${node.frameBlobId}`} alt="" />
          ) : (
            <div className="sheet__shot sheet__shot--none">no keyframe</div>
          )}

          <section className="sheet__preds">
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

          <section className="sheet__run">
            <h3 className="eyebrow">Run</h3>
            {/* Only when the graph actually has slots — an empty control is
                worse than no control. */}
            {slots.map((s) => (
              <label key={s.name} className="sheet__slot">
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
            <label className="sheet__launch">
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
      <aside className="sheet">
        <header className="sheet__head">
          <span className="sheet__title">Why nothing matched</span>
          <button className="sheet__close" onClick={onClose} title="Close (Esc)">
            ╳
          </button>
        </header>
        <div className="sheet__body sheet__body--diagnosis">
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
