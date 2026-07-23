import React, { useEffect, useState } from "react";
import type {
  CaptionProvider,
  Capabilities,
  EnvInfo,
  ImageProvider,
  SettingsPatch,
  SettingsView,
} from "@shared/types";
import { api } from "../api.js";

interface Props {
  onEnv: (e: EnvInfo) => void;
}

type KeyName = "voyage" | "gemini" | "anthropic";

export function SettingsScreen({ onEnv }: Props): React.JSX.Element {
  const [s, setS] = useState<SettingsView | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<KeyName, string>>({
    voyage: "",
    gemini: "",
    anthropic: "",
  });
  const [saved, setSaved] = useState(false);

  const load = (): void => {
    api.settings.get().then(setS);
    api.settings.capabilities().then(setCaps);
  };
  useEffect(load, []);

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

  const saveKey = async (name: KeyName): Promise<void> => {
    const val = keyInputs[name].trim();
    if (!val) return;
    setS(await api.settings.set({ keys: { [name]: val } }));
    setKeyInputs({ ...keyInputs, [name]: "" });
    setCaps(await api.settings.capabilities());
    flash();
  };
  const clearKey = async (name: KeyName): Promise<void> => {
    setS(await api.settings.set({ keys: { [name]: null } }));
    setCaps(await api.settings.capabilities());
  };

  const patchSignals = async (patch: Parameters<typeof api.settings.set>[0]["signals"]): Promise<void> => {
    setS(await api.settings.set({ signals: patch }));
    api.system.env().then(onEnv);
    flash();
  };

  const p = s.providers;

  return (
    <div className="page">
      <div className="page__head">
        <span className="eyebrow">Configuration</span>
        <h1>Settings</h1>
        <p>
          DeskRAG runs locally by default with Ollama. Add provider keys to unlock captions,
          image-example search, and reranking. Keys are encrypted in your OS keychain.
        </p>
      </div>

      {saved && <div className="banner" style={{ background: "color-mix(in srgb, var(--ok) 12%, var(--panel))", borderColor: "color-mix(in srgb, var(--ok) 40%, var(--hairline))" }}><span className="led ok" /> Saved</div>}

      <div className="card">
        <h2>Embeddings</h2>
        <p className="sub">The local text embedder powers digest, caption, and transcript search.</p>
        <div className="form-row">
          <label>Ollama host</label>
          <input
            className="mono"
            type="text"
            value={p.ollamaHost}
            onChange={(e) => void patchProviders({ ollamaHost: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label>Ollama model</label>
          <input
            className="mono"
            type="text"
            value={p.ollamaModel}
            onChange={(e) => void patchProviders({ ollamaModel: e.target.value })}
          />
        </div>
        <div className="form-row">
          <div>
            <label>Image provider</label>
            <div className="desc">For search-by-image + region highlights</div>
          </div>
          <select
            value={p.imageProvider}
            onChange={(e) => void patchProviders({ imageProvider: e.target.value as ImageProvider })}
          >
            <option value="none">None (text + behavior only)</option>
            <option value="voyage">Voyage (multimodal)</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
        <div className="form-row">
          <div>
            <label>Caption provider</label>
            <div className="desc">VLM captions of keyframes</div>
          </div>
          <select
            value={p.captionProvider}
            onChange={(e) => void patchProviders({ captionProvider: e.target.value as CaptionProvider })}
          >
            <option value="none">None</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
        <div className="form-row">
          <div>
            <label>LLM rerank (Tier 4)</label>
            <div className="desc">Reorders top text results — needs an Anthropic key</div>
          </div>
          <button
            className={`switch${p.rerank ? " on" : ""}`}
            onClick={() => void patchProviders({ rerank: !p.rerank })}
            aria-pressed={p.rerank}
            aria-label="Toggle rerank"
          />
        </div>
      </div>

      <div className="card">
        <h2>API keys</h2>
        <p className="sub">Stored encrypted. Only presence is ever shown; values never leave the main process.</p>
        {(["voyage", "gemini", "anthropic"] as KeyName[]).map((name) => (
          <div className="form-row" key={name}>
            <div>
              <label style={{ textTransform: "capitalize" }}>{name}</label>
              <span className={`key-state${p.keys[name] ? "" : " unset"}`}>
                {p.keys[name] ? "set" : "not set"}
              </span>
            </div>
            <div className="inline">
              <input
                type="password"
                placeholder={p.keys[name] ? "••••••••  (enter to replace)" : `${name} API key`}
                value={keyInputs[name]}
                onChange={(e) => setKeyInputs({ ...keyInputs, [name]: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && void saveKey(name)}
              />
              <button className="btn" onClick={() => void saveKey(name)} disabled={!keyInputs[name].trim()}>
                Save
              </button>
              {p.keys[name] && (
                <button className="btn ghost" onClick={() => void clearKey(name)}>
                  Clear
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Transcription (local Whisper)</h2>
        <p className="sub">
          Point to a whisper.cpp binary and a model file to transcribe recorded audio.{" "}
          {caps?.transcript ? "Configured." : "Not configured — audio is stored but not transcribed."}
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
        <p className="sub">Applied to new recordings. Toggle which signals record on the Record tab.</p>
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
          <label>Keyframe max width</label>
          <input
            type="number"
            min={320}
            max={3840}
            step={80}
            value={s.signals.screen.imageMaxWidth}
            onChange={(e) => void patchSignals({ screen: { imageMaxWidth: Number(e.target.value) } })}
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
