"""
Re-export vidore/colSmol-256M to ONNX with a DYNAMIC tile count.

Why this exists: the community export (onnx-community/colSmol-256M-ONNX) is
traced at exactly 13 tiles and rejects any other count. DeskRAG frames are 16:10,
which tile to 7 (3x2 + global), so that export cannot process them at all.

Two places in Idefics3 use data-dependent shapes and are what bake the tile count
into a trace. Both are replaced here with shape-static equivalents:

  1. Idefics3Model.get_image_features filters "padding" tiles with boolean-mask
     indexing (`pixel_values[real_images_inds]`). The result's size depends on the
     data, so tracing freezes it. We drop the filter outright — DeskRAG only ever
     passes real tiles, which is the documented precondition of this export.

  2. Idefics3VisionEmbeddings.forward does a masked assignment
     (`position_ids[mask] = pos_ids[mask]`). Replaced with torch.where, which is
     numerically identical (masked-out positions keep the 0 fill) but static.

Usage:
    python scripts/export-colsmol.py --out /path/to/model.onnx [--tiles 7]

Requires torch, transformers, colpali-engine, onnx in the active environment.
The export is CPU/fp32 and takes several minutes.
"""

from __future__ import annotations

import argparse
import torch

from colpali_engine.models import ColIdefics3
from transformers.models.idefics3 import modeling_idefics3 as M

TILE = 512
TOKENS_PER_TILE = 64
IMAGE_TOKEN_ID = 49190


def patched_get_image_features(self, pixel_values, pixel_attention_mask=None, **kwargs):
    """get_image_features without the data-dependent padding-tile filter."""
    pixel_values = pixel_values.to(dtype=self.dtype)
    # reshape(-1, ...) rather than view(batch * num_images, ...): the computed
    # product is a traced value, and ONNX shape inference cannot resolve the
    # resulting Reshape. -1 keeps the axis genuinely dynamic.
    # Tile dimensions are fixed by the vision config; only the tile COUNT varies.
    side = self.config.vision_config.image_size
    channels = self.config.vision_config.num_channels
    pixel_values = pixel_values.reshape(-1, channels, side, side)

    if pixel_attention_mask is None:
        pixel_attention_mask = torch.ones(
            (pixel_values.size(0), side, side),
            dtype=torch.bool,
            device=pixel_values.device,
        )
    else:
        pixel_attention_mask = pixel_attention_mask.reshape(-1, side, side)

    # The original uses two `unfold` calls to build the per-patch mask. ONNX
    # cannot export Unfold once the leading dim is dynamic ("input size not
    # accessible"), so do the same thing with a reshape: split H and W into
    # (n_patches, patch_size) and reduce over the within-patch axes. Tile height
    # and width are fixed by the vision config, so these stay static.
    patch_size = self.config.vision_config.patch_size
    side = self.config.vision_config.image_size
    n_patch = side // patch_size
    grid = pixel_attention_mask.reshape(-1, n_patch, patch_size, n_patch, patch_size)
    patch_attention_mask = (grid.sum(dim=(2, 4)) > 0).bool()

    # transformers 5.x already carries return_dict in kwargs; passing it
    # explicitly as well raises "multiple values for keyword argument".
    kwargs.pop("return_dict", None)
    outputs = self.vision_model(
        pixel_values=pixel_values,
        patch_attention_mask=patch_attention_mask,
        return_dict=True,
        **kwargs,
    )
    outputs.pooler_output = self.connector(outputs.last_hidden_state)
    return outputs


def patched_vision_embeddings_forward(self, pixel_values, patch_attention_mask):
    """Vision embeddings with torch.where instead of masked assignment."""
    batch_size, _, max_im_h, max_im_w = pixel_values.shape
    patch_embeds = self.patch_embedding(pixel_values)
    embeddings = patch_embeds.flatten(2).transpose(1, 2)

    boundaries = torch.arange(
        1 / self.num_patches_per_side,
        1.0,
        1 / self.num_patches_per_side,
        device=pixel_values.device,
    )
    nb_h = patch_attention_mask[:, :, 0].sum(dim=1)
    nb_w = patch_attention_mask[:, 0, :].sum(dim=1)
    step_h, step_w = 1.0 / nb_h, 1.0 / nb_w

    h_idx = torch.arange(
        patch_attention_mask.size(1), device=pixel_values.device, dtype=torch.float32
    )
    w_idx = torch.arange(
        patch_attention_mask.size(2), device=pixel_values.device, dtype=torch.float32
    )
    fch = torch.clamp(h_idx[None, :] * step_h[:, None], max=1.0 - 1e-6).to(pixel_values.dtype)
    fcw = torch.clamp(w_idx[None, :] * step_w[:, None], max=1.0 - 1e-6).to(pixel_values.dtype)

    bh = torch.bucketize(fch, boundaries, right=True)
    bw = torch.bucketize(fcw, boundaries, right=True)
    pos_ids = (bh[:, :, None] * self.num_patches_per_side + bw[:, None, :]).reshape(
        batch_size, -1
    )

    mask = patch_attention_mask.view(batch_size, -1)
    position_ids = torch.where(mask, pos_ids, torch.zeros_like(pos_ids))
    return embeddings + self.position_embedding(position_ids)


class ExportWrapper(torch.nn.Module):
    """Fixes the signature to the four inputs the TS adapter feeds."""

    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask, pixel_values, pixel_attention_mask):
        return self.model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            pixel_values=pixel_values,
            pixel_attention_mask=pixel_attention_mask,
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="vidore/colSmol-256M")
    ap.add_argument("--tiles", type=int, default=7, help="tile count to trace with")
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    M.Idefics3Model.get_image_features = patched_get_image_features
    M.Idefics3VisionEmbeddings.forward = patched_vision_embeddings_forward
    print("patched: get_image_features, Idefics3VisionEmbeddings.forward")

    model = ColIdefics3.from_pretrained(args.model, dtype=torch.float32, device_map="cpu")
    model.eval()
    print(f"loaded {args.model}: dim={getattr(model, 'dim', '?')}")

    n = args.tiles
    seq = n * TOKENS_PER_TILE + 2
    ids = torch.full((1, seq), IMAGE_TOKEN_ID, dtype=torch.long)
    ids[0, 0], ids[0, -1] = 1, 2
    example = (
        ids,
        torch.ones((1, seq), dtype=torch.long),
        torch.rand((1, n, 3, TILE, TILE), dtype=torch.float32),
        torch.ones((1, n, TILE, TILE), dtype=torch.long),
    )

    with torch.no_grad():
        ref = ExportWrapper(model)(*example)
    print(f"eager forward OK: {tuple(ref.shape)}")

    torch.onnx.export(
        ExportWrapper(model),
        example,
        args.out,
        input_names=["input_ids", "attention_mask", "pixel_values", "pixel_attention_mask"],
        output_names=["embeddings"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "pixel_values": {0: "batch", 1: "tiles"},
            "pixel_attention_mask": {0: "batch", 1: "tiles"},
            "embeddings": {0: "batch", 1: "seq"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
        dynamo=False,
    )
    print(f"exported -> {args.out}")


if __name__ == "__main__":
    main()
