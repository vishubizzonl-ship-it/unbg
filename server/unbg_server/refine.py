"""Edge refinement: tighten the mask, optionally solve real alpha with closed-form matting.

BiRefNet returns a good but soft mask. Two cheap steps plus one expensive-but-worth-it
step turn it into a cutout that survives a close look:

1. smoothstep remap        — pushes ambiguous 0.4-0.6 pixels towards one side
2. closed-form matting     — pymatting solves per-pixel alpha inside an unknown band,
                             which is what makes hair and fur look right
3. gaussian feather        — removes the last pixel of stair-stepping

Every step is skippable and is reported back in the response metadata.
"""

from __future__ import annotations

import time

import numpy as np
from PIL import Image, ImageFilter

from .config import settings


def _smoothstep(x: np.ndarray, lo: float = 0.15, hi: float = 0.85) -> np.ndarray:
    t = np.clip((x - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _mask_filter(plane: np.ndarray, size: int, mode: str) -> np.ndarray:
    """Min/max filter on a uint8 mask — a cheap, dependency-free erode/dilate."""
    img = Image.fromarray((plane > 0.5).astype(np.uint8) * 255, mode="L")
    size = max(3, int(size) | 1)  # odd
    filtered = img.filter(ImageFilter.MaxFilter(size) if mode == "max" else ImageFilter.MinFilter(size))
    return np.asarray(filtered, dtype=np.float32) / 255.0


def build_trimap(alpha: np.ndarray, band_px: int) -> np.ndarray:
    """0 = certain background, 1 = certain foreground, 0.5 = unknown (solve here)."""
    sure_fg = _mask_filter(alpha, band_px, "min")
    sure_bg = _mask_filter(alpha, band_px, "max")
    trimap = np.full(alpha.shape, 0.5, dtype=np.float32)
    trimap[sure_bg < 0.5] = 0.0
    trimap[sure_fg > 0.5] = 1.0
    return trimap


def _box_blur(plane: np.ndarray, radius: int) -> np.ndarray:
    """O(n) separable box blur via running sums — no scipy, no 8-bit rounding."""
    radius = max(1, int(radius))
    k = 2 * radius + 1
    out = plane
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (radius, radius)
        padded = np.pad(out, pad, mode="edge")
        summed = np.cumsum(padded, axis=axis, dtype=np.float64)
        zero_shape = list(summed.shape)
        zero_shape[axis] = 1
        summed = np.concatenate([np.zeros(zero_shape), summed], axis=axis)
        hi = np.take(summed, np.arange(k, summed.shape[axis]), axis=axis)
        lo = np.take(summed, np.arange(0, summed.shape[axis] - k), axis=axis)
        out = ((hi - lo) / k).astype(np.float32)
    return out


def feather(alpha: np.ndarray, radius: float) -> np.ndarray:
    """Soft 1-2 px edge, approximated by three box passes (a Gaussian to the eye)."""
    if radius <= 0:
        return alpha
    out = np.clip(alpha, 0.0, 1.0).astype(np.float32)
    for _ in range(3):
        out = _box_blur(out, max(1, round(radius)))
    return out


def solve_alpha(rgb: np.ndarray, alpha: np.ndarray, band_px: int) -> np.ndarray | None:
    """Closed-form matting inside the trimap band. Returns None when unavailable."""
    try:
        from pymatting import estimate_alpha_cf
    except Exception:  # pragma: no cover - pymatting is optional at runtime
        return None
    if rgb.shape[0] * rgb.shape[1] > settings.matte_max_pixels:
        return None
    try:
        trimap = build_trimap(alpha, band_px)
        solved = estimate_alpha_cf(rgb.astype(np.float64) / 255.0, trimap.astype(np.float64))
        solved = np.asarray(solved, dtype=np.float32)
        # Closed-form matting can wander outside the band; trust the network there.
        out = alpha.copy()
        unknown = trimap == 0.5
        out[unknown] = np.clip(solved, 0.0, 1.0)[unknown]
        return out
    except Exception:  # pragma: no cover - numerical failure must never 500 a request
        return None


def refine(
    alpha: np.ndarray,
    rgb: np.ndarray,
    *,
    matte: bool | None = None,
    feather_px: float | None = None,
    band_px: int | None = None,
) -> tuple[np.ndarray, dict]:
    """Return (refined alpha, steps) where steps is JSON-friendly metadata."""
    started = time.perf_counter()
    steps: dict = {}
    alpha = np.clip(np.asarray(alpha, dtype=np.float32), 0.0, 1.0)

    if alpha.size == 0:
        return alpha, {"steps": []}

    alpha = _smoothstep(alpha)
    steps["smoothstep"] = True

    use_matte = settings.matte if matte is None else matte
    band = band_px or max(3, int(min(alpha.shape) * 0.01))
    if use_matte:
        solved = solve_alpha(rgb, alpha, band)
        if solved is not None:
            alpha = solved
            steps["matte"] = "pymatting-cf"
            steps["matte_band_px"] = band
        else:
            steps["matte"] = "skipped (image too large or pymatting unavailable)"

    radius = settings.feather_px if feather_px is None else feather_px
    alpha = feather(alpha, radius)
    if radius:
        steps["feather_px"] = radius

    steps["refine_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return np.clip(alpha, 0.0, 1.0), steps
