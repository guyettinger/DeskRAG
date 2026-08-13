# Image-lane measurement

> Started 2026-08-13 while implementing `docs/superpowers/plans/2026-08-10-image-model-bakeoff.md`.
> Tasks 1–4 (the ColModernVBERT adapter) are done; the bake-off itself (Tasks 5–7)
> has not run, so this document currently records the CONTRACT, not the comparison.

## ColModernVBERT ONNX contract

Weights: `Qdrant/colmodernvbert` @ `6d54b9924e54e7c0061173d134dec496b15b3842` (MIT),
downloaded by hand into `<models>/colmodernvbert-250m/`. `model.onnx` is
1,012,467,143 bytes; `tokenizer.json` 3,591,055. Every sha256 is pinned in
`app/src/main/models.ts`.

```
$ node scripts/inspect-onnx.mjs <models>/colmodernvbert-250m/model.onnx
INPUTS:
  input_ids
  attention_mask
  pixel_values

OUTPUTS:
  embeddings
```

**Three inputs, not four** — as predicted from `fastembed`'s
`late_interaction_multimodal/colmodernvbert.py`. There is no
`pixel_attention_mask`, because Qdrant's wrapper builds `input_ids` from the
actual patch count instead of masking a padded batch. That is also why this
export needs no re-trace at a fixed tile count, unlike ColSmol.

**The one-tile dummy query IS accepted**, so query latency stays comparable to
ColSmol's:

```
input names: [ 'input_ids', 'attention_mask', 'pixel_values' ]  output names: [ 'embeddings' ]
OK embeddings [ 1, 8, 128 ]     # seq 8, pixel_values [1, 1, 3, 512, 512]
```

fastembed instead allocates `(batch, seq_length, 3, 512, 512)` for text — ~1.4GB
of zeros for a 30-token query. Nothing in the graph requires that; the adapter
feeds one zero tile, and with no `<image>` token in the prompt its vision output
is never merged into the sequence.

**Preprocessing is byte-identical to ColSmol's on every field `TileConfig`
reads** — confirmed against the downloaded `preprocessor_config.json` /
`config.json`, not assumed: `Idefics3ImageProcessor`, `size.longest_edge` 2048,
`max_image_size.longest_edge` 512, `patch_size` 16, `pixel_shuffle_factor` 4,
mean/std 0.5, `image_seq_len` 64, `projection_dim` 128. So
`src/embed/onnx/geometry.ts` and `src/embed/onnx/colsmol-tiler.ts` are reused
verbatim, and the ≥2048px capture rule applies here identically.

## Measured token ids

`node scripts/dump-colmodernvbert-tokens.mjs <models>/colmodernvbert-250m`, which
also encodes the exact prompt string `colmodernvbert.py` builds:

```
<|begin_of_text|>            [50281,29,93,2043,64,1171,64,1156,49651,50282]
<fake_token_around_image>    [50281,50406,50282]
<global-img>                 [50281,50368,50282]
<image>                      [50281,50407,50282]
<end_of_utterance>           [50281,50405,50282]
[CLS]                        [50281,50281,50282]
[SEP]                        [50281,50282,50282]

<row_1_col_1>                [50281,50369,50282]     <row_2_col_1> [50281,50375,50282]  -> ROW_STRIDE 6

"<|begin_of_text|>User:"     [50281,29,93,2043,64,1171,64,1156,49651,6989,27,50282]
"Describe the image."        [50281,4476,19268,253,2460,15,50282]
"\nAssistant:"               [50281,187,6717,5567,27,50282]
"\n"                         [50281,187,50282]
"\n\n"                       [50281,535,50282]

full image prompt, 4x3 grid:  length 884, image tokens 832
  head 12: [50281,29,93,2043,64,1171,64,1156,49651,6989,27,50406]
  tail after last <image>: [50406,4476,19268,253,2460,15,50405,187,6717,5567,27,50282]
full query prompt:
  [50281,66,8351,4645,247,1973,2228,50405 x10,50282]
```

**Three things diverge from ColSmol, and the plan assumed none of them.** Each
would have produced a plausible-but-wrong sequence — the failure mode the prompt
module exists to prevent:

1. **A `TemplateProcessing` post-processor wraps every encode in `[CLS]` … `[SEP]`**
   (50281 / 50282). ColSmol's tokenizer has none. The consequence for queries is
   larger than for images: fastembed augments the query STRING with ten
   `<end_of_utterance>` and *then* encodes, so the buffer lands INSIDE the
   wrapper. Appending it to the tokenizer's output — the obvious reading, and
   what the plan's code did — would put ten buffer tokens after the `[SEP]`.
2. **`<|begin_of_text|>` is not in this vocab.** It is ModernBERT, not SmolLM2, so
   the prefix survives as ordinary byte-level BPE: ten tokens
   (`[29,93,2043,64,1171,64,1156,49651,6989,27]`), not one `imStart`.
3. **The last row's `"\n"` abuts the global block's leading `"\n"`**, so BPE merges
   them into ONE token (535), exactly the trap `colsmol-prompt.ts` records as
   `doubleNewline`. Emitting 187 twice gives 885 tokens where the real encoding
   is 884 — a one-token shift through the whole tail.

The full 884/832 counts and the complete tail are asserted in
`test/onnx.colmodernvbert-prompt.test.ts`, and
`test/onnx.smoke.test.ts` re-encodes fastembed's string with the real tokenizer
and compares it to `buildImagePrompt` element by element, which is what will
catch drift if the export is ever re-published.

## Real-weights behaviour

<!-- filled in by Task 4 -->

## Bake-off results

<!-- Tasks 5-7 have not run. -->
