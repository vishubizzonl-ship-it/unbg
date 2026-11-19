"""FastAPI app: /api/remove, /api/batch, /api/models, /api/health, /results/{id}.

Design notes that matter in production:
  * inference runs in a worker thread and is capped by a semaphore, so a batch of 8
    cannot allocate 8 BiRefNet graphs at once and take the box down;
  * every error is a JSON `{error, message}` with the right status code;
  * nothing here reads an API key — there are none. The frontend never holds a secret
    because the whole service runs next to it.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from . import __version__, backgrounds, pipeline
from .config import settings
from .engines import registry
from .engines._ort import describe_runtime
from .errors import TooLarge, UnbgError, unbg_error_handler

logging.basicConfig(level=os.environ.get("UNBG_LOG_LEVEL", "info").upper())
log = logging.getLogger("unbg.api")

SEMAPHORE = asyncio.Semaphore(settings.max_concurrency)
_EXECUTOR: ThreadPoolExecutor | None = None
STARTED = time.time()


def executor() -> ThreadPoolExecutor:
    """One inference pool for the process, recreated if a previous app run closed it."""
    global _EXECUTOR
    if _EXECUTOR is None or getattr(_EXECUTOR, "_shutdown", False):
        _EXECUTOR = ThreadPoolExecutor(
            max_workers=settings.max_concurrency, thread_name_prefix="unbg-infer"
        )
    return _EXECUTOR


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.result_dir.mkdir(parents=True, exist_ok=True)
    settings.model_dir.mkdir(parents=True, exist_ok=True)
    _sweep_results()
    if os.environ.get("UNBG_WARM", "1") != "0":
        try:
            await run_in_threadpool(registry.warm_default)
        except Exception as exc:  # pragma: no cover
            log.warning("warmup skipped: %s", exc)
    log.info("unbg api %s ready on %s", __version__, describe_runtime())
    yield
    global _EXECUTOR
    if _EXECUTOR is not None:
        _EXECUTOR.shutdown(wait=False, cancel_futures=True)
        _EXECUTOR = None


app = FastAPI(
    title="unbg inference API",
    version=__version__,
    description="Open-source background removal: BiRefNet General + Portrait, U²-Net fallback.",
    lifespan=lifespan,
)
app.add_exception_handler(UnbgError, unbg_error_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Unbg-Meta"],
    max_age=600,
)


@app.middleware("http")
async def guard_body_size(request: Request, call_next):
    """Cheap rejection before a 200 MB upload is buffered into RAM."""
    if request.method == "POST":
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > settings.max_upload_bytes * min(settings.max_batch, 4):
            return JSONResponse(
                status_code=413,
                content={"error": "too_large", "message": "Upload is larger than this server accepts."},
            )
    return await call_next(request)


def _sweep_results() -> None:
    """Delete result files older than the TTL so the disk cannot fill up."""
    cutoff = time.time() - settings.result_ttl_seconds
    for path in settings.result_dir.glob("*.png"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


async def _run(data: bytes, **kwargs):
    """Inference, off the event loop, one model pass at a time by default."""
    async with SEMAPHORE:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(executor(), lambda: pipeline.remove_background(data, **kwargs))


# --------------------------------------------------------------------------- routes
@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "uptime_s": round(time.time() - STARTED, 1),
        "runtime": describe_runtime(),
        "gpu": settings.use_gpu,
        "concurrency": settings.max_concurrency,
        "threads": settings.intra_threads,
        "input_size": settings.input_size,
        "default_model": settings.default_model,
        "loaded": registry.loaded_models(),
        "models_installed": [m["id"] for m in registry.describe() if m["available"]],
    }


@app.get("/api/models")
async def models() -> dict:
    return {"default": settings.default_model, "models": registry.describe()}


@app.get("/api/backgrounds")
async def sample_backgrounds() -> dict:
    return {"named": sorted(backgrounds.NAMED), "format": "transparent | name | #rrggbb"}


@app.post("/api/remove")
async def remove(
    file: UploadFile = File(..., description="JPG, PNG or WEBP"),
    model: str = Query("auto", description="model id, or 'auto'"),
    background: str = Query("transparent", description="transparent | white | #rrggbb"),
    matte: bool = Query(True, description="closed-form alpha matting for hair"),
    decontaminate: bool = Query(
        True, description="un-mix the background colour out of the alpha edge (no white halo)"
    ),
    detail: str = Query("normal", description="normal | high (tiled, keeps native detail)"),
    subject: str = Query("auto", description="auto | person | object"),
    store: bool = Query(False, description="also keep a /results/{id}.png copy"),
):
    data = await file.read()
    if len(data) > settings.max_upload_bytes:
        raise TooLarge(f"File is {len(data) / 1048576:.1f} MB; limit is {settings.max_upload_bytes / 1048576:.0f} MB.")
    if detail not in {"normal", "high"}:
        raise UnbgError("detail must be 'normal' or 'high'", code="bad_detail")
    png, meta = await _run(
        data,
        model=model,
        background=background,
        matte=matte,
        decontaminate=decontaminate,
        detail=detail,
        subject=subject,
    )

    headers = {
        "X-Unbg-Model": meta["model"],
        "X-Unbg-Meta": _compact_meta(meta),
        "Cache-Control": "no-store",
    }
    if store:
        token = uuid.uuid4().hex
        (settings.result_dir / f"{token}.png").write_bytes(png)
        headers["X-Unbg-Result"] = f"/api/results/{token}.png"
        headers["X-Unbg-Meta"] = _compact_meta({**meta, "result": headers["X-Unbg-Result"]})
    return Response(content=png, media_type="image/png", headers=headers)


def _compact_meta(meta: dict) -> str:
    """Meta has to survive an HTTP header: keep it short and ASCII."""
    import json

    brief = {k: v for k, v in meta.items() if k != "notes"}
    text = json.dumps(brief, separators=(",", ":"), ensure_ascii=True)
    return text if len(text) <= 3500 else text[:3497] + "..."


@app.post("/api/batch")
async def batch(
    files: list[UploadFile] = File(..., description="up to UNBG_MAX_BATCH images"),
    model: str = Query("auto"),
    background: str = Query("transparent"),
    matte: bool = Query(True),
    decontaminate: bool = Query(True),
    detail: str = Query("normal"),
    subject: str = Query("auto"),
):
    if not files:
        raise UnbgError("Send at least one file.", code="no_files")
    if len(files) > settings.max_batch:
        raise TooLarge(f"{len(files)} files sent; this server accepts {settings.max_batch} per batch.")

    results = []
    for upload in files:
        started = time.perf_counter()
        try:
            data = await upload.read()
            png, meta = await _run(
                data,
                model=model,
                background=background,
                matte=matte,
                decontaminate=decontaminate,
                detail=detail,
                subject=subject,
            )
            token = uuid.uuid4().hex
            (settings.result_dir / f"{token}.png").write_bytes(png)
            results.append(
                {
                    "filename": upload.filename,
                    "ok": True,
                    "bytes": len(png),
                    "ms": round((time.perf_counter() - started) * 1000, 1),
                    "model": meta["model"],
                    "width": meta["width"],
                    "height": meta["height"],
                    "coverage": meta["coverage"],
                    "url": f"/api/results/{token}.png",
                }
            )
        except UnbgError as exc:
            results.append(
                {"filename": upload.filename, "ok": False, "error": exc.code, "message": exc.message}
            )
        except Exception as exc:  # a broken file must not kill the batch
            log.exception("batch item failed: %s", upload.filename)
            results.append(
                {
                    "filename": upload.filename,
                    "ok": False,
                    "error": "internal_error",
                    "message": str(exc),
                }
            )
    return {"count": len(results), "results": results}


@app.get("/api/results/{name}")
async def result(name: str):
    if not name.endswith(".png") or "/" in name or ".." in name:
        raise UnbgError("Bad result name.", code="bad_result", status_code=400)
    path: Path = settings.result_dir / name
    if not path.exists():
        raise UnbgError("That result has expired. Run the image again.", code="result_expired", status_code=410)
    return FileResponse(path, media_type="image/png", filename=f"unbg-{name}")


@app.delete("/api/results/{name}")
async def delete_result(name: str):
    path: Path = settings.result_dir / name
    if path.exists() and path.suffix == ".png":
        path.unlink()
    return {"deleted": True}


@app.get("/")
async def index() -> dict:
    return {
        "app": "unbg",
        "version": __version__,
        "docs": "/docs",
        "endpoints": ["/api/health", "/api/models", "/api/remove", "/api/batch", "/api/results/{name}"],
    }
