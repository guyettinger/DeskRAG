import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FrameHitDTO, HighlightDTO, ResultDetailDTO } from "@shared/types";
import { laneText } from "@shared/evidence";
import { api, timecode, wallClock } from "../api.js";
import { IconClose, IconLibrary } from "../icons.js";
import { AxTree } from "./AxTree.js";
import {
  MAX_SCALE,
  MIN_SCALE,
  SCALE_STEP,
  bboxLabelFits,
  boxRect,
  boxWidthPx,
  deviceScale,
  fitScale,
  frameBox,
  isPastCapture,
  oneToOneScale,
  type Bbox,
} from "../detail-view.js";

/**
 * What the RESULT LIST knew and the overlay used to lose.
 *
 * Every field here is relative to one query's result set, which is precisely why
 * it arrives as a prop instead of on `ResultDetailDTO`: `detailWith` also serves
 * the Library and the MCP endpoint, where there is no list for a rank to be a
 * rank within. The same reasoning that kept `score` off the DTO.
 *
 * Absent from the Library, so every section built from it is ABSENT there too —
 * never present and empty. "No evidence" would be a claim about the retrieval;
 * the truth is that nothing was retrieved, because nothing was asked.
 */
export interface SearchContext {
  hit: FrameHitDTO;
  /** 1-based position in the result list. */
  rank: number;
  /** Bar fill against the best hit in that list, from `evidenceBars`. */
  fill: number;
  /** Every hit scored identically, so the ordering carries no information. */
  tied: boolean;
}

interface Props {
  frameId: string;
  onClose: () => void;
  /**
   * Jump to this frame's recording in the Library.
   *
   * OPTIONAL, and that is load-bearing: `SessionPlayer` opens this same view to
   * inspect a keyframe, where the button would point at the screen the reader
   * is already on. Absent there, present from Search.
   */
  onOpenRecording?: (sessionId: string, atSec: number) => void;
  /** Present only when Search opened this. See `SearchContext`. */
  openedFrom?: SearchContext;
}

/** A press-and-move past this is a pan, not a click on whatever is underneath. */
const DRAG_SLOP = 4;

