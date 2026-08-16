import React, { useEffect, useMemo, useState } from "react";
import type { UIElementDTO } from "@shared/types";

interface Props {
  /** Flat, with `parent` back-references already filled in by main. */
  nodes: UIElementDTO[];
  /** Frame space (screen points). 0 means this recording never stored its dims. */
  frameW: number;
  frameH: number;
  selected: number | null;
  onSelect: (index: number | null) => void;
  onHover: (index: number | null) => void;
}

/** Rows at or below this depth start open; deeper subtrees stay folded. */
const AUTO_EXPAND_DEPTH = 2;

/**
 * The captured accessibility tree, as a tree. Selecting a row draws that
 * element's bbox on the keyframe beside it, which is the whole point: the AX
 * snapshot is the only index that says *where* a thing was, and a flat tag cloud
 * threw both the structure and the geometry away.
 *
 * A walk can return thousands of nodes, so rows are folded past
 * AUTO_EXPAND_DEPTH and only the visible ones are rendered.
 */
export function AxTree({ nodes, frameW, frameH, selected, onSelect, onHover }: Props): React.JSX.Element {
  const { roots, childrenOf } = useMemo(() => {
    const childrenOf: number[][] = nodes.map(() => []);
    const roots: number[] = [];
    nodes.forEach((n, i) => {
      // Main guarantees a parent precedes its child, but this arrives over IPC —
      // re-check rather than risk a cycle turning the render into a hang.
      if (n.parent !== undefined && n.parent >= 0 && n.parent < i) childrenOf[n.parent]!.push(i);
      else roots.push(i);
    });
    return { roots, childrenOf };
  }, [nodes]);

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => {
    setExpanded(
      new Set(nodes.flatMap((n, i) => ((n.depth ?? 0) < AUTO_EXPAND_DEPTH && childrenOf[i]!.length > 0 ? [i] : []))),
    );
  }, [nodes, childrenOf]);

  const toggle = (i: number): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  // Flatten to the rows actually on screen — a folded subtree costs nothing.
  const visible = useMemo(() => {
    const out: number[] = [];
    const walk = (i: number): void => {
      out.push(i);
      if (expanded.has(i)) for (const c of childrenOf[i]!) walk(c);
    };
    for (const r of roots) walk(r);
    return out;
  }, [roots, childrenOf, expanded]);

  const locatable = frameW > 0 && frameH > 0;
  /** AX coords are global, so a window on another display is legitimately outside. */
  const onFrame = (n: UIElementDTO): boolean =>
    locatable && n.x < frameW && n.y < frameH && n.x + n.w > 0 && n.y + n.h > 0;

  return (
    <div className="field">
      <div className="field__head">
        <span className="field__label">Accessibility ({nodes.length})</span>
        {nodes.length > 0 && (
          <button
            className="field__action"
            onClick={() =>
              setExpanded(
                expanded.size > 0 ? new Set() : new Set(nodes.flatMap((_, i) => (childrenOf[i]!.length > 0 ? [i] : []))),
              )
            }
          >
            {expanded.size > 0 ? "collapse all" : "expand all"}
          </button>
        )}
      </div>

      {nodes.length === 0 ? (
        <span className="field__text field__text--empty">no AX captured for this frame</span>
      ) : (
        <>
          {!locatable && (
            <span className="axtree__hint">
              this recording didn’t store its screen dimensions, so elements can’t be located on the keyframe
            </span>
          )}
          <div className="axtree" role="tree" aria-label="Accessibility tree">
            {visible.map((i) => {
              const n = nodes[i]!;
              const kids = childrenOf[i]!;
              const open = expanded.has(i);
              const off = !onFrame(n);
              return (
                <button
                  key={i}
                  role="treeitem"
                  aria-level={(n.depth ?? 0) + 1}
                  {...(kids.length > 0 ? { "aria-expanded": open } : {})}
                  aria-selected={selected === i}
                  className={[
                    "axtree__row",
                    selected === i ? "axtree__row--selected" : "",
                    off ? "axtree__row--off" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ paddingLeft: 6 + (n.depth ?? 0) * 11 }}
                  title={off ? (locatable ? "outside the captured frame" : undefined) : `${n.x},${n.y} ${n.w}×${n.h}`}
                  onClick={() => (off ? kids.length > 0 && toggle(i) : onSelect(selected === i ? null : i))}
                  onKeyDown={(e) => {
                    // Standard tree keys, so the caret isn't mouse-only.
                    if (e.key === "ArrowRight" && kids.length > 0 && !open) toggle(i);
                    else if (e.key === "ArrowLeft" && open) toggle(i);
                    else return;
                    e.preventDefault();
                  }}
                  onMouseEnter={() => onHover(off ? null : i)}
                  onMouseLeave={() => onHover(null)}
                >
                  <span
                    className={`axtree__caret${open ? " axtree__caret--open" : ""}`}
                    onClick={(e) => {
                      if (kids.length === 0) return;
                      e.stopPropagation(); // expand without also selecting
                      toggle(i);
                    }}
                  >
                    {kids.length > 0 ? "▸" : ""}
                  </span>
                  <span className="axtree__role">{n.role}</span>
                  {n.label && <span className="axtree__label">{n.label}</span>}
                  {/* WHICH element had the keyboard. It is on every capture and
                      was never drawn, though it is the one property that says
                      where the session was actually pointed at this instant. */}
                  {n.focused && (
                    <span className="axtree__focused" title="had keyboard focus">
                      focus
                    </span>
                  )}
                  {kids.length > 0 && !open && <span className="axtree__count">{kids.length}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
