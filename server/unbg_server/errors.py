"""Errors that tell the client exactly what to fix, all in one JSON shape."""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse


class UnbgError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code


class UnsupportedMedia(UnbgError):
    status_code = 415
    code = "unsupported_media"


class TooLarge(UnbgError):
    status_code = 413
    code = "too_large"


class UnknownModel(UnbgError):
    status_code = 404
    code = "unknown_model"


class ModelUnavailable(UnbgError):
    status_code = 503
    code = "model_unavailable"


class Unreadable(UnbgError):
    status_code = 422
    code = "unreadable_image"


async def unbg_error_handler(_: Request, exc: UnbgError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.code, "message": exc.message},
    )
