"""Silueta — the lightweight default: 44 MB, 320x320, CPU-only, no GPU anywhere.

Silueta is the small U²-Net-family portrait/general cutout model published with rembg
(Apache-2.0). It is ~20x smaller than full BiRefNet and ~10x faster on CPU, which makes
it the right default for a phone, a 1 GB VPS, or a batch job.

Preprocessing is rembg's recipe, matching the graph's fixed input exactly:
    resize to 320x320 (bilinear) -> /255 -> divide by the image maximum
    -> ImageNet normalise (mean .485/.456/.406, std .229/.224/.225)
    -> NCHW float32
Postprocessing:
    the graph returns 7 side outputs; the first is the fused map (as in U²-Net)
    -> min-max normalise -> smoothstep-free upscale to the *original* resolution
    (bicubic, so the mask does not get blocky) -> the pipeline's alpha refinement.

A 320 px mask is the honest weakness of a model this small, so the engine can also run a
second pass on a padded crop around the subject (zoom refine): the same 320 px budget spent
on the subject instead of the whole frame. It is OFF by default and that is deliberate —
measured against a ground-truth alpha card it did not beat a single pass (0.10 padding was
slightly worse, 0.40 reached parity) while costing ~2x the time. Flip `UNBG_SECOND_PASS=1`
or send `?second_pass=true` when your photos have a small subject and expensive edges.
"""

from __future__ import annotations

import time

import numpy as np
from PIL import Image

from ..config import settings
from ._ort import Session
from .base import Engine, EngineInfo
from .u2net import MEAN, STD

INFO = EngineInfo(
    id="silueta",
    label="Silueta (lightweight)",
    family="U²-Net-small",
    license="Apache-2.0",
    size_mb=44,
    best_for="default for everything — portraits, products, fast batches, low RAM",
    notes="320x320 CPU inference, ~44 MB, second pass on the subject crop for crisp edges.",
    files=("silueta.onnx",),
)

CROP_PAD = 0.40       # padding around the subject box (measured: 0.40 matches the
                      # single-pass mask instead of losing thin detail at the crop seam)
CROP_SEAM_PX = 12     # blend ramp where the refined crop meets the first pass
MIN_CROP_GAIN = 1.35  # only re-run when the crop actually buys resolution


class SiluetaEngine(Engine):
    supports_second_pass = True

    def __init__(self, info: EngineInfo = INFO, folder: str = "silueta") -> None:
        super().__init__()
        self.info = info
        self.folder = folder
        self._session: Session | None = None
        self._size: tuple[int, int] = (320, 320)

    # -- lifecycle -------------------------------------------------------
    def path(self):
        folder = settings.model_dir / self.folder
        exact = folder / f"{self.folder}.onnx"
        if exact.exists():
            return exact
        if folder.is_dir():
            found = sorted(folder.glob("*.onnx"))
            if found:
                return found[0]
        return exact

    def available(self) -> bool:
        return self.path().exists()

    def load(self) -> None:
        if self._session is None:
            self._session = Session(
                self.path(), use_gpu=False, threads=settings.intra_threads
            )
            static = self._session.static_size
            if static:
                self._size = static
        self._loaded = True

    @property
    def runtime(self) -> dict:
        if self._session is None:
            return {}
        return {
            "providers": self._session.providers,
            "file": self._session.path.name,
            "input": list(self._session.input.shape),
            "outputs": len(self._session.session.get_outputs()),
        }

    # -- geometry --------------------------------------------------------
    def preprocessing_size(self, width: int, height: int, input_size: int) -> tuple[int, int]:
        return self._size  # the graph is fixed at 320x320

    def tile_size(self, input_size: int) -> int:
        return 0  # tiling is pointless on a 320 px graph; zoom refine replaces it

    # -- inference -------------------------------------------------------
    def _run(self, rgb: np.ndarray) -> np.ndarray:
        """One forward pass on a 320x320 view of `rgb`, mask at `rgb`'s size."""
        assert self._session is not None, "call load() first"
        height, width = rgb.shape[:2]

        img = Image.fromarray(np.clip(rgb * 255.0, 0, 255).astype(np.uint8), mode="RGB")
        img = img.resize(self._size, Image.BILINEAR)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        peak = float(arr.max())
        if peak > 0:
            arr = arr / peak
        arr = (arr - MEAN) / STD
        batch = np.transpose(arr, (2, 0, 1))[None].astype(np.float32)

        out = self._session.run(batch)  # first output = fused map
        if out.ndim == 4:
            out = out[0, 0]
        elif out.ndim == 3:
            out = out[0]

        low, high = float(out.min()), float(out.max())
        out = (out - low) / (high - low) if high - low > 1e-6 else np.zeros_like(out)

        mask = Image.fromarray(np.clip(out, 0, 1).astype(np.float32), mode="F")
        mask = mask.resize((width, height), Image.BICUBIC)
        return np.asarray(mask, dtype=np.float32)

    def _infer(self, rgb: np.ndarray) -> np.ndarray:
        return self._run(rgb)

    # -- zoom refine -----------------------------------------------------
    def _subject_box(self, mask: np.ndarray) -> tuple[int, int, int, int] | None:
        height, width = mask.shape
        rows = np.where(mask.max(axis=1) > 0.5)[0]
        cols = np.where(mask.max(axis=0) > 0.5)[0]
        if rows.size == 0 or cols.size == 0:
            return None
        top, bottom = int(rows[0]), int(rows[-1]) + 1
        left, right = int(cols[0]), int(cols[-1]) + 1
        pad_y = int((bottom - top) * CROP_PAD)
        pad_x = int((right - left) * CROP_PAD)
        return (
            max(0, left - pad_x),
            max(0, top - pad_y),
            min(width, right + pad_x),
            min(height, bottom + pad_y),
        )

    def predict(
        self,
        rgb: np.ndarray,
        *,
        input_size: int = 1024,
        detail: str = "normal",
        second_pass: bool | None = None,
    ):
        alpha, meta = super().predict(rgb, input_size=input_size, detail=detail)
        use_second = settings.second_pass if second_pass is None else second_pass
        if not use_second:
            return alpha, meta

        started = time.perf_counter()
        box = self._subject_box(alpha)
        if box is None:
            meta["second_pass"] = "skipped (empty mask)"
            return alpha, meta

        left, top, right, bottom = box
        height, width = alpha.shape
        crop_gain = max(width / max(right - left, 1), height / max(bottom - top, 1))
        if crop_gain < MIN_CROP_GAIN:
            meta["second_pass"] = f"skipped (crop gain {crop_gain:.2f}x — subject already fills the frame)"
            return alpha, meta

        crop_mask = self._run(rgb[top:bottom, left:right])

        # Ramp the crop back in: 1 in the middle, 0 at the crop border, so no seam shows.
        h, w = crop_mask.shape
        ramp_y = np.clip(np.minimum(np.arange(h), np.arange(h)[::-1]) / CROP_SEAM_PX, 0, 1)
        ramp_x = np.clip(np.minimum(np.arange(w), np.arange(w)[::-1]) / CROP_SEAM_PX, 0, 1)
        weight = np.outer(ramp_y, ramp_x).astype(np.float32)

        blended = alpha.copy()
        region = blended[top:bottom, left:right]
        blended[top:bottom, left:right] = weight * crop_mask + (1.0 - weight) * region

        meta["second_pass"] = "zoom refine"
        meta["second_pass_box"] = [left, top, right, bottom]
        meta["second_pass_gain"] = round(crop_gain, 2)
        meta["second_pass_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return np.clip(blended, 0.0, 1.0), meta
