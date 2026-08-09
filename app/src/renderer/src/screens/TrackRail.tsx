import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MediaPlayerInstance } from "@vidstack/react";
import type { SessionTracksDTO, TrackGroup } from "@shared/types";
import { api, keyframeLabel } from "../api.js";
import { TrackLane } from "./TrackLane.js";
import { groupLanes, preRollSec, readoutAt, rulerTicks } from "./track-view.js";

/** How far from the cursor a point event still counts as "here". */
const HOVER_TOL_PX = 8;
/** Breathing room between the hover card and the window edge. */
const TIP_MARGIN = 8;
/** Distance from the cursor to the card, so the card never sits under it. */
const TIP_OFFSET = 14;

/** Rail height, in px: the floor, the default, and the room the monitor keeps. */
const RAIL_MIN = 104;
/**
 * Grip + ruler + a band header and roughly six data lanes — enough that the
 * banding is visible as a structure rather than as a single header you have to
 * scroll past to discover. Measured against a 1600x1000 window, this still
 * leaves the frame ~390px of height, against the 197px it had before any of
 * this. The reader moves it from here.
 */
const RAIL_DEFAULT = 262;
const MONITOR_FLOOR = 260;
/** One preference across sessions — which signals you watch is not per-recording. */
const RAIL_H_KEY = "deskrag.rail.height";
const BANDS_KEY = "deskrag.rail.collapsed";

/**
 * A cross-screen jump, as it arrives at the axis it is expressed in.
 *
 * `sec` is LANE seconds — a `t_mono` offset — and `nonce` is what makes two
 * jumps to the same moment two jumps. Without it the second is a no-op: the
 * guard below fires once per moment on purpose, since `player.subscribe`
 * re-renders this component every animation frame.
 */
export interface SeekRequest {
  sec: number;
  nonce: number;
}

interface Props {
  sessionId: string;
  /** Null for a session with no video: the axis is real, seeking is not. */
  player: React.RefObject<MediaPlayerInstance | null> | null;
  /**
   * The player's duration — MEDIA seconds, which are not the lanes' seconds.
   * The video decodes a shorter span than it covers (measured: 84.9s of media
   * for an 85.76s t_mono span), so a media time divided by the lane total lands
   * ~1% early — 5px at the right end of the axis. Null without a video.
   */
  videoSec: number | null;
  /**
   * A moment to jump to on arrival — from Flows or from Search, neither of
   * which knows anything about media time. It lands here rather than in
   * `SessionPlayer` because `seek` below is the only place the two clocks are
   * reconciled, and there must go on being only one.
   */
  seekTo?: SeekRequest | null;
  onInspect: (frameId: string) => void;
}

interface Hover {
  sec: number;
  x: number;
  y: number;
  /**
   * The lane under the cursor, or null over a band header or the space below
   * the last lane.
   *
   * Read with `closest()` from the event target, which is sound because
   * `.tracks__axis` — the box holding the playhead and crosshair, spanning
   * every lane — is already `pointer-events: none`. Without that the axis would
   * be the target everywhere and this would always be null.
   */
  laneId: string | null;
}

function timecodeAt(sec: number): string {
  const s = Math.max(0, sec);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const t = Math.floor((s - Math.floor(s)) * 10);
  return `${mm}:${String(ss).padStart(2, "0")}.${t}`;
}

/** A stored preference, or the fallback when nothing is stored or it is junk. */
function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* a full or disabled store costs a preference, never the screen */
  }
}

/**
 * Every recorded signal on one time axis, beneath the player. Replaces the
 * keyframe filmstrip, so the screen has exactly one time axis.
 *
 * That axis is `.tracks__axis` — the plot column, NOT the whole rail. The
 * distinction is the whole point: the gutter holds lane titles, so measuring
 * the cursor against the rail's full width puts the crosshair on a different
 * SCALE from the lanes it stands over (it did, until this box existed). The
 * column's width and inset are the same tokens the docked control bar uses, so
 * the scrubber above and the lanes below are one axis structurally rather than
 * by tuning.
 *
 * Three things keep sixteen lanes readable in the height a video frame leaves:
 * lanes are gathered into COLLAPSIBLE BANDS, an empty lane keeps its row but not
 * its height, and the rail itself is DRAGGABLE — the reader decides how the
 * stage is split rather than a `34vh` cap deciding it for them. The monitor
 * keeps a floor throughout, so the frame can never be dragged away entirely.
 */
