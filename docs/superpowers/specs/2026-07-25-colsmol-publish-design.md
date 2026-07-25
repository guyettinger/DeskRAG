# Publishing the dynamic ColSmol export — ending the per-machine build

**Date:** 2026-07-25
**Status:** Design approved, pending spec review

## Context

Turning on local image search (`imageProvider: "colsmol"`) fails at index time:

```
ModelNotBuiltError: Model "colSmol-256M-dynamic" is not built.
Missing in .../DeskRAG/models/colSmol-256M-dynamic:
  model.onnx, tokenizer.json, tokenizer_config.json, preprocessor_config.json, config.json
```

`MODELS.colsmol` is the only `source: "local"` entry in the manifest. Instead of
being downloaded, it is expected to be produced **on each user's machine** by
`scripts/export-colsmol.py`, following prose instructions carried in
`ModelSpec.setupHint`: install torch/transformers/colpali-engine/onnx with pip,
run the export, then hand-copy four JSON files out of two different HuggingFace
repos.

That design exists for a real reason — the published export
(`onnx-community/colSmol-256M-ONNX`) is traced at exactly 13 tiles, and DeskRAG's
16:10 frames tile to 7, so it cannot process them at all. A dynamic-tile export
is genuinely required. But requiring **every user** to produce it is the wrong
conclusion, for four reasons:

1. **It costs each user ~3 GB of Python wheels and a torch toolchain** to produce
   a file that is bit-identical for everyone. The export is deterministic; there
   is nothing machine-specific about it.
2. **The instructions never reach the user.** `deskrag-service.ts:410` sends only
   `err.message.split("\n")[0]` over the indexing channel, so the pip/python
   lines are dropped. The `<modelsDir>` placeholder in the hint is never
   substituted with a real path either. The guidance only ever appeared in a
   terminal.
3. **It had never actually worked.** Before this design, no `model.onnx` existed
   anywhere on the development machine, and neither installed Python could
   import torch. The documented path had not been executed end to end.
4. **Licensing permits redistribution.** `vidore/colSmol-256M` is MIT on the
   adapters over an Apache-2.0 backbone. `onnx-community/colSmol-256M-ONNX` is
   already a redistributed ONNX export of this exact model under MIT — the same
   act this design proposes, with direct precedent.

**The reframe: the export is a build artifact, not user setup.** The repo already
has a mechanism for build artifacts fetched by pinned commit SHA and verified
against SHA-256 — it is how `MODELS.text` and `MODELS.reranker` work. ColSmol
should use it, and stop being a special case.

## The artifact already exists and is validated

Built during design, so the numbers below are measured, not projected.

Environment, via `uv` (Homebrew, 0.11.32) — no venv, no conda, and notably
**not** the machine's anaconda Python, whose numpy is broken:

| package | version |
|---|---|
| torch | 2.11.0 |
| transformers | 5.14.1 |
| onnx | 1.22.0 |
| colpali-engine | 0.3.17 |

The script's two monkeypatches (`Idefics3Model.get_image_features`,
`Idefics3VisionEmbeddings.forward`) survive transformers 5.x intact — both
targets still exist with matching signatures, and the upstream source still uses
the `unfold` / `view(` / `nb_values_per_image` constructs the patches replace.
The export took **28 seconds**, not the "several minutes" the docstring warns of.

`scripts/validate-colsmol-onnx.py` passes on every check:

| tiles | output dims | expected (`n*64+2`) | time |
|---|---|---|---|
| 7 | (1, 450, 128) | 450 | 5.14s |
| 13 | (1, 834, 128) | 834 | 9.61s |
| 5 | (1, 322, 128) | 322 | 3.60s |
| 1 | (1, 66, 128) | 66 | 0.72s |

Parity vs eager PyTorch at 7 tiles: max abs diff **5.119e-06**, min cosine
**1.000000**, verdict **faithful**. Steady-state ~5.0s per frame at 7 tiles on CPU.

Measured file identities, which become the manifest pins:

