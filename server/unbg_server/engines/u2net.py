"""U²-Net — the optional lightweight fallback (U²-Net / U²-Net-p, ~4.7 MB / 176 MB).

Deliberately engine-agnostic: drop any U²-Net ONNX file at
`models/u2net/u2net.onnx` and it is used. That keeps us off sketchy re-uploads —
the file can come from the official `xuebinqin/U-2-Net` weights via rembg's
`u2net.onnx` release, or from your own export.

Why it exists: BiRefNet needs ~1 GB of RAM per pass. On a phone, a 2 GB VPS, or when
you need 30 images/minute, U²-Net-p is the difference between "runs" and "OOM".
Quality is lower than BiRefNet — it is a fallback, not a rival.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ..config import settings
from ._ort import Session
from .base import Engine, EngineInfo

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class U2NetEngine(Engine):
    def __init__(self, info: EngineInfo, folder: str = "u2net") -> None:
        super().__init__()
        self.info = info
        self.folder = folder
        self._session: Session | None = None
        self._size: tuple[int, int] | None = None

    def path(self) -> Path:
        """models/u2net/u2net.onnx, or the first *.onnx in that folder."""
        folder = settings.model_dir / self.folder
        exact = folder / f"{self.folder}.onnx"
        if exact.exists():
            return exact
        if folder.is_dir():
            candidates = sorted(folder.glob("*.onnx"))
            if candidates:
                return candidates[0]
        return exact

    def available(self) -> bool:
        return self.path().exists()

    def load(self) -> None:
        if self._session is None:
            self._session = Session(
                self.path(), use_gpu=settings.use_gpu, threads=settings.intra_threads
            )
            shape = self._session.input.shape
            height = shape[2] if isinstance(shape[2], int) else 320
            width = shape[3] if isinstance(shape[3], int) else 320
            self._size = (int(width), int(height))
        self._loaded = True

    @property
    def runtime(self) -> dict:
        if self._session is None:
            return {}
        return {
            "providers": self._session.providers,
            "file": self._session.path.name,
            "input": list(self._session.input.shape),
        }

    def preprocessing_size(self, width: int, height: int, input_size: int) -> tuple[int, int]:
        """U²-Net is fixed-size (320 or 512); resize once, not twice."""
        if self._size:
            return (self._size[0], self._size[1])
        return super().preprocessing_size(width, height, input_size)

    def tile_size(self, input_size: int) -> int:
        return self._size[0] if self._size else super().tile_size(input_size)

    def _infer(self, rgb: np.ndarray) -> np.ndarray:
        assert self._session is not None and self._size is not None
        from PIL import Image

        height, width = rgb.shape[:2]
        img = Image.fromarray(np.clip(rgb * 255.0, 0, 255).astype(np.uint8), mode="RGB")
        img = img.resize(self._size, Image.BILINEAR)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        # U²-Net's reference preprocessing: divide by the max, then ImageNet normalise.
        peak = float(arr.max()) or 1.0
        arr = arr / peak
        arr = (arr - MEAN) / STD
        batch = np.transpose(arr, (2, 0, 1))[None].astype(np.float32)

        out = self._session.run(batch)
        # U²-Net exports 7 side outputs; the first is the fused prediction.
        if out.ndim == 4:
            out = out[0, 0]
        elif out.ndim == 3:
            out = out[0]
        lo, hi = float(out.min()), float(out.max())
        out = (out - lo) / (hi - lo) if hi - lo > 1e-6 else np.zeros_like(out)

        mask = Image.fromarray(np.clip(out, 0, 1).astype(np.float32), mode="F")
        mask = mask.resize((width, height), Image.BICUBIC)
        return np.asarray(mask, dtype=np.float32)


U2NET_P = EngineInfo(
    id="u2netp",
    label="U²-Net-p (fallback)",
    family="U²-Net",
    license="Apache-2.0",
    size_mb=5,
    best_for="tiny footprints, low-RAM machines, high throughput",
    notes="Optional. Put u2netp.onnx at models/u2netp/ and it becomes selectable.",
)

U2NET = EngineInfo(
    id="u2net",
    label="U²-Net (fallback)",
    family="U²-Net",
    license="Apache-2.0",
    size_mb=176,
    best_for="CPU-only servers that still want decent edges",
    notes="Optional. Put u2net.onnx at models/u2net/ and it becomes selectable.",
)
