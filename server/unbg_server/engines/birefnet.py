"""BiRefNet — the production workhorse for both people and products.

Two checkpoints of the same architecture:
  * general  (onnx-community/BiRefNet-ONNX)          — products, objects, animals, anything
  * portrait (onnx-community/BiRefNet-portrait-ONNX) — people, hair, skin, glasses

Both are MIT on the Hub, converted by onnx-community from ZhengPeng7's original weights.
Input: 3xHxW RGB, ImageNet normalisation, H/W divisible by 32.
Output: 1x1xHxW logits -> sigmoid -> alpha.
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
