/**
 * The graph, flowing downward. Layout lives in `graph-layout.ts` (pure, and in
 * the root suite); this file is the canvas, the cards, the wires and the
 * controls.
 *
 * Pan and zoom are kept — a merged graph has branches and loops, and there is
 * no overview without zoom — but they are not the only way to navigate: the
 * canvas fits on mount, and selecting a route frames it.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GraphDTO } from "@shared/types";
import { CARD_H, CARD_W, layoutGraph } from "./graph-layout.js";

/** Pixels of travel before a press becomes a pan rather than a click. */
const DRAG_THRESHOLD = 4;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

/**
 * Wire weight from observation count.
 *
 * Sub-linear on purpose: the question a reader asks is "is this path worn?",
 * not "by exactly how much". Linear width would make one heavily-repeated task
 * a black bar that hides everything crossing it.
 */
const WIRE_MIN = 1.4;
const WIRE_MAX = 6;
function wireWidth(observations: number): number {
  return Math.min(WIRE_MAX, WIRE_MIN + Math.log2(Math.max(1, observations)) * 1.6);
}

/**
 * The invisible band that makes a wire clickable.
 *
 * A 2px path is essentially un-hittable with a mouse, so each wire is drawn
 * twice: a fat transparent path for hit-testing under the visible one. This is
 * the standard technique and the reason `pointer-events: stroke` exists — fill
 * would make the area *enclosed* by a curve clickable too, which for a back
 * edge bowing out to the margin is most of the canvas.
 */
const HIT_WIDTH = 16;

export interface Selection {
  kind: "node" | "edge";
  id: string;
}

