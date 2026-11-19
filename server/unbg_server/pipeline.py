"""The whole cutout in one function: bytes in, PNG bytes + metadata out.

Kept free of FastAPI so it can be called from a queue worker, a CLI, or a test.
"""

from __future__ import annotations

import time

import numpy as np

from . import backgrounds, io_images, refine
from .config import settings
from .engines import registry


def remove_background(
    data: bytes,
    *,
    model: str | None = None,
    background: str | None = None,
    matte: bool | None = None,
    decontaminate: bool | None = None,
    second_pass: bool | None = None,
    detail: str = "normal",
    subject: str = "auto",
) -> tuple[bytes, dict]:
    started = time.perf_counter()
    loaded = io_images.load(data)
    colour = backgrounds.parse_color(background)

    chosen = registry.best_for(subject) if not model or model == "auto" else model
    engine = registry.get(chosen)

    rgb = loaded.rgb  # uint8, used by the compositor and matting solver
    rgb_float = loaded.rgb.astype("float32") / 255.0  # what the network sees
    predict_kwargs: dict = {"input_size": settings.input_size, "detail": detail}
    if second_pass is not None and getattr(engine, "supports_second_pass", False):
        predict_kwargs["second_pass"] = second_pass
    alpha, predict_meta = engine.predict(rgb_float, **predict_kwargs)
    alpha, refine_meta = refine.refine(alpha, rgb, matte=matte)

    # BiRefNet's own last step: pull the old background colour out of the alpha edge,
    # so hair does not keep a light rim when the cutout lands on a white/coloured page.
    use_fg = settings.decontaminate if decontaminate is None else decontaminate
    fg_rgb = rgb
    if use_fg and loaded.pixels <= settings.matte_max_pixels:
        fg_started = time.perf_counter()
        estimated = refine.estimate_foreground(rgb, alpha)
        if estimated is not None:
            fg_rgb = np.clip(estimated * 255.0 + 0.5, 0, 255).astype(np.uint8)
            refine_meta["foreground"] = "blur-fusion"
            refine_meta["foreground_ms"] = round((time.perf_counter() - fg_started) * 1000, 1)
        else:
            refine_meta["foreground"] = "skipped"
    elif use_fg:
        refine_meta["foreground"] = "skipped (image too large)"

    image = backgrounds.composite(fg_rgb, alpha, colour)
    png = io_images.encode_png(image)

    coverage = float(alpha.mean())
    meta = {
        "model": engine.info.id,
        "model_label": engine.info.label,
        "license": engine.info.license,
        "width": loaded.width,
        "height": loaded.height,
        "source_width": loaded.original_width,
        "source_height": loaded.original_height,
        "input_format": loaded.fmt,
        "downscaled": loaded.scaled,
        "background": "transparent" if colour is None else "#%02x%02x%02x" % colour,
        "detail": detail,
        "coverage": round(coverage, 4),
        "alpha_bytes": len(png),
        "timings": {
            **predict_meta,
            **refine_meta,
            "total_ms": round((time.perf_counter() - started) * 1000, 1),
        },
    }
    return png, meta
