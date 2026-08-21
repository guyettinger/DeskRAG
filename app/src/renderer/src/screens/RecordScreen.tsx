import React, { useEffect, useState } from "react";
import type {
  EnvInfo,
  PermissionKind,
  PermissionStatus,
  RecordingStatus,
  RecordingTickDTO,
  SettingsView,
  SignalConfig,
  SignalKind,
} from "@shared/types";
import { api, timecode } from "../api.js";
import { signalReadout, wavePath, type SignalGate } from "./signal-view.js";

interface Props {
  status: RecordingStatus;
  env: EnvInfo | null;
  /** Where the recording just stopped went. See the handoff line below. */
  onOpenIndexing: () => void;
}

type SignalId = keyof SignalConfig;

interface SignalDef {
  id: SignalId;
  /** The kind main reports against. `activeWin` is `active-win` over IPC. */
  kind: SignalKind;
  name: string;
  /**
   * WHAT THIS SIGNAL CAPTURES, in a sentence, REQUIRED and with no default.
   *
   * The `StageSpec.describe` precedent, and for the same reason: this screen
   * exists to explain what a recording will contain, and it used to answer with
   * two-word labels — "UI labels + roles", "focus changes" — from which a reader
   * could learn nothing. Written from the user's side: what it records, not how.
   * It WRAPS and never ellipsizes.
   */
  describe: string;
  /**
   * The signal's CONFIGURATION, or null where it has none.
   *
   * Null rather than a filler string. Input, Active window and the AX tree used
   * to carry "clicks · scroll · keys", "focus changes" and "UI labels + roles" in
   * this slot — none of which is a setting, and all three now restate `describe`
   * in fewer words. A line with nothing to say is furniture; the card simply
   * does not draw one.
   */
  meta: (s: SettingsView) => string | null;
  permission?: PermissionKind;
  needs?: (env: EnvInfo) => { ok: boolean; note: string } | null;
}

const SIGNALS: SignalDef[] = [
  {
    id: "screen",
    kind: "screen",
    name: "Screen",
    describe: "Samples the display and keeps a frame each time the picture changes.",
    meta: (s) => `${s.signals.screen.fps} fps · ${s.signals.screen.imageMaxWidth}px`,
    permission: "screen",
    needs: (e) => (e.ffmpegAvailable ? null : { ok: false, note: "ffmpeg not found on PATH" }),
  },
  {
    id: "input",
    kind: "input",
    name: "Input",
    describe: "Records where you click and scroll, and the text you type.",
    meta: () => null,
    permission: "accessibility",
  },
  {
    id: "activeWin",
    kind: "active-win",
    name: "Active window",
    describe: "Notes which app and window you are in, and when you switch.",
    meta: () => null,
    permission: "screen",
  },
  {
    id: "audio",
    kind: "audio",
    name: "Microphone",
    describe: "Records what you say, in short chunks, transcribed after the recording.",
    meta: (s) => `${s.signals.audio.device} · ${s.signals.audio.chunkSeconds}s chunks`,
    permission: "microphone",
    needs: (e) =>
      !e.ffmpegAvailable
        ? { ok: false, note: "ffmpeg not found on PATH" }
        : !e.whisperConfigured
          ? { ok: true, note: "recorded, but whisper-cli not found — install it to transcribe" }
          : null,
  },
  {
    id: "ax",
    kind: "ax",
    name: "Accessibility tree",
    describe: "Reads the name and role of everything on screen, so you can search by label.",
    meta: () => null,
    permission: "accessibility",
    needs: (e) => (e.axSidecarAvailable ? null : { ok: false, note: "ax-dump sidecar missing (npm run build:ax)" }),
  },
];