export interface Highlight {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

interface Props {
  graph: GraphDTO;
  selected: Selection | null;
  /** A selected route's members. Everything else dims. */
  highlight?: Highlight | undefined;
  /** Only nodes in this app stay lit. Undefined means every app. */
  appFilter?: string | undefined;
  onSelect: (selection: Selection | null) => void;
  onAppFilter: (app: string | undefined) => void;
}

export function GraphCanvas({
  graph,
  selected,
  highlight,
  appFilter,
  onSelect,
  onAppFilter,
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

  /**
   * Which nodes the app filter leaves lit, and which edges are then implied.
   *
   * Filtering DIMS rather than removes. A cross-app flow's shape is the thing
   * being read, and deleting the other half of it would leave wires ending in
   * mid-air — the layout is computed from the whole graph either way, so a
   * hidden node's space would stay reserved and the picture would just be
   * wrong.
   */
  const inApp = useMemo(() => {
    if (appFilter === undefined) return null;
    return new Set(graph.nodes.filter((n) => n.app === appFilter).map((n) => n.id));
  }, [graph, appFilter]);

  const apps = useMemo(() => {
    const seen = new Set<string>();
    for (const n of graph.nodes) if (n.app !== undefined) seen.add(n.app);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [graph]);

  const nodeDimmed = (id: string): boolean =>
    (inApp !== null && !inApp.has(id)) || (highlight !== undefined && !highlight.nodes.has(id));

  const edgeDimmed = (id: string, from: string, to: string): boolean =>
    (inApp !== null && !(inApp.has(from) || inApp.has(to))) ||
    (highlight !== undefined && !highlight.edges.has(id));

  /**
   * Frame a set of cards: the largest zoom at which their bounding box fits,
   * centred. Passing every node is "fit the whole graph"; passing a route's
   * nodes is "show me this flow".
   */
  const frame = (ids?: ReadonlySet<string>): void => {
    const box = viewport.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return;
    const placed = layout.nodes.filter((p) => ids === undefined || ids.has(p.node.id));
    if (placed.length === 0) return;

    const pad = 32;
    const minX = Math.min(...placed.map((p) => p.x)) - pad;
    const minY = Math.min(...placed.map((p) => p.y)) - pad;
    const w = Math.max(...placed.map((p) => p.x + CARD_W)) + pad - minX;
    const h = Math.max(...placed.map((p) => p.y + CARD_H)) + pad - minY;

    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(box.width / w, box.height / h)));
    setZoom(z);
    setPan({ x: (box.width - w * z) / 2 - minX * z, y: (box.height - h * z) / 2 - minY * z });
  };

  const fit = (): void => frame();

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
   * The node the ◎ button and a route selection aim at. An edge is centred by
   * its source, which is where reading it starts.
   */
  const focusNode = (): string | undefined => {
    if (selected?.kind === "node") return selected.id;
    if (selected?.kind === "edge") {
      return graph.edges.find((e) => e.id === selected.id)?.from;
    }
    return undefined;
  };

  /**
   * True once the reader has navigated by hand — a pan, a zoom, or picking a
   * route. It is what stops the automatic re-fit below from fighting them.
   */
  const touched = useRef(false);

  /**
   * Selecting a route FRAMES it — zoom and all. Without this, picking one from
   * the column lights up part of a graph that may be scrolled entirely off
   * screen, which reads as the click doing nothing.
   *
   * It has to be a frame rather than a centring: centring on the route's first
   * node keeps the fitted zoom, which on a real graph (17 nodes, nine of them
   * in one rank) pushed all but two cards out of the viewport. Measured in the
   * running app — the route lit up correctly and could not be seen.
   */
  const routeKey = highlight === undefined ? "" : [...highlight.nodes].join(",");
  useEffect(() => {
    if (routeKey === "") return;
    touched.current = true;
    frame(new Set(routeKey.split(",")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  /**
   * Fit on mount, and again whenever the viewport RESIZES — but never once the
   * reader has navigated by hand.
   *
   * The screen this replaced fitted exactly once, because a 2s location poll
   * re-rendered it and any re-fit would yank the canvas out from under whoever
   * was reading. That poller is gone with the executor, so the only thing left
   * that changes the viewport is the drawer opening (it takes ~40% of the
   * height) and the window resizing — and in both cases holding the old framing
   * is wrong: measured in the running app, selecting a node left the cards
   * running underneath the zoom controls.
   *
   * `touched` is what keeps it from fighting the reader: a pan, a zoom or a
   * route selection all mean the framing is now theirs, not ours.
   */
  const fitted = useRef(false);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el === null || layout.nodes.length === 0) return;
    if (!fitted.current) {
      fitted.current = true;
      fit();
    }
    const ro = new ResizeObserver(() => {
      if (!touched.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
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
        onWheel={(e) => {
          touched.current = true;
          setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z - e.deltaY * 0.001)));
        }}
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
            touched.current = true;
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
            {layout.edges.map(({ edge, d }) => {
              const isSelected = selected?.kind === "edge" && selected.id === edge.id;
              const dimmed = edgeDimmed(edge.id, edge.from, edge.to);
              return (
                <g key={edge.id}>
                  <path
                    d={d}
                    className="gwire__hit"
                    strokeWidth={HIT_WIDTH}
                    onClick={(e) => {
                      // The surface's pointerup would otherwise deselect right
                      // after — the same trap the node buttons document.
                      e.stopPropagation();
                      onSelect({ kind: "edge", id: edge.id });
                    }}
                  >
                    <title>
                      {`${edge.observations} recording${edge.observations === 1 ? "" : "s"} · ` +
                        `${edge.actions.length} action${edge.actions.length === 1 ? "" : "s"}`}
                    </title>
                  </path>
                  <path
                    d={d}
                    // Weight is a READING, not decoration: a wire walked five
                    // times has to look different from one walked once, which
                    // is most of what "common flow" means on this canvas.
                    strokeWidth={wireWidth(edge.observations)}
                    className={
                      `gwire${edge.back ? " is-back" : ""}` +
                      `${edge.provenance === "synthesized" ? " is-synth" : ""}` +
                      `${isSelected ? " is-selected" : ""}${dimmed ? " is-dim" : ""}`
                    }
                  />
                </g>
              );
            })}
          </svg>

          {layout.nodes.map(({ node, x, y }) => {
            const isSelected = selected?.kind === "node" && selected.id === node.id;
            return (
              <button
                key={node.id}
                className={
                  `gnode${isSelected ? " is-selected" : ""}` +
                  `${node.locatable ? "" : " is-unlocatable"}` +
                  `${nodeDimmed(node.id) ? " is-dim" : ""}`
                }
                style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
                onClick={(e) => {
                  // The surface's pointerup would otherwise deselect right after.
                  e.stopPropagation();
                  onSelect({ kind: "node", id: node.id });
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
                  {node.observations > 1 && (
                    <span
                      className="gnode__tag is-seen"
                      title="Recorded this many times — the states you return to"
                    >
                      ×{node.observations}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="gcanvas__controls">
        {apps.length > 1 && (
          <select
            className="gbtn gbtn--select"
            value={appFilter ?? ""}
            onChange={(e) => onAppFilter(e.target.value === "" ? undefined : e.target.value)}
            title="Dim everything outside one application"
          >
            <option value="">all apps</option>
            {apps.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        )}
        <button
          className="gbtn"
          onClick={() => {
            touched.current = true;
            setZoom((z) => Math.min(MAX_ZOOM, z + 0.2));
          }}
          title="Zoom in"
        >
          +
        </button>
        <button
          className="gbtn"
          onClick={() => {
            touched.current = true;
            setZoom((z) => Math.max(MIN_ZOOM, z - 0.2));
          }}
          title="Zoom out"
        >
          −
        </button>
        {/* `fit` is the reader asking for our framing BACK, so it clears the
            flag and re-enables automatic re-fitting. */}
        <button
          className="gbtn"
          onClick={() => {
            touched.current = false;
            fit();
          }}
          title="Fit the whole graph"
        >
          fit
        </button>
        <button
          className="gbtn"
          disabled={focusNode() === undefined}
          onClick={() => {
            touched.current = true;
            const id = focusNode();
            if (id !== undefined) centreOn(id);
          }}
          title={focusNode() === undefined ? "Nothing selected" : "Centre on the selection"}
        >
          ◎
        </button>
      </div>
    </div>
  );
}
