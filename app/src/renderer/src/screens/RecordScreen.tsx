import React, { useEffect, useState } from "react";
import type {
  EnvInfo,
  IndexingProgress,
  PermissionKind,
  PermissionStatus,
  RecordingStatus,
  SettingsView,
  SignalConfig,
} from "@shared/types";
import { api, timecode } from "../api.js";

interface Props {
  status: RecordingStatus;
  env: EnvInfo | null;
}

type SignalId = keyof SignalConfig;

interface SignalDef {
  id: SignalId;
  name: string;
  meta: (s: SettingsView) => string;
  permission?: PermissionKind;
  needs?: (env: EnvInfo) => { ok: boolean; note: string } | null;
}

const SIGNALS: SignalDef[] = [
  {
    id: "screen",
    name: "Screen",
    meta: (s) => `${s.signals.screen.fps} fps · ${s.signals.screen.imageMaxWidth}px`,
    permission: "screen",
    needs: (e) => (e.ffmpegAvailable ? null : { ok: false, note: "ffmpeg not found on PATH" }),
  },
  { id: "input", name: "Input (mouse + keys)", meta: () => "clicks · scroll · keys", permission: "accessibility" },
  { id: "activeWin", name: "Active window", meta: () => "focus changes", permission: "screen" },
  {
    id: "audio",
    name: "Microphone",
    meta: (s) => `${s.signals.audio.device} · ${s.signals.audio.chunkSeconds}s chunks`,
    permission: "microphone",
    needs: (e) =>
      !e.ffmpegAvailable
        ? { ok: false, note: "ffmpeg not found on PATH" }
        : !e.whisperConfigured
          ? { ok: true, note: "recorded, but set a Whisper model in Settings to transcribe" }
          : null,
  },
  {
    id: "ax",
    name: "Accessibility tree",
    meta: () => "UI labels + roles",
    permission: "accessibility",
    needs: (e) => (e.axSidecarAvailable ? null : { ok: false, note: "ax-dump sidecar missing (npm run build:ax)" }),
  },
];

export function RecordScreen({ status, env }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [perms, setPerms] = useState<PermissionStatus[]>([]);
  const [progress, setProgress] = useState<IndexingProgress | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = (): void => {
    api.settings.get().then(setSettings);
    api.permissions.check().then(setPerms);
  };
  useEffect(refresh, []);
  useEffect(() => api.recording.onIndexing(setProgress), []);

  // Live elapsed readout.
  const live = status.state === "recording";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [live]);
  useEffect(() => {
    if (status.state === "indexing") setProgress(null);
    if (status.state === "idle") refresh();
  }, [status.state]);

  if (!settings) return <div className="spinner" />;

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
  const busy = status.state === "indexing";

  return (
    <div className="page">
      <div className="page__head">
        <span className="eyebrow">Session recorder</span>
        <h1>Capture an experience</h1>
        <p>
          Record your screen, input, and audio into a searchable memory. Recording keeps running
          if you close the window to the tray.
        </p>
      </div>

      <div className="transport">
        <div className={`transport__readout${live ? "" : " is-idle"}`}>
          {timecode(live ? elapsedMs : 0)}
        </div>
        <button
          className={`recbtn${live ? " is-live" : ""}`}
          onClick={live ? stop : start}
          disabled={busy}
          aria-label={live ? "Stop recording" : "Start recording"}
        >
          <span className="recbtn__core" />
        </button>
        <div className="transport__hint">
          {busy ? "Indexing the last recording…" : live ? "Click to stop" : "Click to start recording"}
        </div>
      </div>

      {busy && (
        <div className="indexing">
          <div className="indexing__row">
            <span className="indexing__stage">{progress?.stage ?? "Preparing…"}</span>
            <span className="mono" style={{ color: "var(--muted)" }}>
              {progress ? `${progress.done}/${progress.total}` : ""}
            </span>
          </div>
          <div className="bar">
            <div
              className="bar__fill"
              style={{ width: progress ? `${(progress.done / Math.max(1, progress.total)) * 100}%` : "8%" }}
            />
          </div>
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <span className="eyebrow">Signals</span>
        <div className="signals" style={{ marginTop: 10 }}>
          {SIGNALS.map((sig) => {
            const cfg = settings.signals[sig.id];
            const perm = permState(sig.permission);
            const need = env && sig.needs ? sig.needs(env) : null;
            const granted = !sig.permission || perm?.state === "granted" || perm?.state === "unknown";
            let led: "ok" | "warn" | "off" = "off";
            if (cfg.enabled) {
              led = granted && (need?.ok ?? true) ? "ok" : "warn";
            }
            return (
              <div className="signal" key={sig.id}>
                <div className="signal__row">
                  <span className={`led ${led}`} />
                  <span className="signal__name">{sig.name}</span>
                  <button
                    className={`switch${cfg.enabled ? " on" : ""}`}
                    onClick={() => void toggle(sig.id)}
                    disabled={live || busy}
                    aria-pressed={cfg.enabled}
                    aria-label={`Toggle ${sig.name}`}
                  />
                </div>
                <div className="signal__meta">{sig.meta(settings)}</div>
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
                {cfg.enabled && need && (
                  <div className="signal__note" style={need.ok ? { color: "var(--muted)" } : undefined}>
                    {need.note}
                  </div>
                )}
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