| file | sha256 | bytes |
|---|---|---|
| `model.onnx` | `cf13ca0c6951a4607c303dbe15fd9c8161289ff624f8582ce539cca2ccd99084` | 953,919,521 |
| `tokenizer.json` | `77eaa5071d562289dbd9c18f8a998124d899a4a0a4311b1a4b6964a873d306b8` | 3,548,416 |
| `tokenizer_config.json` | `e5bc53ee738178fca59eac1df6dc821576d1082ffedb7b8f8dfe97ceab43eb92` | 28,274 |
| `preprocessor_config.json` | `6b8e11369a62e97e3b2f37a0dd1440b9018d177f7ecd2cfc2492e316b930a78a` | 489 |
| `config.json` | `e68e589bbc081d258f585d32ff90d41f0eededdddd5d5d38f006d80ff7de0c0d` | 7,268 |

These are properties of the bytes, so they remain valid after upload.

## Design

### 1. Publish a self-contained repo

Upload all five files to **`guyettinger/colSmol-256M-dynamic-onnx`**.

Self-contained rather than model-only: the tokenizer and preprocessor configs
were traced against these weights, and leaving them in two upstream repos on
independent revisions is a live drift hazard — an upstream retokenization would
silently desynchronize them from the weights. Bundling companion configs with a
converted model is also what `onnx-community` itself does. The cost is
re-hosting ~3.6 MB of MIT-licensed JSON.

The model card must document provenance (`vidore/colSmol-256M`), the dynamic-tile
rationale, the exact package versions used, and MIT/Apache-2.0 attribution.

### 2. `MODELS.colsmol` becomes an ordinary download

```ts
colsmol: {
  id: "colSmol-256M-dynamic",          // UNCHANGED
  source: "download",
  repo: "guyettinger/colSmol-256M-dynamic-onnx",
  revision: "<commit SHA after upload>",
  files: [ /* the five files above, with sha256 + bytes */ ],
},
```

**`id` must not change.** It is part of the vector namespace
(`view:provider:model:dimensions`), so renaming it would orphan any Lance table
built under it. Nothing has been indexed with ColSmol yet — it has never worked —
so keeping it stable is free now and cheap insurance later.

`revision` is the only value not yet known; it is the upload commit SHA. Per the
manifest's existing rule, it is a commit SHA and never `main`.

### 3. `ModelStore` must stream to disk

`ensureOnce` currently does `Buffer.from(await res.arrayBuffer())`
(`model-store.ts:136`), buffering each file wholly in memory before writing.
That is fine for today's 137 MB and 38 MB models. For a **954 MB** file it means
a ~1 GB allocation plus a transient copy inside the Electron **main** process —
a memory spike in the one process that must not fall over.

Replace it with a `res.body` reader that pipes into the `.partial` write stream
while updating the SHA-256 hash incrementally, then verifies the digest before
`renameSync`. The surrounding discipline is unchanged: `.partial` → verify →
atomic rename; on mismatch, delete and throw with no fallback to unverified
bytes.

Second payoff: progress is currently emitted per *file*, so one 954 MB download
would report 0% and then 100%. Streaming makes `receivedBytes` genuinely
incremental, which is what the Settings progress row (`SettingsScreen.tsx:170`)
already renders.

This is required by the size of the artifact this design introduces, so it
belongs here rather than in a follow-up — shipping a manifest that points at a
file which may exhaust main-process memory would not be finishable work.

### 4. Delete the stranded local-build mechanism

ColSmol was the only `source: "local"` entry, so publishing it strands:

- the `source === "local"` branch in `ensureOnce` (`model-store.ts:96-109`)
- `ModelNotBuiltError` (`model-store.ts:38-50`)
- `ModelSpec.setupHint` and the `"local"` arm of the `source` union
- the `instanceof ModelNotBuiltError` special-case in `deskrag-service.ts:410-411`
  (and its import at `:56`)
- three local-source cases in `app/test/model-store.test.ts:123-160` — "throws an
  actionable error naming the missing files and the command", "lists only the
  files that are actually absent", "returns the directory once every file is
  present"

All removed. The file header comments in `models.ts` and `model-store.ts`
describing the two-kinds-of-entry policy are rewritten to match.

**One piece is kept, retargeted.** Under `overrideDir` — the air-gapped escape
hatch — `ensureOnce` returns the directory without checking anything, so a
mis-pointed `localModels.dir` surfaces later as a raw ENOENT from inside ONNX.
A presence check there, throwing a renamed `ModelFilesMissingError` listing what
is absent, preserves the one diagnostic that still has a job. Same handful of
lines, pointed at the path that still needs them.