export function RecordScreen({ status, env, onOpenIndexing }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [perms, setPerms] = useState<PermissionStatus[]>([]);
  const [tick, setTick] = useState(0);
  const [signals, setSignals] = useState<RecordingTickDTO | null>(null);

  const refresh = (): void => {
    api.settings.get().then(setSettings);
    api.permissions.check().then(setPerms);
  };
  useEffect(refresh, []);

  // Live elapsed readout.
  const live = status.state === "recording";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [live]);
  useEffect(() => {
    if (status.state === "idle") refresh();
  }, [status.state]);

  // The wells. Subscribed for the life of the screen, not for the life of a
  // recording: main is silent while nothing captures, and a subscription torn
  // down on a state change would miss the first tick, which arrives immediately.
  // Cleared on stop so no well can report counts for a recording that has ended.
  useEffect(() => api.recording.onTick(setSignals), []);
  useEffect(() => {
    if (!live) setSignals(null);
  }, [live]);

  if (!settings)
    return (
      <div className="page">
        <div className="loading">
          <div className="spinner" />
        </div>
      </div>
    );

  const permState = (k?: PermissionKind): PermissionStatus | undefined =>
    perms.find((p) => p.kind === k);

  const toggle = async (id: SignalId): Promise<void> => {
    const next = !settings.signals[id].enabled;
    const patch = { signals: { [id]: { enabled: next } } };
    setSettings(await api.settings.set(patch));
  };

  const elapsedMs = status.startedAt ? Date.now() - status.startedAt : 0;
  void tick;

  const start = (): void => void api.recording.start();
  const stop = (): void => void api.recording.stop();

  return (
    <div className="page record">
      <div className="page__head">
        <span className="eyebrow">Session recorder</span>
        <h1>Capture an experience</h1>
        {/* THE WINDOW DISAPPEARS ON RECORD AND THAT HAS TO BE SAID HERE.
            DeskRAG hides itself while capturing, because the window producer
            polls the frontmost application and an app left on screen films its
            own UI into every route it records. Unannounced, pressing the button
            looks like the app quitting — and the control that stops it is in a
            place the user has no reason to look. */}
        <p>
          Record your screen, input, and audio into a searchable memory. DeskRAG hides while it
          records so it stays out of your flows — stop from the menu bar, and the window comes
          back. Recording also keeps running if you close the window to the tray.
        </p>
      </div>

      {/* The transport owns the screen's slack: it is the subject, the band
          below is reference, and the head is read once. */}
      <div className="record__stage">
        <div className="transport">
          <div className={`transport__readout${live ? "" : " is-idle"}`}>
            {timecode(live ? elapsedMs : 0)}
          </div>
          {/* NEVER disabled by indexing. That is the whole point of the
              queue: stopping a recording hands it off, and the next one can
              start immediately. The button used to go dead for the length of
              the pipeline — about ten minutes over 546 frames. */}
          <button
            className={`recbtn${live ? " is-live" : ""}`}
            onClick={live ? stop : start}
            aria-label={live ? "Stop recording" : "Start recording"}
          >
            <span className="recbtn__core" />
          </button>
          <div className="transport__hint">
            {live ? "Click to stop, or use the menu bar" : "Click to start — the window will hide"}
          </div>
          {/* The handoff, named. Without this the recording appears to vanish
              on stop: nothing on this screen says where it went. */}
          <button className="transport__handoff" onClick={onOpenIndexing}>
            Recordings are indexed in the background — open the queue
          </button>
        </div>
      </div>

      <div className="record__band">
        <span className="eyebrow">Signals</span>
        <div className="signals">
          {SIGNALS.map((sig) => {
            const cfg = settings.signals[sig.id];
            const perm = permState(sig.permission);
            const need = env && sig.needs ? sig.needs(env) : null;
            const granted = !sig.permission || perm?.state === "granted" || perm?.state === "unknown";
            const gate: SignalGate = {
              enabled: cfg.enabled,
              granted,
              // Only a HARD gate blocks: the whisper note is `ok: true` — the
              // audio is recorded either way, only the transcript waits.
              ...(need && !need.ok ? { blockedBy: need.note } : {}),
            };
            const read = signalReadout(sig.kind, gate, live, signals?.signals[sig.kind]);
            return (
              <div className={`signal${cfg.enabled ? "" : " signal--off"}`} key={sig.id}>
                <div className="signal__row">
                  <span className={`led ${read.led}`} />
                  <span className="signal__name">{sig.name}</span>
                  <button
                    className={`switch${cfg.enabled ? " on" : ""}`}
                    onClick={() => void toggle(sig.id)}
                    disabled={live}
                    aria-pressed={cfg.enabled}
                    aria-label={`Toggle ${sig.name}`}
                  />
                </div>
                <p className="signal__what">{sig.describe}</p>
                {sig.meta(settings) !== null && (
                  <div className="signal__meta">{sig.meta(settings)}</div>
                )}
                {cfg.enabled && sig.permission && perm && perm.state !== "granted" && perm.state !== "unknown" && (
                  <div className="signal__note">
                    Needs {sig.permission} permission ·{" "}
                    {perm.canRequest ? (
                      <a onClick={() => void requestPerm(sig.permission!, refresh)}>Grant</a>
                    ) : (
                      <a onClick={() => void api.permissions.openSettings(sig.permission!)}>Open Settings</a>
                    )}
                  </div>
                )}
                {cfg.enabled && need?.ok && <div className="signal__note signal__note--soft">{need.note}</div>}
                {/* The well ALWAYS answers — off, blocked, ready, or a figure.
                    A card that simply went blank would be indistinguishable
                    from one nobody finished. */}
                <div
                  className={`signal__well${read.idle ? " signal__well--idle" : ""}`}
                  {...(read.note ? { title: read.note } : {})}
                >
                  <span
                    className={`signal__figure mono${read.tone ? " signal__figure--tone" : ""}`}
                    {...(read.tone ? { "data-tone": read.tone } : {})}
                  >
                    {read.figure}
                  </span>
                  {read.glyph?.kind === "count" && (
                    <span className="signal__aside mono">{read.glyph.text}</span>
                  )}
                  {read.glyph?.kind === "frame" && (
                    <img
                      className="signal__thumb"
                      src={`deskrag://frame/${read.glyph.blobId}`}
                      alt="The keyframe just kept"
                    />
                  )}
                  {read.glyph?.kind === "wave" && (
                    <svg className="signal__wave" viewBox="0 0 64 20" preserveAspectRatio="none" aria-hidden>
                      <path d={wavePath(read.glyph.peaks, 64, 20)} />
                    </svg>
                  )}
                </div>
                {read.warning && <div className="signal__note">{read.warning}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

async function requestPerm(kind: PermissionKind, done: () => void): Promise<void> {
  await api.permissions.request(kind);
  done();
}
