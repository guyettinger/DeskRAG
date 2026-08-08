import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  MediaPlayer,
  MediaProvider,
  PlayButton,
  Poster,
  Tooltip,
  Track,
  isVideoProvider,
  useMediaPlayer,
  useMediaState,
  type MediaPlayerInstance,
  type VTTContent,
} from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import type { KeyframeMarkerDTO, SessionDetailDTO } from "@shared/types";
import { keyframeLabel } from "../api.js";
import { IconInspect, IconNextKeyframe, IconPrevKeyframe } from "../icons.js";
import { DetailView } from "./DetailView.js";
import { TrackRail, type SeekRequest } from "./TrackRail.js";

const SPEEDS = [0.5, 1, 2, 4];

/** Structurally a Vidstack `ThumbnailImageInit` — that type is not re-exported. */
interface ThumbnailShot {
  url: string;
  startTime: number;
  endTime: number;
}

/**
 * Session playback. The screen video is served over `deskrag://media/<blobId>`
 * with Range support; the keyframes indexed out of it become the divisions and
 * the hover previews of the scrubber, so the timeline shows what is searchable.
 *
 * Every keyframe helper below assumes `keyframes` is ordered by `offsetSec` —
 * `DeskRagService.sessionDetail` builds it from frames already sorted by t_mono.
 */

/** Nearest keyframe to `sec` by binary search — this runs on every store tick. */
function nearestKeyframe(ks: KeyframeMarkerDTO[], sec: number): KeyframeMarkerDTO | null {
  if (ks.length === 0) return null;
  let lo = 0;
  let hi = ks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ks[mid]!.offsetSec < sec) lo = mid + 1;
    else hi = mid;
  }
  const after = ks[lo]!;
  const before = ks[lo - 1];
  if (!before) return after;
  return sec - before.offsetSec <= after.offsetSec - sec ? before : after;
}

/** The next keyframe strictly after (dir 1) or before (dir -1) `sec`. */
function stepKeyframe(
  ks: KeyframeMarkerDTO[],
  sec: number,
  dir: 1 | -1,
): KeyframeMarkerDTO | undefined {
  return dir === 1
    ? ks.find((k) => k.offsetSec > sec + 0.01)
    : [...ks].reverse().find((k) => k.offsetSec < sec - 0.01);
}

/** The layout's own tooltip around an injected control, so it is
 *  indistinguishable from Vidstack's. */
function BarTip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Content className="vds-tooltip-content" placement="top">
        {label}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

/** A control-bar button with the layout's own tooltip. */
function BarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <BarTip label={label}>
      <button className="vds-button" aria-label={label} onClick={onClick}>
        {children}
      </button>
    </BarTip>
  );
}

/** Vidstack's own play button, rebuilt because the default sits in the row the
 *  transport left. Same states, same icons — see `DefaultPlayButton`. */
function PlayControl(): React.JSX.Element {
  const paused = useMediaState("paused");
  const ended = useMediaState("ended");
  const Icons = defaultLayoutIcons.PlayButton;
  const Icon = ended ? Icons.Replay : paused ? Icons.Play : Icons.Pause;
  const label = paused ? "Play" : "Pause";
  return (
    <BarTip label={label}>
      <PlayButton className="vds-play-button vds-button" aria-label={label}>
        <Icon className="vds-icon" />
      </PlayButton>
    </BarTip>
  );
}

/**
 * Play plus prev/next keyframe, in a block the exact width of the rail's title
 * column — that is what puts the scrubber's left edge over the lane plots'.
 * Keyframe stepping stands where ±10s seeking would.
 *
 * Reads `player.currentTime` on click rather than subscribing to it, so the
 * control bar does not re-render on every frame of playback.
 */
function Transport({ keyframes }: { keyframes: KeyframeMarkerDTO[] }): React.JSX.Element {
  const player = useMediaPlayer();

  const step = (dir: 1 | -1): void => {
    if (!player) return;
    const next = stepKeyframe(keyframes, player.currentTime, dir);
    if (next) player.currentTime = next.offsetSec;
  };

  return (
    <div className="player__transport">
      <PlayControl />
      {keyframes.length > 0 && (
        <>
          <BarButton label="Previous keyframe (←)" onClick={() => step(-1)}>
            <IconPrevKeyframe className="vds-icon" />
          </BarButton>
          <BarButton label="Next keyframe (→)" onClick={() => step(1)}>
            <IconNextKeyframe className="vds-icon" />
          </BarButton>
        </>
      )}
    </div>
  );
}

