"""Engine contract shared by every model, plus the large-image prediction strategy.

Tiling matters for full-resolution output: a 24 MP photo downscaled to 1024 px loses
about 4x the detail along hair and product edges. With `detail="high"` we run the
network on overlapping crops and blend them with a raised-cosine window, so the mask
keeps native resolution detail while each forward pass stays inside the memory budget.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from ..errors import ModelUnavailable


@dataclass
class EngineInfo:
    id: str
    label: str
    family: str
    license: str
    size_mb: int
    best_for: str
    notes: str = ""
    files: tuple[str, ...] = field(default_factory=tuple)


def _snap(value: int, multiple: int = 32, minimum: int = 64) -> int:
    return max(minimum, int(round(value / multiple)) * multiple)


def _resize_float(rgb: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """(W, H) resize of a float32 HxWx3 image, bilinear, clipped to 0..1."""
    img = Image.fromarray(np.clip(rgb * 255.0, 0, 255).astype(np.uint8), mode="RGB")
    return np.asarray(img.resize(size, Image.BILINEAR), dtype=np.float32) / 255.0


def _resize_mask(mask: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    img = Image.fromarray(np.clip(mask, 0.0, 1.0).astype(np.float32), mode="F")
    return np.asarray(img.resize(size, Image.BICUBIC), dtype=np.float32)


def raised_cosine(h: int, w: int) -> np.ndarray:
    """2-D window that is 1 in the middle and fades to ~0 at the crop border."""
    wy = np.hanning(max(h, 3)).astype(np.float32)
    wx = np.hanning(max(w, 3)).astype(np.float32)
    wy = np.maximum(wy, 1e-3)
    wx = np.maximum(wx, 1e-3)
    return np.outer(wy, wx)[:h, :w]


class Engine(ABC):
    """A background-removal model. Subclasses only implement `_infer`."""

    info: EngineInfo
    supports_second_pass = False

    def __init__(self) -> None:
        self._loaded = False

    # -- lifecycle -------------------------------------------------------
    @abstractmethod
    def available(self) -> bool:
        """True when the weights are present and the runtime can load them."""

    @abstractmethod
    def load(self) -> None:
        """Load weights. Must be idempotent and safe to call from a worker thread."""

    def tile_size(self, input_size: int) -> int:
        """Crop size used by `detail="high"`."""
        return int(input_size)

    def preprocessing_size(self, width: int, height: int, input_size: int) -> tuple[int, int]:
        """(w, h) fed to the network. Overridden when an export has fixed dims."""
        scale = min(1.0, input_size / max(width, height))
        return (_snap(int(width * scale)), _snap(int(height * scale)))

    # -- inference -------------------------------------------------------
    @abstractmethod
    def _infer(self, rgb: np.ndarray) -> np.ndarray:
        """rgb: float32 HxWx3 in 0..1 -> alpha float32 HxW in 0..1 (same size)."""

    def predict(
        self,
        rgb: np.ndarray,
        *,
        input_size: int = 1024,
        detail: str = "normal",
    ) -> tuple[np.ndarray, dict]:
        if not self.available():
            raise ModelUnavailable(
                f"{self.info.label} is not installed. Run `python scripts/fetch_models.py {self.info.id}`."
            )
        if not self._loaded:
            self.load()

        started = time.perf_counter()
        height, width = rgb.shape[:2]
        long_side = max(height, width)
        meta: dict = {}

        tile = max(64, self.tile_size(input_size))
        if detail == "high" and long_side > tile * 1.5:
            alpha = self._tiled(rgb, tile, meta)
        else:
            target = self.preprocessing_size(width, height, input_size)
            small = rgb if target == (width, height) else _resize_float(rgb, target)
            alpha = self._infer(small)
            if alpha.shape[::-1] != (width, height):
                alpha = _resize_mask(alpha, (width, height))
            meta["pass"] = "single"
            meta["inference_size"] = list(target)

        meta["engine_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return np.clip(alpha, 0.0, 1.0), meta

    def _tiled(self, rgb: np.ndarray, input_size: int, meta: dict) -> np.ndarray:
        height, width = rgb.shape[:2]
        tile = int(input_size)
        overlap = tile // 4
        stride = tile - overlap
        xs = list(range(0, max(width - tile, 0) + 1, stride))
        ys = list(range(0, max(height - tile, 0) + 1, stride))
        if xs[-1] + tile < width:
            xs.append(width - tile)
        if ys[-1] + tile < height:
            ys.append(height - tile)

        acc = np.zeros((height, width), dtype=np.float32)
        weight = np.zeros((height, width), dtype=np.float32)
        window = raised_cosine(tile, tile)
        for y in ys:
            for x in xs:
                crop = rgb[y : y + tile, x : x + tile]
                mask = self._infer(crop)
                if mask.shape != (crop.shape[0], crop.shape[1]):
                    mask = _resize_mask(mask, (crop.shape[1], crop.shape[0]))
                acc[y : y + tile, x : x + tile] += mask * window
                weight[y : y + tile, x : x + tile] += window
        meta["pass"] = "tiled"
        meta["tiles"] = len(xs) * len(ys)
        return acc / np.maximum(weight, 1e-6)