export function TrackRail({
  sessionId,
  player,
  videoSec,
  seekTo,
  onInspect,
}: Props): React.JSX.Element {
  const [tracks, setTracks] = useState<SessionTracksDTO | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [axisWidth, setAxisWidth] = useState(0);
  const axisRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const [railH, setRailH] = useState(() =>
    readStored(RAIL_H_KEY, RAIL_DEFAULT, (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) && n >= RAIL_MIN ? n : null;
    }),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<TrackGroup>>(() =>
    readStored(BANDS_KEY, new Set<TrackGroup>(), (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed as TrackGroup[]) : null;
    }),
  );

  useEffect(() => {
    let live = true;
    setTracks(null);
    void api.sessions.tracks(sessionId).then((t) => {
      if (live) setTracks(t);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  const totalSec = tracks?.totalSec ?? 0;
  const bands = useMemo(() => (tracks ? groupLanes(tracks.lanes) : []), [tracks]);
  const preRoll = useMemo(() => (tracks ? preRollSec(tracks.lanes) : 0), [tracks]);
  // The root's depth, which varies with the recording — a 20s clip composes two
  // levels where a long session composes five. Lane titles indent by how far
  // they sit BELOW it, so the gutter reads as an outline either way.
  const maxLevel = useMemo(
    () => (tracks ? Math.max(0, ...tracks.lanes.map((l) => l.level ?? 0)) : 0),
    [tracks],
  );
  const ticks = useMemo(() => rulerTicks(totalSec, axisWidth), [totalSec, axisWidth]);
  /**
   * Room for the pre-roll's words before the first tick after 0:00.
   *
   * 148px is that sentence at 10px mono. Below it the label is dropped rather
   * than overlapped — the ruler is the one place in this rail where two strings
   * can land on the same pixels, and they did at a 1000px window.
   */
  const preRollLabelFits =
    ticks.length > 1 && (ticks[1]!.atSec / totalSec) * axisWidth >= 148;

  // The axis is measured, not assumed: the thumbnail spacing rule and the hover
  // tolerance are both PIXEL facts, and the rail is resizable.
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAxisWidth(el.clientWidth));
    ro.observe(el);
    setAxisWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [tracks]);

  // The playhead is written IMPERATIVELY. `player.subscribe` fires every
  // animation frame; routing it through state would re-render sixteen lanes at
  // 60fps. KeyframeStrip already encoded this lesson by setting state only when
  // the nearest keyframe changed.
  //
  // ONE AXIS: media seconds ARE lane seconds. Lane offset 0 is media 0 (the
  // video blob's tMonoStart is now the CAPTURE time of its first frame, not a
  // pre-spawn guess), and the mp4 carries capture timestamps rather than being
  // re-timed to a constant rate. The old divisor rescaled media onto the lane
  // span to paper over an offset AND a 1.4% rate divergence; both are gone, so
  // the conversion is deleted rather than tuned.
  useEffect(() => {
    const p = player?.current;
    if (!p || totalSec <= 0) return;
    return p.subscribe(({ currentTime }) => {
      const at = `${(currentTime / totalSec) * 100}%`;
      if (headRef.current) headRef.current.style.transform = `translateX(${at})`;
      if (knobRef.current) knobRef.current.style.transform = `translateX(${at})`;
      const el = clockRef.current;
      if (el && !el.dataset.hovering) el.textContent = timecodeAt(currentTime);
    });
  }, [player, totalSec]);

  /** Lane seconds under the cursor, or null when it is off the axis (the gutter). */
  const secAt = (clientX: number): number | null => {
    const el = axisRef.current;
    if (!el || totalSec <= 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || clientX < r.left || clientX > r.right) return null;
    return ((clientX - r.left) / r.width) * totalSec;
  };

  /** Lane seconds ARE media seconds — see the playhead above. */
  const seek = (sec: number): void => {
    const p = player?.current;
    if (p) p.currentTime = Math.max(0, sec);
  };

  /**
   * A jump from Flows or Search, performed once both clocks are known.
   *
   * It cannot run on mount: `videoSec` is `Infinity` until the fragmented MP4
   * is buffered enough for the provider to report a real duration, and
   * `totalSec` comes from the tracks fetch. Depending on both is what makes
   * this fire on the render where they have arrived — the alternative, sleeping
   * a guessed interval, is the pattern this repo rejects everywhere it appears.
   *
   * `videoSec` is consulted ONLY as readiness now, never as a conversion
   * factor: lane seconds are media seconds, and a seek issued before the
   * provider has a duration does not stick.
   *
   * Keyed on the NONCE, not the moment: `player.subscribe` re-renders this
   * component every animation frame, so the guard has to hold — but two jumps
   * to one moment are two jumps, and keying on the seconds made the second a
   * dead click.
   */
  const seekDone = useRef<number | null>(null);
  useEffect(() => {
    if (!seekTo) return;
    if (!player?.current || totalSec <= 0) return;
    if (videoSec === null || !Number.isFinite(videoSec) || videoSec <= 0) return;
    if (seekDone.current === seekTo.nonce) return;
    seekDone.current = seekTo.nonce;
    seek(seekTo.sec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTo, totalSec, videoSec, player]);

  const readout = useMemo(() => {
    if (!tracks || !hover) return null;
    return readoutAt(tracks, hover.sec, {
      tolSec: axisWidth > 0 ? (HOVER_TOL_PX / axisWidth) * totalSec : 0,
      label: keyframeLabel,
      focusLaneId: hover.laneId,
    });
  }, [tracks, hover, axisWidth, totalSec]);

  const toggleBand = useCallback((id: TrackGroup): void => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeStored(BANDS_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  /**
   * Drag the rail taller or shorter.
   *
   * The ceiling is measured from the stage at grab time rather than stored as a
   * viewport fraction: what the rail may take is whatever is left after the
   * monitor's floor, and that depends on the window, not on a guess. Pointer
   * capture is what keeps the drag alive when the cursor outruns the 8px grip.
   */
  const onGrab = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const rail = railRef.current;
    const stage = rail?.parentElement;
    if (!rail || !stage) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = rail.getBoundingClientRect().height;
    const ceiling = Math.max(RAIL_MIN, stage.getBoundingClientRect().height - MONITOR_FLOOR);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent): void => {
      // Upward drag grows the rail: it is anchored to the bottom of the stage.
      const next = Math.round(Math.min(ceiling, Math.max(RAIL_MIN, startH - (ev.clientY - startY))));
      setRailH(next);
    };
    const up = (): void => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setRailH((h) => {
        writeStored(RAIL_H_KEY, String(h));
        return h;
      });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }, []);

  if (!tracks) return <div className="tracks tracks--note">reading signals…</div>;
  if (totalSec <= 0) {
    return <div className="tracks tracks--note">this recording has no measurable span</div>;
  }

  return (
    <div className="tracks" ref={railRef} style={{ height: railH }}>
      <div
        className="tracks__grip"
        onPointerDown={onGrab}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setRailH((h) => h + 24);
          else if (e.key === "ArrowDown") setRailH((h) => Math.max(RAIL_MIN, h - 24));
          else return;
          e.preventDefault();
        }}
      >
        <span className="tracks__grip-bar" />
      </div>

      {/* The ruler: the one place the axis is numbered. It sits OUTSIDE the
          scroller so the numbers stay put while the lanes scroll under them —
          a ruler that scrolled away would leave the bars unmeasurable. */}
      {/* Recorded before the capture clock existed, so its frames and audio were
          timed by ARRIVAL rather than capture. The lanes then sit about a
          second from the video they describe, and nothing can recover the
          difference — the delivery latency of a past session was never stored.
          Saying so beats a rail that looks aligned and is not. */}
      {tracks && !tracks.clockCalibrated && (
        <div className="tracks__uncalibrated">
          Recorded before the capture clock was calibrated — lanes and video may
          differ by about a second.
        </div>
      )}
      <div className="tracks__ruler">
        <div className="tracks__ruler-gutter">
          <span className="tracks__clock mono" ref={clockRef}>
            {timecodeAt(0)}
          </span>
        </div>
        <div className="tracks__ruler-axis" data-preroll={preRoll > 0.05 || undefined}>
          {ticks.map((t) => (
            <span
              key={t.atSec}
              className="tracks__tick"
              style={{ left: `${(t.atSec / totalSec) * 100}%` }}
            >
              <span className="tracks__tick-label mono">{t.label}</span>
            </span>
          ))}
          {player && <div className="tracks__knob" ref={knobRef} />}
          {/* Signals recorded before the first video frame exist and cannot be
              drawn — there is no pixel meaning "before zero". Saying so is the
              same disclosure the audio lane makes distinguishing silence from
              no coverage. */}
          {preRoll > 0.05 && (
            <span
              className="tracks__preroll mono"
              title={`Capture ran ${preRoll.toFixed(1)}s before the first video frame. Signals from that stretch are cut at 0 and their bars notched.`}
            >
              ◀{/* The words are withheld when they would not fit before the
                    first tick — the same rule `labelFits` applies to every bar
                    in this rail, applied to the ruler. At 1000px wide this text
                    ran straight through the `0:10` label. The marker and its
                    tooltip always remain, so the fact is never lost. */}
              {preRollLabelFits && <> {preRoll.toFixed(1)}s before frame one</>}
            </span>
          )}
        </div>
      </div>

      <div
        className="tracks__body"
        onMouseMove={(e) => {
          const sec = secAt(e.clientX);
          const laneId =
            (e.target as HTMLElement).closest<HTMLElement>(".tracks__lane")?.dataset.lane ??
            null;
          setHover(sec === null ? null : { sec, x: e.clientX, y: e.clientY, laneId });
          const el = clockRef.current;
          if (el) {
            if (sec === null) delete el.dataset.hovering;
            else {
              el.dataset.hovering = "1";
              el.textContent = timecodeAt(sec);
            }
          }
        }}
        onMouseLeave={() => {
          setHover(null);
          if (clockRef.current) delete clockRef.current.dataset.hovering;
        }}
        onClick={(e) => {
          // A keyframe handles its own click and stops there; anything else on
          // the axis is a seek. The gutter is not on the axis, so it is neither.
          if ((e.target as HTMLElement).closest(".tracks__thumb, .tracks__mark")) return;
          const sec = secAt(e.clientX);
          if (sec !== null && player) seek(sec);
        }}
      >
        {/* The lanes and the axis share this box, and it is what gives the
            playhead its height: an abspos child of the SCROLLER would be sized
            to the client box and stop at the fold once the rail is scrolled. */}
        <div className="tracks__inner">
          {bands.map((band) => {
            const open = !collapsed.has(band.id);
            return (
              <React.Fragment key={band.id}>
                <button
                  className="tracks__band"
                  aria-expanded={open}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleBand(band.id);
                  }}
                >
                  <span className="tracks__band-caret" aria-hidden="true">
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="tracks__band-title mono">{band.title}</span>
                  {/* Collapsed, the band says how much it is holding back.
                      Open, it flags only what is empty — the lanes themselves
                      say the rest. */}
                  <span className="tracks__band-count mono">
                    {open
                      ? band.emptyCount > 0
                        ? `${band.emptyCount} empty`
                        : ""
                      : `${band.lanes.length} lanes`}
                  </span>
                </button>
                {open &&
                  band.lanes.map((lane) => (
                    <TrackLane
                      key={lane.id}
                      lane={lane}
                      totalSec={totalSec}
                      axisWidth={axisWidth}
                      hovered={hover?.laneId === lane.id}
                      maxLevel={maxLevel}
                      onSeek={player ? seek : null}
                      onInspect={onInspect}
                    />
                  ))}
              </React.Fragment>
            );
          })}
          <div className="tracks__axis" ref={axisRef}>
            {player && <div className="tracks__playhead" ref={headRef} />}
            {hover && (
              <div className="tracks__crosshair" style={{ left: `${(hover.sec / totalSec) * 100}%` }} />
            )}
          </div>
        </div>
      </div>
      {hover && readout && <ReadoutCard hover={hover} readout={readout} />}
    </div>
  );
}

