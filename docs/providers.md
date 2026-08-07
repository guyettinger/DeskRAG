# Providers

Every provider runs on this machine. There is no remote option — not a disabled one,
not a key field left blank. Adapters either talk to a daemon on localhost, run the
model in-process, or spawn a subprocess. **A network call to a third party is a
regression, not a feature to add.**

| Role | Provider | Model |
|---|---|---|
| Text embedding | Ollama (daemon) | `nomic-embed-text` |
| Text embedding | ONNX (in-process) | `nomic-embed-text-v1.5` (int8) |
| Image, single-vector | ONNX (in-process) | `nomic-embed-vision-v1.5` (int8) — writes region rows, so Tier 3 + AX-label FTS highlights work |
| Image, late interaction | ONNX (in-process) | `colSmol-256M-dynamic` — patches *are* the regions, so highlights fall out of the MaxSim argmax instead |
| Behavioral vector | builtin | `input-dynamics-v1`, 12-dim |
| VLM caption | Ollama (daemon) | any vision model you've pulled, e.g. `qwen3-vl:4b` |
| Transcription (STT) | whisper.cpp (subprocess) | `ggml-base.en-q5_1.bin`, downloaded like any other weight |
| Rerank (Tier 4) | ONNX (in-process) | `jina-reranker-v1-turbo-en` |

## Weights are pinned

Weights are fetched once from HuggingFace at a **pinned commit SHA** and verified
against a recorded sha256 — a moving `main` would change the model while the
namespace kept claiming the same one, silently breaking vector comparability.

Acquisition lives in the app, never the library: `deskrag` on npm fetches nothing at
install or at runtime.

The whisper GGML model is in that manifest too, even though it is not ONNX and is read
by an external binary rather than in-process. An empty `providers.whisper.modelPath`
therefore means "use the managed model", not "transcription off" — set it only to point
at your own file — and an empty `binaryPath` means `whisper-cli` on `PATH` for exactly the
same reason. Neither empty value means "off". The **binary** is still yours to install
(`brew install whisper-cpp`); whether it resolves is reported as
`EnvInfo.whisperConfigured`, not as a capability.

It is also the only weight fetched while *indexing* rather than while searching, which is
why Transcribing is the one stage permitted to fail without failing the run: it downloads,
and it runs before the trace graph is built. A failed download costs you a transcript and
says so in the progress label; it does not cost you the session.

## The two image paths are mutually exclusive

They index different vector spaces, and `Retriever` rejects both at once.

- **Nomic Vision** is the cheaper default (~70ms/frame) and the one that gives you
  region highlights searchable by UI role.
- **ColSmol** is seconds per frame and needs keyframes captured at ≥2048px, but
  matches at patch granularity.

## Fakes, and what stays out of the barrel

Every provider has a deterministic **fake** behind the same interface — that seam is
what keeps the test suite offline and deterministic, and it stays open even where
only one local implementation exists. A fake embedder maps identical input to an
identical vector, which lets tests place exact-match items deterministically.

Adapters that load a **native npm module** (`onnxruntime-node`, `uiohook-napi`,
`active-win`, `sharp`) are **deliberately not re-exported from `src/index.ts`** —
import them from their own path — so importing the package never force-loads native
code.

The line is **native module, not subprocess.** Everything that merely spawns a binary
*is* exported and always has been — the ffmpeg producers, the Swift sidecar sources
(`SwiftAxSource`, `SwiftDisplaySource`, `SwiftKeymapSource`) and
`WhisperCppTranscription` — because importing them loads nothing until they run.

## Model listings come from the daemon

`listModels` sources from Ollama's `/api/tags`, never a hardcoded list. Ollama's
*library* now includes cloud-hosted models, and offering one in a "local" picker
would route screenshots off the machine. That is a structural guard, not a style
choice.

Failure policy differs by role, on purpose: `OllamaTextEmbedding.embed` **throws** (a
missing vector must not look like a clean write), while `OllamaCaptionProvider.caption`
returns `""` (a missing caption is recoverable by reconciliation).