### 5. Keep the export reproducible

`scripts/export-colsmol.py` remains a **maintainer** tool — nothing in the app
invokes it. Make its environment self-describing with PEP 723 inline metadata,
replacing the prose that lived in the deleted `setupHint`:

```python
# /// script
# requires-python = "==3.12.*"
# dependencies = [
#   "torch==2.11.0", "transformers==5.14.1",
#   "colpali-engine==0.3.17", "onnx==1.22.0",
# ]
# ///
```

Then regenerating is one command — `uv run scripts/export-colsmol.py --out …` —
which provisions its own CPython 3.12 and the pinned deps. The docstring's usage
line is updated to match. Pinning matters because the monkeypatches target
version-sensitive `transformers` internals; these are the versions proven above.

`.gitignore` gains `__pycache__/` and `*.pyc`, following the existing convention
of a comment naming the producer. `scripts/__pycache__/` is currently untracked
but not ignored, and shows up in `git status`.

## Error handling

- **Checksum mismatch** — unchanged: delete the `.partial` and throw. Never fall
  back to unverified weights; wrong weights produce vectors that are silently
  wrong inside a table claiming otherwise.
- **Interrupted download** — the `.partial`/rename discipline means a partial
  file never looks complete; the next `ensure()` re-fetches. Streaming does not
  weaken this, since the rename still happens only after full-digest verification.
- **Download failure during indexing** — falls to the existing generic
  `"Indexing failed — see logs"` path once the `ModelNotBuiltError` special-case
  is gone. A failed download is an ordinary transient error, unlike the
  actionable setup state it replaces.
- **Concurrent callers** — unchanged. `ensure()` de-dupes via the `inflight` map,
  which matters more now: two 954 MB downloads racing on one `.partial` is the
  exact hazard it was written for.

## Testing

`app/test/model-store.test.ts` keeps its real-`node:http` fixture-server pattern
rather than mocking fetch. Changes:

- **Add:** a streaming case asserting `receivedBytes` climbs across multiple
  progress events for one file, rather than jumping 0 → total.
- **Add:** a mid-stream abort leaving no `.partial` behind.
- **Add:** `ModelFilesMissingError` raised for an `overrideDir` missing files.
- **Remove:** the three local-source cases and the assertion that the message
  contains `"export-colsmol.py"`.
- **Keep:** checksum-mismatch, no-redownload, shared-promise, and pinned-revision
  URL construction — all still load-bearing.

Gates: `npm run typecheck`, `npm test`, `npm --prefix app run typecheck`,
`npm --prefix app run test`. `src/` is untouched, so the library suite should be
unaffected — a change there would indicate the seam was crossed by mistake.

End-to-end: delete the local `colSmol-256M-dynamic/` directory, launch the app,
and confirm it downloads with visible incremental progress; then record a short
session with `imageProvider: "colsmol"` and confirm indexing completes.
`node scripts/e2e-local.mjs <modelsDir>` exercises the full pipeline against the
real weights.

## Consequences and trade-offs

**Net code reduction.** This removes a manifest entry kind, an error class, a
`ModelStore` branch, a service-layer special case, and three tests, while adding
a streaming read and one retargeted check.

**It makes the maintainer the distributor.** Regenerating the export — for a new
transformers release, or a fix to the monkeypatches — means uploading a new
revision and shipping a manifest update, rather than users rebuilding locally.
Given the export had never successfully run on any user machine, this trades a
theoretical capability for one that works.

**Air-gapped installs are still supported** through the existing
`localModels.dir` override, now with a real error when the directory is
incomplete instead of a deep ENOENT.

## Out of scope

- An in-app "build model" button, a `ModelBuilder`, or bootstrapping a Python
  toolchain at runtime. Publishing removes the need entirely.
- Shipping `export-colsmol.py` in the packaged app via `extraResources`. It is a
  maintainer tool.
- Quantizing the export. 954 MB fp32 is what was validated; an int8 variant is a
  separate design with its own parity budget.
- Changing `export-colsmol.py`'s monkeypatches. They are correct as written and
  proven against transformers 5.14.1.
