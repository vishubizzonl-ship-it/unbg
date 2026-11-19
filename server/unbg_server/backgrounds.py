"""Preview backgrounds — transparent, white, or any custom colour, never baked in."""

from __future__ import annotations

import re

import numpy as np
from PIL import Image

from .errors import UnbgError

NAMED = {
    "transparent": None,
    "white": (255, 255, 255),
    "black": (0, 0, 0),
    "gray": (128, 128, 128),
    "grey": (128, 128, 128),
    "red": (220, 38, 38),
    "blue": (37, 99, 235),
    "green": (22, 163, 74),
}

_HEX = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def parse_color(value: str | None) -> tuple[int, int, int] | None:
    """'transparent' -> None, 'white' -> (255,255,255), '#0af' -> (0,170,255)."""
    if value is None:
        return None
    raw = value.strip().lower()
    if raw in {"", "transparent", "none", "alpha"}:
        return None
    if raw in NAMED:
        return NAMED[raw]
    match = _HEX.match(raw)
    if not match:
        raise UnbgError(
            f"Unknown background {value!r}. Use 'transparent', a name, or a hex colour like '#ff8800'.",
            code="bad_background",
        )
    digits = match.group(1)
    if len(digits) == 3:
        digits = "".join(c * 2 for c in digits)
    return tuple(int(digits[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def composite(rgb: np.ndarray, alpha: np.ndarray, color: tuple[int, int, int] | None) -> Image.Image:
    """Flatten RGBA onto `color`; `None` keeps the alpha channel."""
    if color is None:
        a8 = np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)
        return Image.fromarray(np.dstack([rgb, a8]), mode="RGBA")
    a = np.clip(alpha, 0.0, 1.0)[..., None]
    back = np.array(color, dtype=np.float32)
    out = rgb.astype(np.float32) * a + back * (1.0 - a)
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), mode="RGB")
