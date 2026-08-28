# Providers

Every provider runs on this machine. There is no remote option — not a disabled one,
not a key field left blank. Adapters either talk to a daemon on localhost, run the
model in-process, or spawn a subprocess. **A network call to a third party is a
regression, not a feature to add.**

| Role | Provider | Model |
|---|---|---|
| Text embedding | Ollama (daemon) | `nomic-embed-text` |
| Text embedding | ONNX (in-process) | `nomic-embed-text-v1.5` (int8) |
| Image | ONNX (in-process) | `colmodernvbert-250m` — late interaction; patches *are* the regions, so highlights fall out of the MaxSim map |
| Behavioral vector | builtin | `input-dynamics-v1`, 12-dim |
| VLM caption | Ollama (daemon) | any vision model you've pulled, e.g. `qwen3-vl:4b` |
| Transcription (STT) | whisper.cpp (subprocess) | `ggml-base.en-q5_1.bin`, downloaded like any other weight — it reads **both** audio sources, microphone and computer |
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

## There is one image model, or none

The menu used to have four entries — `none`, `nomic` (single-vector),
`colsmol` and `colmodernvbert`. The bake-off that produced it is over:
ColModernVBERT won, and keeping the losers cost two model adapters, a 953MB
download entry, an export toolchain, and a whole single-vector retrieval lane.
All of it is gone, along with `frame_image` and `region_image` as views.

- **ColModernVBERT** is late interaction, so ONE model embeds images and text
  into ONE space — which is what lets a typed query reach frames directly, and
  what the single-vector path never could. It costs seconds per frame and needs
  keyframes captured at **≥2048px**: below that its Idefics3 preprocessor
  upscales and patch vectors drift with scores still looking sane.
- **None** is the default, and it is the whole of what optionality buys once
  there is one model worth running. Search still answers from text and behavior,
  and Tier 3's AX-label FTS still puts highlights on the result.

Nothing was lost by removing the single-vector lane on a ColModernVBERT install.
Region rows, bboxes, AX role/label and `region_fts` all survive — the Regions
stage is ungated and runs proposal-only, so Tier 3's FTS half, the digest's
"label of what was clicked", `Anchor.visual` in the trace graph and the rail's
region counts are untouched. On the late-interaction path Tier 3 was *already*
deliberately FTS-only.

**A persisted `nomic` or `colsmol` migrates to `colmodernvbert` and needs a
re-index.** Its frames are indexed in a vector space nothing can query, so
`DualStore` drops those Lance tables on open and Settings says so.

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

### Getting a daemon and its weights

```bash
brew install --cask ollama-app   # a CASK, not a formula; links `ollama` and installs the app
ollama serve                     # or open /Applications/Ollama.app to keep it running at login
ollama pull nomic-embed-text     # 274 MB — text embedding
ollama pull qwen3-vl:4b          # 3.3 GB — VLM captions
```

Because the picker reads `/api/tags`, **a freshly installed daemon offers an empty
vision-model list** — `ollama.visionModels()` returns `[]` until something is
pulled, which looks identical to a daemon that isn't running. Check with
`curl -s localhost:11434/api/tags` before assuming the connection is at fault.

Neither model is required. Without them Ollama's roles stay unavailable and the
ONNX providers, capture, indexing, lexical search and Flows are all unaffected.
