import React, { useEffect, useState } from "react";
import type {
  CaptionProvider,
  EnvInfo,
  ImageProvider,
  ModelDownloadProgress,
  ProviderSettingsView,
  SettingsPatch,
  SettingsView,
  SummaryProvider,
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
  // Availability of the external CLIs (whisper.cpp, ffmpeg) is an ENV fact, not
  // a capability: capabilities report configured intent, which for transcripts is
  // now always true because the model is managed.
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [saved, setSaved] = useState(false);
  const [visionModels, setVisionModels] = useState<string[]>([]);
  const [chatModels, setChatModels] = useState<string[]>([]);
  const [download, setDownload] = useState<ModelDownloadProgress | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [searchReindexing, setSearchReindexing] = useState(false);
  const [reindexed, setReindexed] = useState<string | null>(null);
  const [reindexError, setReindexError] = useState<string | null>(null);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const refreshEnv = (): void => {
    void api.system.env().then((e) => {
      setEnv(e);
      onEnv(e);
    });
  };

  const load = (): void => {
    api.settings.get().then(setS);
    api.ollama.visionModels().then(setVisionModels);
    api.ollama.chatModels().then(setChatModels);
    refreshEnv();
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
    refreshEnv();
  };

  const patchSignals = async (
    patch: Parameters<typeof api.settings.set>[0]["signals"],
  ): Promise<void> => {
    setS(await api.settings.set({ signals: patch }));
    refreshEnv();
    flash();
  };

  /**
   * Re-lift every recording into a fresh trace graph. Nothing is re-recorded:
   * the lift reads the AX snapshots and event stream already on disk, so this is
   * how a corrected lift rule reaches sessions captured under the old one.
   * Indexing otherwise runs only when a recording stops.
   */
  const reindex = async (): Promise<void> => {
    setReindexing(true);
    setReindexError(null);
    setReindexed(null);
    try {
      const r = await api.sessions.reindex();
      setReindexed(
        r.sessions === 0
          ? "Nothing to rebuild — no recording produced any events."
          : `Rebuilt from ${r.sessions} recording${r.sessions === 1 ? "" : "s"}: ` +
            `${r.nodes} nodes, ${r.edges} edges, ${r.actions} actions` +
            (r.variables > 0 ? `, ${r.variables} variables` : "") +
            (r.skipped > 0 ? ` · ${r.skipped} empty session skipped` : ""),
      );
    } catch (e) {
      setReindexError(String(e));
    } finally {
      setReindexing(false);
    }
  };

  /**
   * Re-runs the search-side stages over every recording. Distinct from the
   * trace rebuild above: what a recording is FINDABLE by is decided by the code
   * that indexed it, so a recording made before the digest carried window
   * titles, typed text and clicked labels stays unfindable by any of them until
   * this runs. It also writes the frame↔segment links that text-only search
   * recalls frames through — without an image provider configured, older
   * recordings have none and return no results at all.
   */
  const reindexSearch = async (): Promise<void> => {
    setSearchReindexing(true);
    setReindexError(null);
    setReindexed(null);
    try {
      const r = await api.sessions.reindexSearch();
      setReindexed(
        r.sessions === 0
          ? "Nothing to re-index — no recordings yet."
          : `Re-indexed ${r.sessions} recording${r.sessions === 1 ? "" : "s"}: ${r.segments} segments.`,
      );
    } catch (e) {
      setReindexError(String(e));
    } finally {
      setSearchReindexing(false);
    }
  };

  /**
   * Wipes the app data dir and relaunches — every recording, the trace graph,
   * the search index, and downloaded model weights are gone, and settings
   * return to defaults. The main process closes the store before deleting
   * anything, so this either resolves after a relaunch or throws with nothing
   * touched (a recording in progress).
   */
  const resetApp = async (): Promise<void> => {
    setResetting(true);
    setResetError(null);
    try {
      await api.system.reset();
    } catch (e) {
      setResetError(String(e));
      setResetting(false);
    }
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
            <label>Task summaries</label>
            <div className="desc">
              {chatModels.length > 0
                ? "A local LLM groups actions into tasks and names each one"
                : "No local chat model — run: ollama pull qwen3:4b"}
            </div>
          </div>
          <select
            value={p.summaryProvider}
            disabled={chatModels.length === 0 && p.summaryProvider === "none"}
            onChange={(e) =>
              void patchProviders({ summaryProvider: e.target.value as SummaryProvider })
            }
          >
            {/* "None" still builds the whole hierarchy — structurally, with
                templated rollups. This picker only changes the prose. */}
            <option value="none">None (structural)</option>
            <option value="ollama">Ollama (local LLM)</option>
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
        <div className="form-row">
          <div>
            <label>Summary model</label>
            <div className="desc">
              {chatModels.length > 0
                ? "Chat models pulled on this machine"
                : "None pulled — run: ollama pull qwen3:4b"}
            </div>
          </div>
          <select
            value={p.ollamaSummaryModel}
            disabled={chatModels.length === 0}
            onChange={(e) => void patchProviders({ ollamaSummaryModel: e.target.value })}
          >
            {/* /api/tags again, same reason: a cloud-hosted entry offered here
                would send a recording's own text off the machine. */}
            {chatModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {chatModels.length === 0 && <option value={p.ollamaSummaryModel}>—</option>}
          </select>
        </div>
      </div>

      <div className="card">
        <h2>Transcription (local Whisper)</h2>
        <p className="sub">
          Recorded audio is transcribed by a local whisper.cpp binary. The model downloads
          automatically on the first transcript — leave the model path empty to use it.{" "}
          {env?.whisperConfigured ? "Ready." : "Audio is stored, but not transcribed."}
        </p>

        {/* Installing the binary changes nothing the app notices on its own, so
            the probe needs a way to be re-run without restarting. */}
        {env && !env.whisperConfigured && (
          <div className="banner">
            <span className="led" /> No whisper.cpp binary found. Install one with{" "}
            <span className="mono">brew install whisper-cpp</span>, or point the path below at
            your own build.
            <button className="btn" style={{ marginLeft: 12 }} onClick={refreshEnv}>
              Re-check
            </button>
          </div>
        )}
        <div className="form-row">
          <div>
            <label>Binary path</label>
            <div className="desc">Optional — empty looks up whisper-cli on PATH</div>
          </div>
          <input
            className="mono"
            type="text"
            value={p.whisper.binaryPath}
            onChange={(e) => void patchProviders({ whisper: { binaryPath: e.target.value } })}
            placeholder="whisper-cli"
          />
        </div>
        <div className="form-row">
          <div>
            <label>Model path</label>
            <div className="desc">Optional — empty uses the managed base.en model</div>
          </div>
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
          <div>
            <label>Audio device</label>
            <div className="desc">
              <span className="mono">:default</span> follows macOS Sound. An index like{" "}
              <span className="mono">:2</span> picks one device — check it with{" "}
              <span className="mono">ffmpeg -f avfoundation -list_devices true -i ""</span>,
              since index 0 is often a virtual device that records silence.
            </div>
          </div>
          <input
            className="mono"
            type="text"
            value={s.signals.audio.device}
            onChange={(e) => void patchSignals({ audio: { device: e.target.value } })}
            placeholder=":default"
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

      <div className="card">
        <h2>Maintenance</h2>
        <p className="sub">Housekeeping for what has been recorded and downloaded on this machine.</p>
        <div className="form-row">
          <div>
            <label>Search index</label>
            <div className="desc">
              Re-links keyframes to segments, rebuilds every digest, and rewrites the text index,
              for every recording already on disk. Nothing is re-recorded and no video, keyframe,
              caption or transcript is touched. Needed for anything recorded before the digest
              carried window titles, typed text and clicked labels — and required for text search
              to return anything at all from a recording indexed with no image provider.
            </div>
          </div>
          <button
            className="btn ghost"
            onClick={() => void reindexSearch()}
            disabled={searchReindexing || reindexing}
          >
            {searchReindexing ? "Re-indexing…" : "Rebuild search index"}
          </button>
        </div>

        <div className="form-row">
          <div>
            <label>Trace graph</label>
            <div className="desc">
              Re-lifts every recording into a fresh trace graph. Nothing is re-recorded, and no
              video or keyframe is touched. Needed after a lift-rule change, or if the Flows
              screen says the graph was built before recordings were tracked.
            </div>
          </div>
          <button
            className="btn ghost"
            onClick={() => void reindex()}
            disabled={reindexing || searchReindexing}
          >
            {reindexing ? "Rebuilding…" : "Rebuild trace graph"}
          </button>
        </div>

        {reindexed && (
          <div className="banner" style={{ marginTop: 16 }}>
            <span className="led" /> {reindexed}
          </div>
        )}

        {reindexError && (
          <div className="banner" style={{ marginTop: 16 }}>
            <span className="led" /> {reindexError}
          </div>
        )}

        <div className="form-row">
          <div>
            <label>Reset application</label>
            <div className="desc">
              Deletes every recording, the trace graph, the search index, and downloaded model
              weights, and returns settings to their defaults. A custom Model directory (above)
              lives outside the app data dir and is not touched. The app relaunches once it's
              done. This cannot be undone.
            </div>
          </div>
          <button
            className="btn danger"
            onClick={() => {
              setResetConfirmText("");
              setResetError(null);
              setResetConfirming(true);
            }}
          >
            Reset application…
          </button>
        </div>
      </div>

      {resetConfirming && (
        <div
          className="overlay"
          onClick={() => !resetting && setResetConfirming(false)}
        >
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Reset DeskRAG to its default state?</h3>
            <p className="confirm__warn">
              Every recording, the trace graph, the search index, and any downloaded model
              weights are deleted permanently. Settings return to their defaults. The app then
              relaunches.
            </p>
            <p className="mono">Type RESET to confirm.</p>
            <input
              className="mono"
              type="text"
              value={resetConfirmText}
              onChange={(e) => setResetConfirmText(e.target.value)}
              placeholder="RESET"
              disabled={resetting}
              autoFocus
            />

            {resetError && (
              <div className="banner">
                <span className="led" /> {resetError}
              </div>
            )}

            <div className="confirm__actions">
              <button
                className="btn ghost"
                onClick={() => setResetConfirming(false)}
                disabled={resetting}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={resetConfirmText !== "RESET" || resetting}
                onClick={() => void resetApp()}
              >
                {resetting ? "Resetting…" : "Reset everything"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