export function DetailView({ frameId, onClose, onOpenRecording, openedFrom }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<ResultDetailDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const [selectedAx, setSelectedAx] = useState<number | null>(null);
  const [hoveredAx, setHoveredAx] = useState<number | null>(null);
  const [activeHit, setActiveHit] = useState<string | null>(null);
  /** The stored JPEG's own pixel size — the ceiling of what was captured. */
  const [img, setImg] = useState<{ w: number; h: number } | null>(null);
  /** The stage's client box, measured. `fitScale` returns 0 until it is. */
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** null means FIT — a resize keeps the frame fitted instead of freezing a number. */
  const [scale, setScale] = useState<number | null>(null);
  const [panning, setPanning] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** Where focus came from, so closing puts it back on the row that opened this. */
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    let ignore = false;
    setDetail(null);
    setMissing(false);
    setSelectedAx(null);
    setHoveredAx(null);
    setActiveHit(null);
    setImg(null);
    setScale(null);
    void api.search.detail(frameId).then((d) => {
      if (ignore) return;
      // detail() resolves null for a frame that no longer exists; without this it
      // is indistinguishable from "still loading" and spins forever.
      if (d) setDetail(d);
      else setMissing(true);
    });
    return () => {
      ignore = true;
    };
  }, [frameId]);

  // The stage is the zoom's denominator, so it is MEASURED — the TrackRail
  // precedent, where the axis width comes from a ResizeObserver and never from a
  // guess. A resize while zoomed keeps the scale; a resize at fit re-fits.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [detail]);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    };
  }, []);

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const fit = img ? fitScale(stage.w, stage.h, img.w, img.h) : 0;
  const current = scale ?? fit;
  const canvasW = img ? img.w * current : 0;
  const past = isPastCapture(current, dpr);

  /** Apply a new scale about a point in the stage, keeping it under the cursor. */
  const zoomTo = useCallback(
    (next: number, cursorX?: number, cursorY?: number): void => {
      const el = stageRef.current;
      const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
      if (!el || !img) {
        setScale(clamped);
        return;
      }
      const from = scale ?? fitScale(el.clientWidth, el.clientHeight, img.w, img.h);
      const cx = cursorX ?? el.clientWidth / 2;
      const cy = cursorY ?? el.clientHeight / 2;
      const left = (el.scrollLeft + cx) / from * clamped - cx;
      const top = (el.scrollTop + cy) / from * clamped - cy;
      setScale(clamped);
      // After the canvas has been re-sized, or the scroll clamps against the old
      // extent and the point under the cursor slides away.
      requestAnimationFrame(() => {
        el.scrollLeft = left;
        el.scrollTop = top;
      });
    },
    [img, scale],
  );

  /** Frame one bbox in the stage — what clicking a hit or an AX row lands on. */
  const goToBox = useCallback(
    (b: Bbox): void => {
      const el = stageRef.current;
      if (!el || !img || !detail || detail.width <= 0 || detail.height <= 0) return;
      const v = frameBox(
        b,
        detail.width,
        detail.height,
        img.w,
        img.h,
        el.clientWidth,
        el.clientHeight,
        current,
      );
      setScale(v.scale);
      requestAnimationFrame(() => {
        const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollTo({ left: v.scrollLeft, top: v.scrollTop, behavior: smooth ? "smooth" : "auto" });
      });
    },
    [img, detail, current],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // The loupe's keys. `SessionPlayer` sets `keyDisabled` while this is open,
      // so they cannot reach Vidstack's own shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "0") setScale(null);
      else if (e.key === "1") zoomTo(oneToOneScale(dpr));
      else if (e.key === "+" || e.key === "=") zoomTo(current * SCALE_STEP);
      else if (e.key === "-" || e.key === "_") zoomTo(current / SCALE_STEP);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoomTo, current, dpr]);

  const onWheel = (e: React.WheelEvent): void => {
    const el = stageRef.current;
    if (!el || !img) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    // A trackpad pinch arrives as a wheel with ctrlKey; both paths are the same
    // gesture as far as the stage is concerned.
    zoomTo(current * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    const el = stageRef.current;
    if (!el || e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    let dragging = false;
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
      if (!dragging) {
        dragging = true;
        setPanning(true);
      }
      el.scrollLeft = start.left - dx;
      el.scrollTop = start.top - dy;
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanning(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Frames recorded before the app passed its display size have no frame space,
  // so nothing can be mapped onto them.
  const locatable = detail !== null && detail.width > 0 && detail.height > 0;
  const axBox = (i: number | null): (Bbox & { label: string }) | null => {
    if (!locatable || i === null) return null;
    const n = detail.ax[i];
    return n ? { x: n.x, y: n.y, w: n.w, h: n.h, label: n.label ?? n.role } : null;
  };
  const selectedBox = axBox(selectedAx);
  const hoveredBox = hoveredAx === selectedAx ? null : axBox(hoveredAx);

  const onSelectAx = (i: number | null): void => {
    setSelectedAx(i);
    const b = axBox(i);
    if (b) goToBox(b);
  };

  const highlights = detail?.highlights ?? [];

  return (
    <div className="overlay overlay--wide" onClick={onClose}>
      <div
        className="detail"
        role="dialog"
        aria-modal="true"
        aria-label="Frame detail"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <Head
          detail={detail}
          openedFrom={openedFrom}
          onOpenRecording={onOpenRecording}
          onClose={onClose}
        />

        <div
          className={`detail__stage${panning ? " detail__stage--panning" : ""}`}
          ref={stageRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
        >
          {missing ? (
            <div className="noshot" style={{ position: "static" }}>
              frame no longer exists
            </div>
          ) : !detail ? (
            <div className="spinner" />
          ) : detail.imageUrl ? (
            <div
              className="detail__canvas"
              style={
                {
                  ...(img ? { "--frame-ar": `${img.w} / ${img.h}` } : {}),
                  ...(canvasW > 0 ? { width: `${canvasW}px` } : {}),
                } as React.CSSProperties
              }
            >
              <img
                src={detail.imageUrl}
                alt="Recorded keyframe"
                draggable={false}
                // Past 1:1 the smoothing would invent detail the capture never
                // had. Hard pixels DECLARE the ceiling instead of hiding it.
                style={past ? { imageRendering: "pixelated" } : undefined}
                onLoad={(e) => setImg({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />
              {locatable &&
                highlights.map((h) => (
                  <HitBox
                    key={h.regionId}
                    hit={h}
                    frameW={detail.width}
                    frameH={detail.height}
                    imgW={img?.w ?? 0}
                    scale={current}
                    active={activeHit === h.regionId}
                  />
                ))}
              {hoveredBox && (
                <div className="bbox bbox--ax-hover" style={boxRect(hoveredBox, detail.width, detail.height)} />
              )}
              {selectedBox && (
                <div className="bbox bbox--ax" style={boxRect(selectedBox, detail.width, detail.height)}>
                  {bboxLabelFits(
                    boxWidthPx(selectedBox, detail.width, img?.w ?? 0, current),
                    selectedBox.label,
                  ) && (
                    <span
                      className={`bbox__label bbox__label--ax${
                        selectedBox.y / detail.height < 0.03 ? " bbox__label--inside" : ""
                      }`}
                    >
                      {selectedBox.label}
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="noshot" style={{ position: "static" }}>
              no keyframe image
            </div>
          )}
        </div>

        <Loupe
          scale={current}
          fit={fit}
          dpr={dpr}
          img={img}
          disabled={!detail?.imageUrl}
          onFit={() => setScale(null)}
          onOneToOne={() => zoomTo(oneToOneScale(dpr))}
          onStep={(dir) => zoomTo(dir > 0 ? current * SCALE_STEP : current / SCALE_STEP)}
        />

        <div className="detail__side">
          {detail && (
            <>
              {openedFrom && <Why ctx={openedFrom} />}

              {openedFrom && (
                <Matched
                  highlights={highlights}
                  locatable={locatable}
                  onHover={setActiveHit}
                  onPick={(h) => {
                    setActiveHit(h.regionId);
                    goToBox(h.bbox);
                  }}
                />
              )}

              {/* The task this frame happened inside, above its own text: the
                  wider answer comes first. Unlike the search card, which
                  withholds the line, this names the field even when empty —
                  the same rule every field here follows, because an inspection
                  surface makes absence VISIBLE while a dense result list would
                  just carry one more dim row per card. */}
              <Section label="Task" text={detail.taskSummary} />
              <Section label="Digest" text={detail.segment?.digest} />
              <Section label="Caption" text={detail.segment?.caption} />
              <Section label="Transcript" text={detail.segment?.transcript} />

              <AxTree
                nodes={detail.ax}
                frameW={detail.width}
                frameH={detail.height}
                selected={selectedAx}
                onSelect={onSelectAx}
                onHover={setHoveredAx}
              />

              <Record detail={detail} img={img} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The header spans both columns and does NOT scroll: what this frame is stays
 * put while the evidence under it moves.
 */
function Head({
  detail,
  openedFrom,
  onOpenRecording,
  onClose,
}: {
  detail: ResultDetailDTO | null;
  openedFrom?: SearchContext;
  onOpenRecording?: (sessionId: string, atSec: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="detail__head">
      <div className="detail__ident">
        {detail?.app && (
          // DATA register, and it needs no CSS: `[data-tone]` is global precisely
          // so a surface outside the rail can name an app in that app's colour.
          <span className="detail__app" data-tone={detail.appTone ?? "neutral"}>
            {detail.app}
          </span>
        )}
        <span className="detail__title">
          {detail?.taskSummary ?? (detail ? "this frame" : " ")}
        </span>
      </div>
      <div className="detail__headmeta">
        {detail && <span className="mono detail__tc">{timecode(detail.tMono)}</span>}
        {detail && onOpenRecording && (
          <button
            className="btn ghost"
            onClick={() => {
              onOpenRecording(detail.session.id, detail.offsetSec);
              onClose();
            }}
          >
            <span className="inline">
              <IconLibrary style={{ width: 15, height: 15 }} /> Open in Library
            </span>
          </button>
        )}
        <button className="detail__close" onClick={onClose} aria-label="Close">
          <IconClose style={{ width: 16, height: 16 }} />
        </button>
      </div>
      {openedFrom && <span className="detail__rank mono">#{openedFrom.rank}</span>}
    </div>
  );
}

/** The zoom transport, docked under the stage. Instrument register throughout. */
function Loupe({
  scale,
  fit,
  dpr,
  img,
  disabled,
  onFit,
  onOneToOne,
  onStep,
}: {
  scale: number;
  fit: number;
  dpr: number;
  img: { w: number; h: number } | null;
  disabled: boolean;
  onFit: () => void;
  onOneToOne: () => void;
  onStep: (dir: number) => void;
}): React.JSX.Element {
  const shown = deviceScale(scale, dpr);
  const past = isPastCapture(scale, dpr);
  const atFit = Math.abs(scale - fit) < 1e-6;
  return (
    <div className="loupe">
      <div className="loupe__controls">
        <button className="loupe__btn" onClick={onFit} disabled={disabled} aria-pressed={atFit}>
          fit
        </button>
        <button className="loupe__btn" onClick={onOneToOne} disabled={disabled}>
          1:1
        </button>
        <button className="loupe__btn" onClick={() => onStep(-1)} disabled={disabled} aria-label="Zoom out">
          &minus;
        </button>
        <button className="loupe__btn" onClick={() => onStep(1)} disabled={disabled} aria-label="Zoom in">
          +
        </button>
      </div>
      {img && (
        <div className="loupe__readout">
          <span className="mono loupe__scale" data-past={past || undefined}>
            {shown.toFixed(2)}&times;
          </span>
          {/* The readout's opinion, and the whole point of expressing scale
              against stored pixels: it names the moment you pass the ceiling of
              what was actually recorded, rather than quietly interpolating. */}
          <span className="loupe__note">
            {past ? "past captured detail" : "1 stored pixel per screen pixel at 1.00×"}
          </span>
          <span className="mono loupe__dims">
            {img.w}&times;{img.h} px stored
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * One highlight box.
 *
 * A LABELLED region says "this control matched, and here is its name"; a
 * synthetic patch box says only "the model attended here, this strongly".
 * Different claims, drawn at different weights.
 */
function HitBox({
  hit,
  frameW,
  frameH,
  imgW,
  scale,
  active,
}: {
  hit: HighlightDTO;
  frameW: number;
  frameH: number;
  imgW: number;
  scale: number;
  active: boolean;
}): React.JSX.Element {
  const label = hit.label;
  // Nothing truncates: the label either fits its box untruncated or is withheld,
  // and the panel's matched list carries it whole either way. Because the box
  // grows with the zoom, withheld labels REAPPEAR as a reader zooms in.
  const fits = label !== null && bboxLabelFits(boxWidthPx(hit.bbox, frameW, imgW, scale), label);
  return (
    <div
      className={`bbox${label === null ? " bbox--patch" : ""}${active ? " bbox--active" : ""}`}
      style={
        {
          ...boxRect(hit.bbox, frameW, frameH),
          ...(hit.strength !== null ? { "--strength": hit.strength } : {}),
        } as React.CSSProperties
      }
    >
      {fits && <span className="bbox__label">{label}</span>}
    </div>
  );
}

/**
 * WHY this frame came back — the answer the score cannot give.
 *
 * Every term of the score is max-normalized across the candidate set, so the top
 * hit of every query sits at the weight ceiling however good it is. Agreement
 * across independent lanes is the signal, so the lanes are what this shows.
 */
function Why({ ctx }: { ctx: SearchContext }): React.JSX.Element {
  const lanes = ctx.hit.evidence.lanes;
  return (
    <div className="field">
      <span className="field__label">Why this frame</span>
      <div className="evidence">
        <span className="evidence__rank mono">{ctx.rank}</span>
        <span className="evidence__bar" data-tied={ctx.tied || undefined} aria-hidden="true">
          <span className="evidence__fill" style={{ width: `${ctx.fill * 100}%` }} />
        </span>
      </div>
      <span className="field__text detail__why">
        {ctx.tied
          ? "every hit scored identically — nothing here separates them"
          : "ranked against the best match in that search"}
      </span>
      {lanes.length === 0 ? (
        // Meaningful, not a gap: the frame scope expands to leaves, so a frame
        // can be recalled with its segment without topping any list of its own.
        <span className="field__text field__text--empty">recalled with its segment — no ranked list of its own</span>
      ) : (
        <ul className="lanes">
          {lanes.map((l) => (
            <li key={l.key} className="lanes__row">
              <span className="lanes__name">{laneText(l)}</span>
              <span className="lanes__rank mono">#{l.rank}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * WHAT matched, and where — the legend the boxes never had.
 *
 * `matchedBy` is the most explanatory field on a highlight and was invisible: it
 * separates an AX-label index hit from a synthetic attention patch, which is the
 * difference between "this control is named that" and "the model looked here".
 */
function Matched({
  highlights,
  locatable,
  onHover,
  onPick,
}: {
  highlights: HighlightDTO[];
  locatable: boolean;
  onHover: (regionId: string | null) => void;
  onPick: (hit: HighlightDTO) => void;
}): React.JSX.Element {
  return (
    <div className="field">
      <span className="field__label">Matched regions ({highlights.length})</span>
      {highlights.length === 0 ? (
        <span className="field__text field__text--empty">no region of this frame matched — it came back on its text</span>
      ) : (
        <div className="hits">
          {highlights.map((h) => (
            <button
              key={h.regionId}
              className="hits__row"
              disabled={!locatable}
              title={locatable ? "Zoom to this region" : "this recording didn’t store its screen dimensions"}
              onMouseEnter={() => onHover(h.regionId)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(h.regionId)}
              onBlur={() => onHover(null)}
              onClick={() => onPick(h)}
            >
              <span className="hits__name">{hitName(h, highlights)}</span>
              <span className="hits__by">{h.matchedBy.map(matchLabel).join(" · ")}</span>
              {h.strength !== null && (
                <span className="hits__strength" aria-hidden="true">
                  <span className="hits__fill" style={{ width: `${Math.round(h.strength * 100)}%` }} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What a matched region is CALLED in the list.
 *
 * A synthetic patch has no control to name, and calling every one of them
 * "attended patch" put seven identical rows in the panel on a real recording —
 * the same identical-string failure the templated digest was rebuilt to fix
 * (measured there at 86% down to 4%). They arrive strongest-first, so the
 * ordinal is the rank the model gave them and the row becomes both
 * distinguishable and more informative. Only numbered when there is in fact more
 * than one, because "attended patch 1" alone implies a second one somewhere.
 */
function hitName(h: HighlightDTO, all: readonly HighlightDTO[]): string {
  const named = h.label ?? h.role;
  if (named !== null && named !== undefined) return named;
  const patches = all.filter((x) => (x.label ?? x.role) === null || (x.label ?? x.role) === undefined);
  if (patches.length < 2) return "attended patch";
  return `attended patch ${patches.indexOf(h) + 1}`;
}

/**
 * How a region was found, for someone who did not build the index.
 *
 * An unknown key falls through to itself rather than to a catch-all, the same
 * rule `laneLabel` follows: a lane added later should look unfinished here, not
 * be silently absorbed into a plausible-sounding "other".
 */
function matchLabel(key: string): string {
  if (key === "fts") return "on-screen label";
  if (key === "ann") return "visual similarity";
  return key;
}

/** The identifiers, at the bottom where identifiers belong. */
function Record({
  detail,
  img,
}: {
  detail: ResultDetailDTO;
  img: { w: number; h: number } | null;
}): React.JSX.Element {
  const place =
    detail.sessionSpanSec > 0
      ? Math.max(0, Math.min(1, detail.offsetSec / detail.sessionSpanSec))
      : null;
  return (
    <div className="field">
      <span className="field__label">Frame record</span>
      {/* Withheld rather than invented when the span is unknown — a recording
          with no video and no end time has no axis to place anything on. */}
      {place !== null && (
        <span className="locator locator--wide" aria-hidden="true">
          <span className="locator__tick locator__tick--self" style={{ left: `${place * 100}%` }} />
        </span>
      )}
      <dl className="meta-grid">
        <dt>When</dt>
        <dd>{wallClock(detail.wallClock)}</dd>
        <dt>Frame space</dt>
        <dd>
          {detail.width > 0 ? `${detail.width}×${detail.height} pt` : "not stored"}
        </dd>
        <dt>Stored image</dt>
        <dd>{img ? `${img.w}×${img.h} px` : "—"}</dd>
        <dt>Regions</dt>
        <dd>{detail.highlights.length}</dd>
        <dt>AX elements</dt>
        <dd>{detail.ax.length}</dd>
        {detail.segment && (
          <>
            <dt>Level</dt>
            <dd>{detail.segment.granularity}</dd>
            <dt>Segment</dt>
            <dd>{detail.segment.id}</dd>
          </>
        )}
        <dt>Frame</dt>
        <dd>{detail.frameId}</dd>
        {/* Not sliced. An ellipsis here was the one explicit truncation in this
            file, and a ULID a reader cannot copy whole is not an identifier. */}
        <dt>Session</dt>
        <dd>{detail.session.id}</dd>
      </dl>
    </div>
  );
}

function Section({ label, text }: { label: string; text?: string | null }): React.JSX.Element {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className={`field__text${text ? "" : " field__text--empty"}`}>{text || `no ${label.toLowerCase()}`}</span>
    </div>
  );
}
