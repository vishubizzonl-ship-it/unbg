"""Edge refinement: tighten the mask, optionally solve real alpha with closed-form matting.

BiRefNet returns a good but soft mask. Two cheap steps plus one expensive-but-worth-it
step turn it into a cutout that survives a close look:

1. smoothstep remap        — pushes ambiguous 0.4-0.6 pixels towards one side
2. closed-form matting     — pymatting solves per-pixel alpha inside an unknown band,
                             which is what makes hair and fur look right
3. gaussian feather        — removes the last pixel of stair-stepping
4. foreground estimation   — un-mixes the background colour out of semi-transparent
                             pixels, exactly like BiRefNet's official `refine_foreground`
                             (Photoroom fast-foreground-estimation, blur fusion). This is
                             what kills the white halo when a cutout lands on a colour.

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


def _box_blur_kernel(plane: np.ndarray, kernel: int) -> np.ndarray:
    """Box blur with an exact kernel size, i.e. an O(n) replacement for cv2.blur(p, (k, k))."""
    k = max(1, int(kernel))
    if k % 2 == 0:
        k += 1
    radius = k // 2
    out = np.asarray(plane, dtype=np.float32)
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


def _fb_blur_fusion(image: np.ndarray, fg: np.ndarray, bg: np.ndarray, alpha: np.ndarray, r: int) -> tuple[np.ndarray, np.ndarray]:
    """One step of the blur-fusion foreground estimator (Photoroom, MIT)."""
    a = alpha[..., None] if alpha.ndim == 2 else alpha
    blurred_alpha = _box_blur_kernel(a[:, :, 0], r)[..., None]

    blurred_fga = np.stack([_box_blur_kernel(fg[..., i] * a[:, :, 0], r) for i in range(3)], axis=-1)
    blurred_fg = blurred_fga / (blurred_alpha + 1e-5)

    blurred_b1a = np.stack([_box_blur_kernel(bg[..., i] * (1.0 - a[:, :, 0]), r) for i in range(3)], axis=-1)
    blurred_bg = blurred_b1a / ((1.0 - blurred_alpha) + 1e-5)

    out = blurred_fg + a * (image - a * blurred_fg - (1.0 - a) * blurred_bg)
    return np.clip(out, 0.0, 1.0), blurred_bg


def estimate_foreground(rgb: np.ndarray, alpha: np.ndarray, r: int = 90) -> np.ndarray | None:
    """Un-mix the background colour out of the alpha edge.

    `rgb` is HxWx3 uint8 (or float 0..1), alpha is HxW in 0..1. Returns a float RGB
    image in 0..1 with the background tint removed, or None when pymatting-style
    decontamination would be too expensive for this size.

    This mirrors `refine_foreground` in ZhengPeng7/BiRefNet's image_proc.py, which
    thanks Photoroom's fast-foreground-estimation. Without it, hair keeps a rim of
    the old background and looks dirty on a white or coloured backdrop.
    """
    if rgb.dtype == np.uint8:
        image = rgb.astype(np.float32) / 255.0
    else:
        image = np.asarray(rgb, dtype=np.float32)
    a = np.clip(np.asarray(alpha, dtype=np.float32), 0.0, 1.0)
    if image.shape[:2] != a.shape:
        return None

    fg, blur_bg = _fb_blur_fusion(image, image, image, a, r)
    fg, _ = _fb_blur_fusion(image, fg, blur_bg, a, 6)
    return fg


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
        unknown = trimap == 0.5
        if not unknown.any():
            return alpha

        # Closed-form matting solves a sparse system; solving it on the whole photo is
        # wasted work when only the edge band is unknown. Crop to that band (plus a
        # margin) and paste the answer back — same result, a fraction of the time.
        margin = max(8, band_px * 2)
        rows = np.where(unknown.any(axis=1))[0]
        cols = np.where(unknown.any(axis=0))[0]
        y0 = max(0, int(rows[0]) - margin)
        y1 = min(alpha.shape[0], int(rows[-1]) + margin + 1)
        x0 = max(0, int(cols[0]) - margin)
        x1 = min(alpha.shape[1], int(cols[-1]) + margin + 1)

        sub_image = rgb[y0:y1, x0:x1].astype(np.float64) / 255.0
        sub_trimap = trimap[y0:y1, x0:x1].astype(np.float64)
        solved = np.asarray(estimate_alpha_cf(sub_image, sub_trimap), dtype=np.float32)

        out = alpha.copy()
        sub_unknown = unknown[y0:y1, x0:x1]
        region = out[y0:y1, x0:x1]
        region[sub_unknown] = np.clip(solved, 0.0, 1.0)[sub_unknown]
        out[y0:y1, x0:x1] = region
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
