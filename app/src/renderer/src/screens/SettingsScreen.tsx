import React, { useEffect, useState } from "react";
import type {
  CaptionProvider,
  Capabilities,
  EnvInfo,
  ImageProvider,
  ModelDownloadProgress,
  ProviderSettingsView,
  SettingsPatch,
  SettingsView,
  TextProvider,
} from "@shared/types";
import { api } from "../api.js";

interface Props {
  onEnv: (e: EnvInfo) => void;
}

/**
 * Every model here runs on this machine — there are no keys and no remote
 * options, so the screen is four groups of local configuration rather than a
 * local/cloud choice.
 *
 * The one non-obvious rule it enforces is ColSmol's capture width: below 2048 on
 * the long edge its preprocessor UPSCALES, sharp's magnification path diverges
 * from the reference implementation, and ~1% of patch vectors drift below cosine
 * 0.90 — silently, with scores still looking sane. That is why picking ColSmol
 * surfaces a width warning rather than trusting the default.
 */
export function SettingsScreen({ onEnv }: Props): React.JSX.Element {
  const [s, setS] = useState<SettingsView | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [saved, setSaved] = useState(false);
  const [visionModels, setVisionModels] = useState<string[]>([]);
  const [download, setDownload] = useState<ModelDownloadProgress | null>(null);

  const load = (): void => {
    api.settings.get().then(setS);
    api.settings.capabilities().then(setCaps);
    api.ollama.visionModels().then(setVisionModels);
  };
  useEffect(load, []);

  // Weight downloads can start from a search, not just from this screen, so the
  // indicator subscribes for the lifetime of the view.
  useEffect(() => api.models.onDownload((p) => setDownload(p.done ? null : p)), []);

  if (!s) return <div className="spinner" />;

  const flash = (): void => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const patchProviders = async (p: SettingsPatch["providers"]): Promise<void> => {
    const next = await api.settings.set({ providers: p });
    setS(next);
    setCaps(await api.settings.capabilities());
    api.system.env().then(onEnv);
  };

  const patchSignals = async (
    patch: Parameters<typeof api.settings.set>[0]["signals"],
  ): Promise<void> => {
    setS(await api.settings.set({ signals: patch }));
    api.system.env().then(onEnv);
    flash();
  };

  const p = s.providers;
  const narrowForColSmol = p.imageProvider === "colsmol" && s.signals.screen.imageMaxWidth < 2048;

  return (
    <div className="page">
      <div className="page__head">
        <span className="eyebrow">Configuration</span>
        <h1>Settings</h1>
        <p>
          Every model runs on this machine. Weights download once, then work offline — nothing
          you record is ever sent anywhere.
        </p>
      </div>

      {saved && (
        <div
          className="banner"
          style={{
            background: "color-mix(in srgb, var(--ok) 12%, var(--panel))",
            borderColor: "color-mix(in srgb, var(--ok) 40%, var(--hairline))",
          }}
        >
          <span className="led ok" /> Saved
        </div>
      )}

      <div className="card">
        <h2>Models</h2>
        <p className="sub">
          Which local model backs each step of the pipeline. Everything but text embeddings can be
          turned off.
        </p>

        {download && (
          <div className="form-row">
            <div>
              <label>Downloading {download.modelId}</label>
              <div className="desc">
                {Math.round((download.receivedBytes / Math.max(1, download.totalBytes)) * 100)}% —
                one-time
              </div>
            </div>
          </div>
        )}

        <div className="form-row">
          <div>
            <label>Text embeddings</label>
            <div className="desc">ONNX runs in-process; Ollama needs the daemon running</div>
          </div>
          <select
            value={p.textProvider}
            onChange={(e) => void patchProviders({ textProvider: e.target.value as TextProvider })}
          >
            <option value="ollama">Ollama</option>
            <option value="onnx">ONNX (in-process)</option>
          </select>
        </div>

        <div className="form-row">
          <div>
            <label>Image model</label>
            <div className="desc">
              {p.imageProvider === "colsmol"
                ? "Slower (seconds per frame), and highlights come from matched patches"
                : p.imageProvider === "nomic"
                  ? "Fast, and adds labelled region highlights you can search by UI role"
                  : "For search-by-image + region highlights"}
            </div>
          </div>
          <select
            value={p.imageProvider}
            onChange={(e) => void patchProviders({ imageProvider: e.target.value as ImageProvider })}
          >
            <option value="none">None (text + behavior only)</option>
            <option value="nomic">Nomic Vision (recommended)</option>
            <option value="colsmol">ColSmol (late interaction)</option>
          </select>
        </div>

        {narrowForColSmol && (
          <div className="banner">
            <span className="led" /> ColSmol needs keyframes at 2048px or wider — below that its
            preprocessor upscales and match quality degrades without any visible error. Yours is{" "}
            {s.signals.screen.imageMaxWidth}px.
            <button
              className="btn"
              style={{ marginLeft: 12 }}
              onClick={() => void patchSignals({ screen: { imageMaxWidth: 2560 } })}
            >
              Set to 2560
            </button>
          </div>
        )}

        {p.imageProvider === "colsmol" && !s.signals.ax.enabled && (
          <div className="banner">
            <span className="led" /> Turn on accessibility capture for exact-text search — the image
            model reads layout, not text, so AX labels are what match a typed phrase.
            <button
              className="btn"
              style={{ marginLeft: 12 }}
              onClick={() => void patchSignals({ ax: { enabled: true } })}
            >
              Enable AX
            </button>
          </div>
        )}

        <div className="form-row">
          <div>
            <label>Captions</label>
            <div className="desc">
              {visionModels.length > 0
                ? "A local VLM describes each keyframe"
                : "No local vision model — run: ollama pull qwen3-vl:4b"}
            </div>
          </div>
          <select
            value={p.captionProvider}
            disabled={visionModels.length === 0 && p.captionProvider === "none"}
            onChange={(e) =>
              void patchProviders({ captionProvider: e.target.value as CaptionProvider })
            }
          >
            <option value="none">None</option>
            <option value="ollama">Ollama (local VLM)</option>
          </select>
        </div>

        <div className="form-row">
          <div>
            <label>Rerank (Tier 4)</label>
            <div className="desc">A cross-encoder reorders the top text results</div>
          </div>
          <select
            value={p.rerankProvider}
            onChange={(e) =>
              void patchProviders({
                rerankProvider: e.target.value as ProviderSettingsView["rerankProvider"],
              })
            }
          >
            <option value="none">None</option>
            <option value="onnx">Local cross-encoder</option>
          </select>
        </div>

        <div className="form-row">
          <div>
            <label>Model directory</label>
            <div className="desc">Leave blank for managed downloads under the app data dir</div>
          </div>
          <input
            className="mono"
            type="text"
            placeholder="(managed)"
            value={p.localModels.dir}
            onChange={(e) => void patchProviders({ localModels: { dir: e.target.value } })}
          />
        </div>
      </div>

      <div className="card">
        <h2>Ollama</h2>
        <p className="sub">
          Used for whichever steps above are set to Ollama. The daemon must be running on this
          host.
        </p>
        <div className="form-row">
          <label>Host</label>
          <input
            className="mono"
            type="text"
            value={p.ollamaHost}
            onChange={(e) => void patchProviders({ ollamaHost: e.target.value })}
          />
        </div>
        <div className="form-row">
          <div>
            <label>Embedding model</label>
            <div className="desc">Powers digest, caption, and transcript search</div>
          </div>
          <input
            className="mono"
            type="text"
            value={p.ollamaModel}
            onChange={(e) => void patchProviders({ ollamaModel: e.target.value })}
          />
        </div>
        <div className="form-row">
          <div>
            <label>Caption model</label>
            <div className="desc">
              {visionModels.length > 0
                ? "Vision models pulled on this machine"
                : "None pulled — run: ollama pull qwen3-vl:4b"}
            </div>
          </div>
          <select
            value={p.ollamaCaptionModel}
            disabled={visionModels.length === 0}
            onChange={(e) => void patchProviders({ ollamaCaptionModel: e.target.value })}
          >
            {/* Sourced from /api/tags, never hardcoded: Ollama's library now
                includes cloud-hosted models, and listing one here would send
                screenshots off the machine. */}
            {visionModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {visionModels.length === 0 && <option value={p.ollamaCaptionModel}>—</option>}
          </select>
        </div>
      </div>

      <div className="card">
        <h2>Transcription (local Whisper)</h2>
        <p className="sub">
          Point to a whisper.cpp binary and a model file to transcribe recorded audio.{" "}
          {caps?.transcript
            ? "Configured."
            : "Not configured — audio is stored but not transcribed."}
        </p>
        <div className="form-row">
          <label>Binary path</label>
          <input
            className="mono"
            type="text"
            value={p.whisper.binaryPath}
            onChange={(e) => void patchProviders({ whisper: { binaryPath: e.target.value } })}
            placeholder="whisper-cli"
          />
        </div>
        <div className="form-row">
          <label>Model path</label>
          <input
            className="mono"
            type="text"
            value={p.whisper.modelPath}
            onChange={(e) => void patchProviders({ whisper: { modelPath: e.target.value } })}
            placeholder="/path/to/ggml-base.en.bin"
          />
        </div>
      </div>

      <div className="card">
        <h2>Capture defaults</h2>
        <p className="sub">
          Applied to new recordings. Toggle which signals record on the Record tab.
        </p>
        <div className="form-row">
          <label>Screen frame rate</label>
          <input
            type="number"
            min={1}
            max={10}
            value={s.signals.screen.fps}
            onChange={(e) => void patchSignals({ screen: { fps: Number(e.target.value) } })}
          />
        </div>
        <div className="form-row">
          <div>
            <label>Keyframe max width</label>
            <div className="desc">2048 or more when an image model is on</div>
          </div>
          <input
            type="number"
            min={320}
            max={3840}
            step={80}
            value={s.signals.screen.imageMaxWidth}
            onChange={(e) =>
              void patchSignals({ screen: { imageMaxWidth: Number(e.target.value) } })
            }
          />
        </div>
        <div className="form-row">
          <label>Audio device</label>
          <input
            className="mono"
            type="text"
            value={s.signals.audio.device}
            onChange={(e) => void patchSignals({ audio: { device: e.target.value } })}
            placeholder=":0"
          />
        </div>
        <div className="form-row">
          <label>Audio chunk seconds</label>
          <input
            type="number"
            min={2}
            max={30}
            value={s.signals.audio.chunkSeconds}
            onChange={(e) => void patchSignals({ audio: { chunkSeconds: Number(e.target.value) } })}
          />
        </div>
      </div>
    </div>
  );
}
