/**
 * The graph, laid out by rank. No layout dependency: `@vidstack/react` was worth
 * one because a media player is not 60 lines; a layered layout for tens of nodes
 * is.
 */

import React, { useMemo, useRef, useState } from "react";
import type { GraphDTO } from "@shared/types";

const CARD_W = 180;
const CARD_H = 132;
const GAP_X = 90;
const GAP_Y = 28;

interface Props {
  graph: GraphDTO;
  goalId: string | null;
  locationNodeId?: string | undefined;
  onPick: (nodeId: string) => void;
}

export function GraphCanvas({
  graph,
  goalId,
  locationNodeId,
  onPick,
}: Props): React.JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  /** Column per rank, stacked in graph order so layout is stable across polls. */
  const placed = useMemo(() => {
    const perRank = new Map<number, number>();
    return graph.nodes.map((n) => {
      const row = perRank.get(n.rank) ?? 0;
      perRank.set(n.rank, row + 1);
      return { node: n, x: n.rank * (CARD_W + GAP_X), y: row * (CARD_H + GAP_Y) };
    });
  }, [graph]);

  const at = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);

  const width = Math.max(...placed.map((p) => p.x + CARD_W), CARD_W) + 48;
  const height = Math.max(...placed.map((p) => p.y + CARD_H), CARD_H) + 48;

  return (
    <div
      className="gcanvas"
      onWheel={(e) => setZoom((z) => Math.min(2, Math.max(0.35, z - e.deltaY * 0.001)))}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <div
        className="gcanvas__world"
        style={{
          width,
          height,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        <svg className="gcanvas__wires" width={width} height={height}>
          {graph.edges.map((e) => {
            const a = at.get(e.from);
            const b = at.get(e.to);
            if (a === undefined || b === undefined) return null;
            const x1 = a.x + CARD_W;
            const y1 = a.y + CARD_H / 2;
            const x2 = b.x;
            const y2 = b.y + CARD_H / 2;
            // A back edge bows below rather than cutting through the cards it
            // passes. A loop is a real feature of a merged graph.
            const bow = e.back ? Math.max(60, Math.abs(y2 - y1)) : 0;
            const mid = (x1 + x2) / 2;
            const d = e.back
              ? `M ${x1} ${y1} C ${mid} ${y1 + bow}, ${mid} ${y2 + bow}, ${x2} ${y2}`
              : `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
            return (
              <path
                key={e.id}
                d={d}
                className={`gwire${e.back ? " is-back" : ""}${
                  e.provenance === "synthesized" ? " is-synth" : ""
                }`}
              />
            );
          })}
        </svg>

        {placed.map(({ node, x, y }) => {
          const here = node.id === locationNodeId;
          const goal = node.id === goalId;
          return (
            <button
              key={node.id}
              className={`gnode${here ? " is-here" : ""}${goal ? " is-goal" : ""}`}
              style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
              onClick={() => onPick(node.id)}
              title={`${node.label} · ${node.observations} observation${
                node.observations === 1 ? "" : "s"
              }`}
            >
              {node.frameBlobId !== undefined ? (
                <img
                  className="gnode__shot"
                  src={`deskrag://frame/${node.frameBlobId}`}
                  alt=""
                  draggable={false}
                />
              ) : (
                <div className="gnode__shot gnode__shot--none">no keyframe</div>
              )}
              <div className="gnode__label">{node.label}</div>
              <div className="gnode__meta">
                <span className="gnode__id">{node.id}</span>
                {node.id === graph.entry && <span className="gnode__tag">entry</span>}
                {here && <span className="gnode__tag is-here">you are here</span>}
                {goal && <span className="gnode__tag is-goal">goal</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
