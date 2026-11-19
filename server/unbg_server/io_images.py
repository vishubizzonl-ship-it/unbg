"""Image in / image out: validation, decoding, resizing, compositing, encoding.

Nothing here touches a model — it is plain Pillow + numpy, so it is cheap to unit test.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import settings
from .errors import TooLarge, Unreadable, UnsupportedMedia

# Magic bytes are checked before Pillow sees the file: a mislabelled .exe or a
# truncated upload gets a clear 4xx instead of an exception deep in the decoder.
_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "JPEG"),
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"RIFF", "WEBP"),  # RIFF....WEBP, verified below
)


def sniff(data: bytes) -> str:
    """Return the real format of `data` or raise UnsupportedMedia."""
    if not data:
        raise UnsupportedMedia("File is empty.")
    if len(data) > settings.max_upload_bytes:
        raise TooLarge(
            f"File is {len(data) / 1048576:.1f} MB; the limit is "
            f"{settings.max_upload_bytes / 1048576:.0f} MB."
        )
    for signature, fmt in _SIGNATURES:
        if data.startswith(signature):
            if fmt == "WEBP" and data[8:12] != b"WEBP":
                continue
            return fmt
    raise UnsupportedMedia("Only JPG, PNG and WEBP images are supported.")


@dataclass
class LoadedImage:
    rgb: np.ndarray          # HxWx3 uint8, EXIF-rotated, fully opaque RGB
    width: int
    height: int
    fmt: str
    scaled: bool = False     # True when the source exceeded max_pixels
    original_width: int = 0
    original_height: int = 0

    @property
    def pixels(self) -> int:
        return self.width * self.height


def load(data: bytes) -> LoadedImage:
    """Validate, decode, apply EXIF orientation, and bound the pixel count."""
    fmt = sniff(data)
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.load()  # forces a real decode; catches truncated files here
            if probe.format and probe.format.upper() not in settings.allowed_formats:
                raise UnsupportedMedia(f"{probe.format} is not supported. Use JPG, PNG or WEBP.")
            image = ImageOps.exif_transpose(probe)
            image = image.convert("RGB")
    except UnsupportedMedia:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise Unreadable(f"Could not decode the image: {exc}") from exc

    width, height = image.size
    if width < 2 or height < 2:
        raise Unreadable(f"Image is {width}x{height}px — too small to cut out a subject.")

    scaled = False
    original = (width, height)
    if width * height > settings.max_pixels:
        ratio = (settings.max_pixels / (width * height)) ** 0.5
        image = image.resize(
            (max(2, int(width * ratio)), max(2, int(height * ratio))), Image.LANCZOS
        )
        if image.width * image.height > settings.max_pixels:  # rounding safety
            image = image.resize((int(width * ratio), int(height * ratio)), Image.LANCZOS)
        scaled = True

    return LoadedImage(
        rgb=np.asarray(image, dtype=np.uint8),
        width=image.width,
        height=image.height,
        fmt=fmt,
        scaled=scaled,
        original_width=original[0],
        original_height=original[1],
    )


def resize_alpha(alpha: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Resize a float mask to (width, height) without clipping its range."""
    if alpha.shape[::-1] == size:
        return alpha
    plane = Image.fromarray(np.clip(alpha, 0.0, 1.0).astype(np.float32), mode="F")
    return np.asarray(plane.resize(size, Image.BICUBIC), dtype=np.float32)


def to_rgba(rgb: np.ndarray, alpha: np.ndarray) -> Image.Image:
    """Combine RGB + float alpha into an RGBA image (alpha as uint8)."""
    if alpha.shape != rgb.shape[:2]:
        alpha = resize_alpha(alpha, (rgb.shape[1], rgb.shape[0]))
    a8 = np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a8]), mode="RGBA")


def encode_png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()
