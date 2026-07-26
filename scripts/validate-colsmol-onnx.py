"""
Validate a re-exported ColSmol ONNX against the eager PyTorch model.

Checks three things, in order of importance:
  1. Does it accept a VARIABLE tile count? (the whole point of re-exporting)
  2. Are the vectors numerically faithful to eager PyTorch? A dynamic export that
     silently changes the numbers is worse than no export — vectors would be
     wrong while every score stayed plausible.
  3. How long does one frame take, at the tile count DeskRAG actually produces?

Usage:
    python scripts/validate-colsmol-onnx.py --onnx /path/to/model.onnx
"""

from __future__ import annotations

import argparse
import time

import numpy as np
import onnxruntime as ort
import torch

from colpali_engine.models import ColIdefics3

TILE = 512
TOKENS_PER_TILE = 64
IMAGE_TOKEN_ID = 49190


def make_inputs(n_tiles: int, seed: int = 0):
    g = torch.Generator().manual_seed(seed)
    seq = n_tiles * TOKENS_PER_TILE + 2
    ids = torch.full((1, seq), IMAGE_TOKEN_ID, dtype=torch.long)
    ids[0, 0], ids[0, -1] = 1, 2
    return {
        "input_ids": ids,
        "attention_mask": torch.ones((1, seq), dtype=torch.long),
        "pixel_values": torch.rand((1, n_tiles, 3, TILE, TILE), generator=g),
        "pixel_attention_mask": torch.ones((1, n_tiles, TILE, TILE), dtype=torch.long),
    }


def to_numpy(d):
    return {k: v.numpy() for k, v in d.items()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", required=True)
    ap.add_argument("--model", default="vidore/colSmol-256M")
    ap.add_argument("--skip-parity", action="store_true")
    args = ap.parse_args()

    sess = ort.InferenceSession(args.onnx, providers=["CPUExecutionProvider"])
    print("inputs :", [i.name for i in sess.get_inputs()])
    print("outputs:", [o.name for o in sess.get_outputs()])

    # --- 1. variable tile counts ------------------------------------------------
    print("\n--- dynamic tile count ---")
    results = {}
    for n in (7, 13, 5, 1):
        feeds = to_numpy(make_inputs(n))
        try:
            t0 = time.time()
            out = sess.run(["embeddings"], feeds)[0]
            dt = time.time() - t0
            results[n] = out
            print(f"  tiles={n:3d} -> OK  dims={out.shape}  {dt:.2f}s")
        except Exception as e:
            print(f"  tiles={n:3d} -> FAIL {str(e)[:120]}")

    # --- 2. parity with eager PyTorch -------------------------------------------
    if not args.skip_parity and 7 in results:
        print("\n--- parity vs eager PyTorch (7 tiles) ---")
        from transformers.models.idefics3 import modeling_idefics3 as M
        import importlib.util, pathlib

        spec = importlib.util.spec_from_file_location(
            "export_colsmol", pathlib.Path(__file__).with_name("export-colsmol.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        M.Idefics3Model.get_image_features = mod.patched_get_image_features
        M.Idefics3VisionEmbeddings.forward = mod.patched_vision_embeddings_forward

        model = ColIdefics3.from_pretrained(args.model, dtype=torch.float32, device_map="cpu")
        model.eval()
        inputs = make_inputs(7)
        with torch.no_grad():
            ref = model(**inputs).numpy()
        got = results[7]
        assert ref.shape == got.shape, f"shape mismatch {ref.shape} vs {got.shape}"

        a = ref.reshape(-1, ref.shape[-1])
        b = got.reshape(-1, got.shape[-1])
        cos = (a * b).sum(-1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1) + 1e-12)
        print(f"  max abs diff : {np.abs(ref - got).max():.3e}")
        print(f"  min cosine   : {cos.min():.6f}")
        print(f"  mean cosine  : {cos.mean():.6f}")
        print("  VERDICT:", "faithful" if cos.min() > 0.999 else "DIVERGENT — do not ship")

    # --- 3. steady-state timing at DeskRAG's tile count -------------------------
    if 7 in results:
        print("\n--- steady-state timing (7 tiles, 3 runs) ---")
        feeds = to_numpy(make_inputs(7))
        for i in range(3):
            t0 = time.time()
            sess.run(["embeddings"], feeds)
            print(f"  run {i + 1}: {time.time() - t0:.2f}s")


if __name__ == "__main__":
    main()