/** Opens the keyframe nearest the playhead — regions, AX labels, transcript. */
function InspectButton({
  keyframes,
  onInspect,
}: {
  keyframes: KeyframeMarkerDTO[];
  onInspect: (frameId: string) => void;
}): React.JSX.Element | null {
  const player = useMediaPlayer();

  if (keyframes.length === 0) return null;

  return (
    <BarButton
      label="Inspect keyframe"
      onClick={() => {
        const k = nearestKeyframe(keyframes, player?.currentTime ?? 0);
        if (k) onInspect(k.frameId);
      }}
    >
      <IconInspect className="vds-icon" />
    </BarButton>
  );
}

export function SessionPlayer({
  detail,
  seekTo,
}: {
  detail: SessionDetailDTO;
  /**
   * A moment to jump to, in LANE seconds — a `t_mono` offset, the axis the
   * track rail is drawn in. It is passed straight through to `TrackRail`
   * rather than converted here: the video's clock runs slightly short of the
   * session's, and `TrackRail.seek` is the ONE place the two are reconciled.
   */
  seekTo?: SeekRequest | null;
}): React.JSX.Element {
  const playerRef = useRef<MediaPlayerInstance>(null);
  const keyframes = detail.keyframes;
  const [openFrame, setOpenFrame] = useState<string | null>(null);

  // A fragmented MP4 can report Infinity until enough of it is buffered, so the
  // timeline starts on the t_mono span the keyframe offsets are measured
  // against and adopts the provider's duration once it reports a real one.
  const span = detail.video ? (detail.video.tMonoEnd - detail.video.tMonoStart) / 1000 : 0;
  const [duration, setDuration] = useState(span);
  const total = duration > 0 ? duration : span;

  const step = useCallback(
    (dir: 1 | -1): void => {
      const player = playerRef.current;
      if (!player) return;
      const next = stepKeyframe(keyframes, player.currentTime, dir);
      if (next) player.currentTime = next.offsetSec;
    },
    [keyframes],
  );

  // Keyframes as chapters: the slider is divided at exactly the frames that
  // were indexed, and hovering one names its segment. This one track feeds every
  // label in the layout — the control bar title, the slider's chapter titles and
  // its hover preview, and the chapters menu.
  const chapters = useMemo<VTTContent | null>(() => {
    if (keyframes.length === 0 || total <= 0) return null;
    const clamp = (sec: number): number => Math.min(Math.max(sec, 0), total);
    const cues = keyframes
      .map((k, i) => ({
        // Start at 0 so the track has no dead lead-in before the first keyframe.
        startTime: i === 0 ? 0 : clamp(k.offsetSec),
        endTime: i === keyframes.length - 1 ? total : clamp(keyframes[i + 1]!.offsetSec),
        text: keyframeLabel(k),
      }))
      .filter((cue) => cue.endTime - cue.startTime > 0.05);
    return cues.length > 0 ? { cues } : null;
  }, [keyframes, total]);

  // Hover previews come straight from the stored keyframe JPEGs — no WebVTT
  // sprite to generate, and no fetch the renderer CSP would have to allow.
  const thumbnails = useMemo<ThumbnailShot[] | null>(() => {
    if (total <= 0) return null;
    const shots = keyframes.flatMap((k) =>
      k.thumbUrl ? [{ url: k.thumbUrl, startTime: Math.min(Math.max(k.offsetSec, 0), total) }] : [],
    );
    if (shots.length === 0) return null;
    return shots.map((shot, i) => ({
      ...shot,
      endTime: i === shots.length - 1 ? total : shots[i + 1]!.startTime,
    }));
  }, [keyframes, total]);

  if (!detail.video) {
    return (
      <div className="player">
        <div className="player__note">
          No video for this session — it was recorded before video capture, or with the Screen
          signal off. Its signals are still on a real time axis:
        </div>
        {/* No player, so no seeking: a keyframe click opens it instead, which is
            what the filmstrip did in this case. */}
        <TrackRail sessionId={detail.id} player={null} videoSec={null} onInspect={setOpenFrame} />
        {openFrame && <DetailView frameId={openFrame} onClose={() => setOpenFrame(null)} />}
      </div>
    );
  }

  return (
    <div className="player">
      <MediaPlayer
        ref={playerRef}
        className="player__media"
        // The deskrag:// URL carries no file extension, so the type is explicit.
        src={{ src: detail.video.url, type: "video/mp4" }}
        duration={total}
        poster={keyframes[0]?.thumbUrl ?? undefined}
        // No `title`: the stage header already names the session, and the
        // control bar's title slot is where the active segment digest belongs.
        viewType="video"
        streamType="on-demand"
        preload="metadata"
        playsInline
        // Scoped to the player, unlike the window listener this replaces, and
        // silenced entirely while DetailView owns the keyboard.
        keyTarget="player"
        keyDisabled={openFrame !== null}
        keyShortcuts={{
          togglePaused: "k Space",
          // Fullscreen and picture-in-picture are removed from this player, so
          // their default keys must go too or they come back by keyboard.
          toggleFullscreen: null,
          togglePictureInPicture: null,
          // No audio track exists on a screen recording.
          toggleMuted: null,
          volumeUp: null,
          volumeDown: null,
          // Arrows step keyframes instead of seeking ±10s.
          seekBackward: null,
          seekForward: null,
          prevKeyframe: {
            keys: ["ArrowLeft", "j"],
            onKeyDown: ({ event }) => {
              event.preventDefault();
              step(-1);
            },
          },
          nextKeyframe: {
            keys: ["ArrowRight", "l"],
            onKeyDown: ({ event }) => {
              event.preventDefault();
              step(1);
            },
          },
        }}
        onDurationChange={(value) => {
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        // The <video> element carries its own picture-in-picture affordance,
        // independent of the button and the keybinding removed above. provider-
        // change is the documented place to configure a provider; provider-setup
        // is too late.
        onProviderChange={(provider) => {
          if (isVideoProvider(provider)) provider.video.disablePictureInPicture = true;
        }}
      >
        <MediaProvider>
          <Poster className="vds-poster" alt="" />
          {chapters && (
            <Track kind="chapters" type="json" content={chapters} label="Segments" default />
          )}
        </MediaProvider>

        <DefaultVideoLayout
          icons={defaultLayoutIcons}
          colorScheme="dark"
          thumbnails={thumbnails}
          playbackRates={SPEEDS}
          sliderChaptersMinWidth={240}
          // The small layout stacks a centred play button, a top menu row and a
          // bottom slider — an arrangement for chrome floating over a whole
          // frame. Docked in a bar it just stretches into dead space, and this
          // player is always a desktop stage, so keep the one-row large layout
          // at every size (the window can go to 900x600, which would otherwise
          // trip the default width < 576 || height < 380 switch).
          smallLayoutWhen={false}
          noAudioGain
          menuGroup="bottom"
          slots={{
            // Keyframe stepping replaces ±10s seeking.
            seekBackwardButton: null,
            seekForwardButton: null,
            // The transport moves OUT of the lower row and into the slider's,
            // where its fixed width becomes the axis' left gutter. `slot()`
            // emits before*/after* around every slot, so this needs no fork.
            playButton: null,
            beforeTimeSlider: <Transport keyframes={keyframes} />,
            // The active segment's caption is NOT in the control bar.
            //
            // It is a VLM sentence — measured at 886px, ellipsized — and this
            // app's own rule is that nothing truncates, because a label that
            // fits or is withheld makes a broken layout visible while an
            // ellipsis hides it. The rail's `caption` lane carries the same
            // text at its true extent, and the hover card carries it in full.
            chapterTitle: null,
            // THERE IS ONE RUNNING CLOCK, and it is the rail's.
            //
            // These read MEDIA seconds while every lane below reads LANE
            // seconds, and the two genuinely differ — measured on a real
            // session, `0:29` sat 260px from a header reading `00:00:32.807`
            // for the same recording. Two clocks disagreeing in one glance is
            // not a rounding nit, it is the screen contradicting itself. The
            // ruler's readout is in the axis' own seconds, and the stage header
            // carries the total; a second opinion here bought nothing.
            currentTime: null,
            timeDivider: null,
            endTime: null,
            // Silent video, local-first: nothing to mute, nowhere to cast.
            muteButton: null,
            volumeSlider: null,
            captionButton: null,
            airPlayButton: null,
            googleCastButton: null,
            downloadButton: null,
            // This player is a desktop inspection surface: a floating window and
            // a fullscreen canvas both take the frame away from the keyframe
            // strip and the stage header that give it context.
            pipButton: null,
            fullscreenButton: null,
            // Still rendered even though the button beside it is null — the
            // layout's slot() emits before/after regardless of the default being
            // replaced — so Inspect stays at the end of the bar.
            beforeFullscreenButton: (
              <InspectButton keyframes={keyframes} onInspect={setOpenFrame} />
            ),
          }}
        />
      </MediaPlayer>

      <TrackRail
        sessionId={detail.id}
        player={playerRef}
        videoSec={total}
        seekTo={seekTo ?? null}
        onInspect={setOpenFrame}
      />

      <div className="player__meta mono">
        {keyframes.length} keyframes · {detail.segmentCount} segments · {detail.eventCount} events
      </div>

      {openFrame && <DetailView frameId={openFrame} onClose={() => setOpenFrame(null)} />}
    </div>
  );
}
