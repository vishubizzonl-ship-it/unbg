"""The model registry — one place to look, one place to add a model.

Adding a model later is three lines: write an Engine subclass, give it an `EngineInfo`,
append it to `_FACTORIES`. Routes, /api/models, validation, GPU fallback and the
frontend dropdown all read this registry, so nothing else needs to change.
"""

from __future__ import annotations

import logging
import threading

from ..config import settings
from ..errors import UnknownModel
from .base import Engine, EngineInfo
from .birefnet import B512, GENERAL, HR, LITE, LITE2K, MATTING, PORTRAIT, BiRefNetEngine
from .u2net import U2NET, U2NET_P, U2NetEngine

log = logging.getLogger("unbg.registry")

_FACTORIES: dict[str, callable] = {
    GENERAL.id: lambda: BiRefNetEngine(GENERAL, "onnx-community/BiRefNet-ONNX"),
    PORTRAIT.id: lambda: BiRefNetEngine(PORTRAIT, "onnx-community/BiRefNet-portrait-ONNX"),
    MATTING.id: lambda: BiRefNetEngine(MATTING, "ZhengPeng7/BiRefNet"),
    LITE2K.id: lambda: BiRefNetEngine(LITE2K, "ZhengPeng7/BiRefNet"),
    HR.id: lambda: BiRefNetEngine(HR, "ZhengPeng7/BiRefNet"),
    LITE.id: lambda: BiRefNetEngine(LITE, "onnx-community/BiRefNet_lite-ONNX"),
    B512.id: lambda: BiRefNetEngine(
        B512, "onnx-community/BiRefNet_512x512-ONNX", variant="model_fp16.onnx"
    ),
    U2NET.id: lambda: U2NetEngine(U2NET),
    U2NET_P.id: lambda: U2NetEngine(U2NET_P, folder="u2netp"),
}

_LOCK = threading.Lock()
_CACHE: dict[str, Engine] = {}


def get(model_id: str | None = None) -> Engine:
    """Return a (cached) engine by id, falling back to the configured default."""
    wanted = (model_id or settings.default_model or GENERAL.id).strip()
    wanted = _ALIASES.get(wanted, wanted)
    if wanted not in _FACTORIES:
        raise UnknownModel(
            f"Unknown model {wanted!r}. Available: {', '.join(_FACTORIES)}.",
        )
    with _LOCK:
        if wanted not in _CACHE:
            _CACHE[wanted] = _FACTORIES[wanted]()
        return _CACHE[wanted]


_ALIASES = {
    "general": GENERAL.id,
    "portrait": PORTRAIT.id,
    "matting": MATTING.id,
    "lite": LITE.id,
    "hr": HR.id,
    "2k": LITE2K.id,
    "auto": GENERAL.id,
    "birefnet": GENERAL.id,
}


def engine_ids() -> list[str]:
    return list(_FACTORIES)


def describe() -> list[dict]:
    """Registry as JSON for /api/models and for the frontend dropdown."""
    out = []
    for model_id in _FACTORIES:
        engine = get(model_id)
        info: EngineInfo = engine.info
        available = engine.available()
        runtime = getattr(engine, "runtime", {})
        out.append(
            {
                "id": info.id,
                "label": info.label,
                "family": info.family,
                "license": info.license,
                "size_mb": info.size_mb,
                "best_for": info.best_for,
                "notes": info.notes,
                "available": available,
                "loaded": bool(getattr(engine, "_loaded", False)),
                "providers": runtime.get("providers", []),
                "recommended": info.id == settings.default_model,
            }
        )
    return out


def best_for(subject: str) -> str:
    """Pick a sensible default: portraits get the portrait checkpoint when installed."""
    wanted = (subject or "auto").strip().lower()
    if wanted in {"person", "portrait", "people", "human", "selfie"}:
        portrait = get(PORTRAIT.id)
        if portrait.available():
            return PORTRAIT.id
    return settings.default_model or GENERAL.id


def warm_default() -> dict:
    """Load the default engine at startup so the first request is not slow."""
    model_id = settings.default_model
    engine = get(model_id)
    if not engine.available():
        log.warning("default model %s is not downloaded yet", model_id)
        return {"model": model_id, "loaded": False}
    try:
        engine.load()
        return {"model": model_id, "loaded": True, "providers": getattr(engine, "runtime", {}).get("providers", [])}
    except Exception as exc:  # pragma: no cover - a broken model must not stop the API
        log.exception("could not load %s: %s", model_id, exc)
        return {"model": model_id, "loaded": False, "error": str(exc)}


def loaded_models() -> list[str]:
    return [model_id for model_id, engine in _CACHE.items() if getattr(engine, "_loaded", False)]


def unload_all() -> None:
    """Free RAM between tests / deploys."""
    with _LOCK:
        for engine in _CACHE.values():
            if hasattr(engine, "_session"):
                engine._session = None  # noqa: SLF001 - intentional teardown
                engine._loaded = False
        _CACHE.clear()
