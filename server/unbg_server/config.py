"""Settings, entirely from the environment — no secrets, nothing baked in."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _origins() -> list[str]:
    raw = os.environ.get(
        "UNBG_ALLOWED_ORIGINS",
        "http://localhost:4321,http://127.0.0.1:4321,http://localhost:8000",
    )
    return [o.strip() for o in raw.split(",") if o.strip()]


@dataclass(frozen=True)
class Settings:
    """Everything tunable lives here, so a deployment differs by env only."""

    model_dir: Path = field(default_factory=lambda: Path(os.environ.get("UNBG_MODEL_DIR", "./models")))
    result_dir: Path = field(default_factory=lambda: Path(os.environ.get("UNBG_RESULT_DIR", "./results")))

    # uploads / validation
    max_upload_bytes: int = field(default_factory=lambda: _int("UNBG_MAX_UPLOAD_BYTES", 20 * 1024 * 1024))
    max_pixels: int = field(default_factory=lambda: _int("UNBG_MAX_PIXELS", 60_000_000))
    max_batch: int = field(default_factory=lambda: _int("UNBG_MAX_BATCH", 8))
    allowed_formats: tuple[str, ...] = ("JPEG", "PNG", "WEBP")

    # inference
    default_model: str = field(default_factory=lambda: os.environ.get("UNBG_DEFAULT_MODEL", "silueta"))
    input_size: int = field(default_factory=lambda: _int("UNBG_INPUT_SIZE", 1024))
    intra_threads: int = field(default_factory=lambda: _int("UNBG_THREADS", max(1, (os.cpu_count() or 2) // 2)))
    max_concurrency: int = field(default_factory=lambda: _int("UNBG_MAX_CONCURRENCY", 1))
    use_gpu: bool = field(default_factory=lambda: _bool("UNBG_USE_GPU", True))
    # keep exactly one model resident: a 972 MB BiRefNet graph must not sit next to
    # another one on a small box (this is what "do not load heavy models together" means)
    single_model: bool = field(default_factory=lambda: _bool("UNBG_SINGLE_MODEL", True))
    # Silueta's second pass on the subject crop. Measured on a ground-truth test card it
    # buys nothing at 0.10 padding and only reaches parity at 0.40, while costing ~2x the
    # time — so it is off by default. Turn it on for photos where the subject is small
    # in frame and the edges are the hard part.
    second_pass: bool = field(default_factory=lambda: _bool("UNBG_SECOND_PASS", False))

    # post-processing
    matte: bool = field(default_factory=lambda: _bool("UNBG_MATTE", True))
    matte_max_pixels: int = field(default_factory=lambda: _int("UNBG_MATTE_MAX_PIXELS", 2_500_000))
    decontaminate: bool = field(default_factory=lambda: _bool("UNBG_DECONTAMINATE", True))
    feather_px: float = field(default_factory=lambda: _float("UNBG_FEATHER_PX", 0.6))

    # http
    allowed_origins: tuple[str, ...] = field(default_factory=lambda: tuple(_origins()))
    result_ttl_seconds: int = field(default_factory=lambda: _int("UNBG_RESULT_TTL", 3600))


settings = Settings()
