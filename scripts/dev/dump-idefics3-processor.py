"""
Dump exactly what the reference Idefics3 processor produces for a DeskRAG-shaped
frame. This is what generated the MEASURED table in test/onnx.geometry.test.ts,
and the ability to regenerate it is what keeps that table honest.

This is ground truth for the TypeScript adapter. The prompt is not decorative:
ColPali-family models embed image patches as placeholder tokens inside a
templated text sequence, and feeding a differently-shaped prompt yields vectors
that are plausible but wrong — scores stay in a believable range while retrieval
quietly degrades. Replicating this byte-for-byte is the only safe path.

Usage:
    python scripts/dump-idefics3-processor.py [--width 1280] [--height 800]
"""

from __future__ import annotations

import argparse
import json

import torch
from PIL import Image

from colpali_engine.models import ColModernVBertProcessor

# ColModernVBERT's <image> placeholder. ColSmol's was 49190; the processors share
# the Idefics3 IMAGE GEOMETRY (2048 / 512 / patch 16 / shuffle 4 -> 64 tokens per
# tile) but not the tokenizer, so this id is model-specific.
IMAGE_TOKEN_ID = 50283


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="ModernVBERT/colmodernvbert")
    ap.add_argument("--image-token-id", type=int, default=IMAGE_TOKEN_ID)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--query", default="a login form")
    args = ap.parse_args()

    proc = ColModernVBertProcessor.from_pretrained(args.model)

    # A non-uniform image: an all-flat one can be treated as padding.
    img = Image.effect_mandelbrot((args.width, args.height), (-3, -2.5, 2, 2.5), 20).convert("RGB")

    batch = proc.process_images([img])
    ids = batch["input_ids"][0]
    n_img = int((ids == args.image_token_id).sum())

    print("=== IMAGE BRANCH ===")
    print("keys           :", sorted(batch.keys()))
    for k, v in batch.items():
        if isinstance(v, torch.Tensor):
            print(f"  {k:22} {tuple(v.shape)} {v.dtype}")
    print("seq len        :", len(ids))
    print("image tokens   :", n_img)
    print("tiles implied  :", n_img / 64)
    print("\n--- decoded prompt (image placeholders collapsed) ---")
    text = proc.tokenizer.decode(ids)
    collapsed = text.replace("<image>" * 64, "<image>*64")
    print(collapsed[:1200])

    print("\n--- token id runs (first 40) ---")
    runs, prev, count = [], None, 0
    for t in ids.tolist():
        if t == prev:
            count += 1
        else:
            if prev is not None:
                runs.append((prev, count, proc.tokenizer.decode([prev])))
            prev, count = t, 1
    runs.append((prev, count, proc.tokenizer.decode([prev])))
    for tid, n, s in runs[:40]:
        print(f"  id={tid:6} x{n:4}  {s!r}")

    print("\n=== QUERY BRANCH ===")
    qb = proc.process_queries([args.query])
    qids = qb["input_ids"][0]
    print("keys           :", sorted(qb.keys()))
    for k, v in qb.items():
        if isinstance(v, torch.Tensor):
            print(f"  {k:22} {tuple(v.shape)} {v.dtype}")
    print("decoded        :", repr(proc.tokenizer.decode(qids))[:400])

    out = {
        "image_seq_len": len(ids),
        "image_tokens": n_img,
        "pixel_values_shape": list(batch["pixel_values"].shape),
        "query_seq_len": len(qids),
        "query_decoded": proc.tokenizer.decode(qids),
    }
    print("\nJSON:", json.dumps(out))


if __name__ == "__main__":
    main()
