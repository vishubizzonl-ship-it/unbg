"""BiRefNet — the production workhorse for both people and products.

The official MIT checkpoints (ZhengPeng7/BiRefNet, CAAI AIR 2024) ship as ONNX straight
from the author's GitHub release, so nothing here depends on a third-party conversion:

  * general    — products, objects, animals, anything (1024x1024)
  * portrait   — people, hair, skin, glasses (1024x1024)
  * matting    — trimap-free matting, the best soft-alpha output (1024x1024)
  * lite       — swin-v1-tiny, 224 MB, 1024x1024 (CPU-friendly)
  * lite-2k    — 2560x1440 input, 331 MB (detail on large photos, low memory)
  * HR         — 2048x2048, 1.1 GB (the highest-resolution general model)
  * 512        — onnx-community fp16 export, 473 MB (low-RAM machines)

Input: 3xHxW RGB, ImageNet normalisation (mean .485/.456/.406, std .229/.224/.225),
exactly as the author's `transform_image` does it. Output: 1x1xHxW logits -> sigmoid.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ..config import settings
from ._ort import Session
from .base import Engine, EngineInfo

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class BiRefNetEngine(Engine):
    def __init__(self, info: EngineInfo, repo: str, *, variant: str = "model.onnx") -> None:
        super().__init__()
        self.info = info
        self.repo = repo
        self.variant = variant
        self._session: Session | None = None

    # -- paths -----------------------------------------------------------
    def path(self) -> Path:
        # UNBG_ONNX_VARIANT=model_fp16.onnx halves the footprint where the runtime
        # supports fp16 (some GPU builds) — fp32 stays the default for CPU.
        import os

        variant = os.environ.get("UNBG_ONNX_VARIANT") or self.variant
        return settings.model_dir / self.info.id / "onnx" / variant

    def available(self) -> bool:
        return self.path().exists()

    def load(self) -> None:
        if self._session is None:
            self._session = Session(
                self.path(), use_gpu=settings.use_gpu, threads=settings.intra_threads
            )
        self._loaded = True

    def tile_size(self, input_size: int) -> int:
        fixed = self._session.static_size if self._session else None
        return int(max(fixed)) if fixed else super().tile_size(input_size)

    def preprocessing_size(self, width: int, height: int, input_size: int) -> tuple[int, int]:
        """These exports are fixed-size (1024x1024), so that is what we feed it."""
        fixed = self._session.static_size if self._session else None
        if fixed:
            return fixed
        return super().preprocessing_size(width, height, input_size)

    @property
    def runtime(self) -> dict:
        if self._session is None:
            return {}
        return {"providers": self._session.providers, "file": self._session.path.name}

    # -- inference -------------------------------------------------------
    def _infer(self, rgb: np.ndarray) -> np.ndarray:
        assert self._session is not None, "call load() first"
        height, width = rgb.shape[:2]
        tensor = (rgb - MEAN) / STD
        if self._session.layout() == "nhwc":
            batch = tensor[None].astype(np.float32)
        else:
            batch = np.transpose(tensor, (2, 0, 1))[None].astype(np.float32)

        out = self._session.run(batch)
        # BiRefNet returns logits; some exports already apply sigmoid.
        if out.ndim == 4:
            out = out[0, 0]
        elif out.ndim == 3:
            out = out[0]
        if out.min() < -0.01 or out.max() > 1.01:
            out = 1.0 / (1.0 + np.exp(-np.clip(out, -30.0, 30.0)))
        return np.clip(out.astype(np.float32), 0.0, 1.0)


GENERAL = EngineInfo(
    id="birefnet-general",
    label="BiRefNet General",
    family="BiRefNet",
    license="MIT",
    size_mb=972,
    best_for="products, objects, animals, mixed scenes",
    notes="Highest quality default. 972 MB fp32, ~489 MB fp16 on GPU.",
    files=("onnx/model.onnx",),
)

PORTRAIT = EngineInfo(
    id="birefnet-portrait",
    label="BiRefNet Portrait",
    family="BiRefNet",
    license="MIT",
    size_mb=972,
    best_for="people, hair, skin, glasses",
    notes="Portrait-tuned checkpoint; best on selfies and full-body shots.",
    files=("onnx/model.onnx",),
)

B512 = EngineInfo(
    id="birefnet-512",
    label="BiRefNet 512 (fp16)",
    family="BiRefNet",
    license="MIT",
    size_mb=473,
    best_for="full BiRefNet quality on low-RAM machines",
    notes="Same weights, exported for 512x512 input in fp16 — ~half the RAM of the 1024 build.",
    files=("onnx/model_fp16.onnx",),
)

MATTING = EngineInfo(
    id="birefnet-matting",
    label="BiRefNet Matting",
    family="BiRefNet",
    license="MIT",
    size_mb=972,
    best_for="hair, fur, veils, glass — soft alpha edges",
    notes="Trimap-free matting checkpoint; softest, most honest alpha of the family.",
    files=("onnx/model.onnx",),
)

LITE2K = EngineInfo(
    id="birefnet-lite-2k",
    label="BiRefNet Lite 2K",
    family="BiRefNet",
    license="MIT",
    size_mb=331,
    best_for="big photos with fine detail on a small budget",
    notes="2560x1440 input at 331 MB — more edge detail than the 1024 lite, less RAM than HR.",
    files=("onnx/model.onnx",),
)

HR = EngineInfo(
    id="birefnet-hr",
    label="BiRefNet HR (2048)",
    family="BiRefNet",
    license="MIT",
    size_mb=1099,
    best_for="2K+ photos, print, product macro",
    notes="Trained at 2048x2048 — the sharpest general model; needs ~4 GB+ of RAM.",
    files=("onnx/model.onnx",),
)

LITE = EngineInfo(
    id="birefnet-lite",
    label="BiRefNet Lite",
    family="BiRefNet",
    license="MIT",
    size_mb=224,
    best_for="fast CPU runs, thumbnails, batch jobs",
    notes="4x smaller and much faster; slightly softer edges than full BiRefNet.",
    files=("onnx/model.onnx",),
)
