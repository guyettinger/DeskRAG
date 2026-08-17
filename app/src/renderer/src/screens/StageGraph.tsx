import React, { useEffect, useRef, useState } from "react";
import type { IndexStageDTO } from "@shared/types";
import { NODE_H, layoutStages, stageElapsed, stageTone } from "./index-graph-view.js";

/**
 * The indexing pipeline, drawn.
 *
 * `.stagenode`, not `.stage`: `styles.css` has no scoping, so a class name is a
 * repo-wide identifier — and "stage" already means "the main pane of a screen"
 * in five selectors (`.record__stage`, `.library__stage`, `.detail__stage`,
 * `.flows__stage`, `.jobs__stage`). Claiming it for a pipeline stage is exactly
 * how `.sheet` and `.drawer` went wrong.
 *
 * HTML boxes for the nodes and ONE inline `<svg>` for the wires — the same
 * division as `GraphCanvas`, and for the same reason: a node carries prose and
 * has to be hit-testable, a wire is continuous geometry. There is no pan or
 * zoom, because there are twelve fixed nodes and they always fit.
 *
 * **Row is when it runs; column is what it depends on.** `runStages` is a
 * strictly sequential loop, so reading top to bottom IS the execution order —
 * which is what makes this a picture of a pipeline rather than a picture of a
 * dependency graph that happens to be run somehow.
 *
 * NOTHING TRUNCATES. A detail line either fits or is withheld, which is why the
 * boxes stretch to the pane and the detail wraps rather than ellipsizing.
 */
export function StageGraph({ stages }: { stages: IndexStageDTO[] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Measured, never assumed: the node boxes stretch to the pane, and a fixed
  // width here against a percentage in CSS is exactly the pair that drifted in
  // the rail's thumbnails with nothing enforcing it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = layoutStages(stages, width);

  return (
    <div className="stagemap" ref={ref} style={{ height: `${layout.height}px` }}>
      {/* `overflow: visible` in CSS, so a wire that bows into the gutter is not
          clipped by its own viewport. */}
      <svg className="stagemap__wires" width={Math.max(1, width)} height={Math.max(1, layout.height)}>
        {layout.wires.map((w) => (
          <path key={w.key} d={w.d} className="stagewire" />
        ))}
      </svg>

      {layout.nodes.map(({ stage, x, y }) => (
        <StageNode key={stage.id} stage={stage} x={x} y={y} width={width} gutter={layout.gutter} />
      ))}
    </div>
  );
}

function StageNode({
  stage,
  x,
  y,
  width,
  gutter,
}: {
  stage: IndexStageDTO;
  x: number;
  y: number;
  width: number;
  gutter: number;
}): React.JSX.Element {
  const elapsed = stageElapsed(stage.elapsedMs);
  return (
    <div
      className={`stagenode stagenode--${stage.state}`}
      data-tone={stageTone(stage.state)}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        // The box takes whatever is left after its own indent, so a deep node is
        // narrower rather than overflowing. Floored so a zero-width first frame
        // (before the ResizeObserver fires) cannot produce a negative width.
        width: `${Math.max(0, width - x - gutter / 2)}px`,
        height: `${NODE_H}px`,
      }}
    >
      <span className="stagenode__glyph" aria-hidden="true" />
      <div className="stagenode__text">
        <div className="stagenode__head">
          <span className="stagenode__name">{stage.label}</span>
          {/* Only when there is a real measurement. A stage that has not run has
              nothing to say about how long it took. */}
          {elapsed !== null && <span className="stagenode__time mono">{elapsed}</span>}
        </div>
        {/* A skipped stage STATES ITS REASON rather than merely dimming: a stage
            that dropped out silently is indistinguishable from one nobody
            implemented, which is the failure mode the gates keep producing. */}
        {stage.detail !== null && <div className="stagenode__detail">{stage.detail}</div>}
      </div>
    </div>
  );
}
