/**
 * The graph, flowing downward. Layout lives in `graph-layout.ts` (pure, and in
 * the root suite); this file is the canvas, the cards and the controls.
 *
 * Pan and zoom are kept — a merged graph has branches and loops, and there is
 * no overview without zoom — but they are no longer the only way to navigate:
 * the canvas fits on mount, and `◎ me` returns to the located node.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GraphDTO } from "@shared/types";
import { CARD_H, CARD_W, layoutGraph } from "./graph-layout.js";

/** Pixels of travel before a press becomes a pan rather than a click. */
const DRAG_THRESHOLD = 4;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

interface Props {
  graph: GraphDTO;
  selectedId: string | null;
  locationNodeId?: string | undefined;
  onSelect: (nodeId: string | null) => void;
}

export function GraphCanvas({
  graph,
  selectedId,
  locationNodeId,
  onSelect,
}: Props): React.JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const viewport = useRef<HTMLDivElement | null>(null);
  /**
   * Pointer capture must NOT start on pointerdown. Capturing redirects every
   * later pointer event to this div, so the node button never sees its own
   * pointerup and no click is ever synthesized — the canvas pans and nothing is
   * ever selectable. Capture only once the pointer has actually travelled.
   */
  const drag = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);

  const layout = useMemo(() => layoutGraph(graph), [graph]);

  /** Centre the whole graph in the viewport at the largest zoom that fits. */
  const fit = (): void => {
    const box = viewport.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return;
    const z = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(box.width / layout.width, box.height / layout.height)),
    );
    setZoom(z);
    setPan({
      x: (box.width - layout.width * z) / 2,
      y: (box.height - layout.height * z) / 2,
    });
  };

  /** Centre one card without changing zoom. */
  const centreOn = (nodeId: string): void => {
    const box = viewport.current?.getBoundingClientRect();
    const p = layout.at.get(nodeId);
    if (box === undefined || p === undefined) return;
    setPan({
      x: box.width / 2 - (p.x + CARD_W / 2) * zoom,
      y: box.height / 2 - (p.y + CARD_H / 2) * zoom,
    });
  };

  /**
   * Fit ONCE per mount, not on every graph change: the location poll re-renders
   * this component every 2s, and re-fitting would move the canvas out from
   * under whoever is reading it.
   */
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || layout.nodes.length === 0) return;
    fitted.current = true;
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);

  return (
    <div className="gcanvas" ref={viewport}>
      <div
        className="gcanvas__surface"
        onWheel={(e) =>
          setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z - e.deltaY * 0.001)))
        }
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d === null) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          // Below the threshold this is still a click, so leave the pointer alone.
          if (!d.moved) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            d.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          setPan({ x: d.panX + dx, y: d.panY + dy });
        }}
        onPointerUp={() => {
          // A press that never travelled is a click on empty canvas: deselect.
          // The threshold above is what stops this firing at the end of a pan.
          if (drag.current !== null && !drag.current.moved) onSelect(null);
          drag.current = null;
        }}
        onDoubleClick={fit}
      >
        <div
          className="gcanvas__world"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg className="gcanvas__wires" width={layout.width} height={layout.height}>
            {layout.edges.map(({ edge, d }) => (
              <path
                key={edge.id}
                d={d}
                className={`gwire${edge.back ? " is-back" : ""}${
                  edge.provenance === "synthesized" ? " is-synth" : ""
                }`}
              />
            ))}
          </svg>

          {layout.nodes.map(({ node, x, y }) => {
            const here = node.id === locationNodeId;
            const selected = node.id === selectedId;
            return (
              <button
                key={node.id}
                className={`gnode${here ? " is-here" : ""}${selected ? " is-selected" : ""}${
                  node.locatable ? "" : " is-unlocatable"
                }`}
                style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
                onClick={(e) => {
                  // The surface's pointerup would otherwise deselect right after.
                  e.stopPropagation();
                  onSelect(node.id);
                }}
                title={`${node.id}\n${node.label} · ${node.observations} observation${
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
                  <span className="gnode__id">{node.chip}</span>
                  {node.id === graph.entry && <span className="gnode__tag">entry</span>}
                  {here && <span className="gnode__tag is-here">you are here</span>}
                  {!node.locatable && (
                    <span
                      className="gnode__tag is-warn"
                      title="Identity is only `app`, which every state in that application satisfies"
                    >
                      unlocatable
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="gcanvas__controls">
        <button
          className="gbtn"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.2))}
          title="Zoom in"
        >
          +
        </button>
        <button
          className="gbtn"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.2))}
          title="Zoom out"
        >
          −
        </button>
        <button className="gbtn" onClick={fit} title="Fit the whole graph">
          fit
        </button>
        <button
          className="gbtn"
          disabled={locationNodeId === undefined}
          onClick={() => locationNodeId !== undefined && centreOn(locationNodeId)}
          title={locationNodeId === undefined ? "Nothing is located" : "Centre on where you are"}
        >
          ◎ me
        </button>
      </div>
    </div>
  );
}