/**
 * The card. Three states from ONE resolver, because they are one question asked
 * with different precision:
 *
 *  - over a lane            head + focus block + a divided context list
 *  - over a lane with
 *    nothing at the cursor  the same, with the lane's own reason as the answer
 *  - over no lane           head + every row at full weight (the original card)
 *
 * The third is not a third rendering: `focus` is null and `rows` holds
 * everything, so the same JSX produces it.
 *
 * Positioned `fixed` off the pointer rather than inside the rail, because the
 * rail is a clipped scroller and a card anchored inside it would be cut off at
 * exactly the lanes near its edges.
 */
function ReadoutCard({
  hover,
  readout,
}: {
  hover: Hover;
  readout: ReturnType<typeof readoutAt>;
}): React.JSX.Element | null {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // MEASURED, never guessed. This flipped on two constants — a 336x260 estimate
  // — and the card is whatever sixteen lanes of clamped prose come to: measured
  // ~550px, so it ran off the bottom of the window and cut the last lanes off
  // exactly when the reader had asked for all of them. Clamping into the
  // viewport needs the real height, and the real height is only known after
  // layout. `useLayoutEffect` so the correction lands before paint.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const right = hover.x + TIP_OFFSET + width;
    setPos({
      left:
        right > window.innerWidth - TIP_MARGIN
          ? Math.max(TIP_MARGIN, hover.x - TIP_OFFSET - width)
          : hover.x + TIP_OFFSET,
      // Clamped rather than flipped: a card taller than the space on either
      // side has no good anchor, so it is pinned inside the window instead.
      top: Math.max(
        TIP_MARGIN,
        Math.min(hover.y + TIP_OFFSET, window.innerHeight - height - TIP_MARGIN),
      ),
    });
  }, [hover.x, hover.y, readout]);

  if (readout.focus === null && readout.rows.length === 0) return null;
  return (
    <div
      className="tracks__tip"
      ref={cardRef}
      style={{
        left: pos?.left ?? hover.x + TIP_OFFSET,
        top: pos?.top ?? hover.y + TIP_OFFSET,
        // Hidden for the one frame between mount and measurement, so the card
        // never appears at an unclamped position and jumps.
        visibility: pos ? undefined : "hidden",
      }}
    >
      <div className="tracks__tip-head mono">{readout.timecode}</div>
      {readout.focus && (
        <div className="tracks__tip-focus">
          <span className="tracks__tip-title mono">{readout.focus.title}</span>
          <span className="tracks__tip-value" data-tone={readout.focus.tone ?? undefined}>
            {readout.focus.text}
          </span>
        </div>
      )}
      {readout.rows.length > 0 && (
        // `data-compact` is present only when something is focused above, so it
        // carries BOTH the divider and the demotion — the context list can only
        // be context when there is a focus for it to be context to.
        <div className="tracks__tip-rows" data-compact={readout.focus ? "" : undefined}>
          {readout.rows.map((row) => (
            <React.Fragment key={row.laneId}>
              <span className="tracks__tip-title mono">{row.title}</span>
              <span className="tracks__tip-value" data-tone={row.tone ?? undefined}>
                {row.text}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
