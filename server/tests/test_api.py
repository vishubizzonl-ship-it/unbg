"""Unit + API tests. A fake engine stands in for BiRefNet so nothing heavy is loaded."""

from __future__ import annotations

import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from unbg_server import backgrounds, io_images, main, refine
from unbg_server.engines import registry
from unbg_server.engines.base import Engine, EngineInfo


def make_image(width: int = 240, height: int = 180, fmt: str = "PNG", colour=(30, 90, 200)) -> bytes:
    """Synthetic photo: a coloured blob on a plain background."""
    arr = np.full((height, width, 3), 240, dtype=np.uint8)
    yy, xx = np.mgrid[0:height, 0:width]
    blob = ((yy - height / 2) ** 2 / (height / 3) ** 2 + (xx - width / 2) ** 2 / (width / 3) ** 2) < 1
    arr[blob] = colour
    buffer = io.BytesIO()
    Image.fromarray(arr).save(buffer, format=fmt)
    return buffer.getvalue()


class FakeEngine(Engine):
    """Returns a centred ellipse mask — enough to exercise the whole pipeline."""

    def __init__(self) -> None:
        super().__init__()
        self.info = EngineInfo(
            id="fake", label="Fake Engine", family="test", license="MIT", size_mb=0, best_for="tests"
        )

    def available(self) -> bool:
        return True

    def load(self) -> None:
        self._loaded = True

    def _infer(self, rgb: np.ndarray) -> np.ndarray:
        height, width = rgb.shape[:2]
        yy, xx = np.mgrid[0:height, 0:width]
        return (
            ((yy - height / 2) ** 2 / (height / 2.5) ** 2 + (xx - width / 2) ** 2 / (width / 2.5) ** 2) < 1
        ).astype(np.float32)


@pytest.fixture(scope="session", autouse=True)
def fake_model():
    registry._FACTORIES["fake"] = FakeEngine  # noqa: SLF001
    registry._CACHE.pop("fake", None)  # noqa: SLF001
    yield
    registry._CACHE.pop("fake", None)  # noqa: SLF001


@pytest.fixture()
def client():
    with TestClient(main.app) as test_client:
        yield test_client


# ------------------------------------------------------------------ validation
def test_sniff_accepts_known_formats():
    assert io_images.sniff(make_image(fmt="PNG")) == "PNG"
    assert io_images.sniff(make_image(fmt="JPEG")) == "JPEG"
    assert io_images.sniff(make_image(fmt="WEBP")) == "WEBP"


def test_sniff_rejects_text_and_empty():
    with pytest.raises(io_images.UnsupportedMedia):
        io_images.sniff(b"hello, definitely not an image")
    with pytest.raises(io_images.UnsupportedMedia):
        io_images.sniff(b"")


def test_oversize_upload_is_413():
    payload = b"\x89PNG\r\n\x1a\n" + b"0" * (3 * 1024 * 1024)
    with pytest.raises(io_images.TooLarge):
        io_images.sniff(payload)


def test_large_pixel_count_is_downscaled():
    data = make_image(3000, 3000, fmt="JPEG")
    loaded = io_images.load(data)
    assert loaded.scaled is True
    assert loaded.pixels <= 2_000_000
    assert loaded.original_width == 3000


def test_truncated_png_is_readable_error():
    data = make_image(200, 200, fmt="PNG")[:120]
    with pytest.raises(io_images.Unreadable):
        io_images.load(data)


# ------------------------------------------------------------------ colours
@pytest.mark.parametrize(
    "value,expected",
    [
        ("transparent", None),
        ("white", (255, 255, 255)),
        ("#fff", (255, 255, 255)),
        ("#0af", (0, 170, 255)),
        ("ff8800", (255, 136, 0)),
    ],
)
def test_parse_color(value, expected):
    assert backgrounds.parse_color(value) == expected


def test_parse_color_rejects_junk():
    with pytest.raises(backgrounds.UnbgError):
        backgrounds.parse_color("banana")


def test_composite_white_flattens_alpha():
    rgb = np.full((10, 10, 3), 0, dtype=np.uint8)
    alpha = np.zeros((10, 10), dtype=np.float32)
    image = backgrounds.composite(rgb, alpha, (255, 255, 255))
    assert image.mode == "RGB"
    assert image.getpixel((5, 5)) == (255, 255, 255)
    transparent = backgrounds.composite(rgb, alpha, None)
    assert transparent.mode == "RGBA"
    assert transparent.getpixel((5, 5))[3] == 0


# ------------------------------------------------------------------ refinement
def test_trimap_marks_certain_and_unknown_regions():
    alpha = np.zeros((60, 60), dtype=np.float32)
    alpha[20:40, 20:40] = 1.0
    trimap = refine.build_trimap(alpha, 5)
    assert trimap[30, 30] == 1.0     # deep inside the subject
    assert trimap[0, 0] == 0.0       # far corner
    assert 0.5 in trimap             # the band exists


def test_refine_keeps_range_and_reports_steps():
    alpha = np.linspace(0, 1, 100 * 120, dtype=np.float32).reshape(100, 120)
    rgb = np.full((100, 120, 3), 128, dtype=np.uint8)
    out, steps = refine.refine(alpha, rgb, matte=False)
    assert out.shape == alpha.shape
    assert out.min() >= 0.0 and out.max() <= 1.0
    assert steps["smoothstep"] is True
    assert "refine_ms" in steps


def test_foreground_estimation_keeps_subject_colour_and_drops_background_tint():
    height = width = 64
    rgb = np.full((height, width, 3), 255, dtype=np.uint8)  # white studio background
    rgb[16:48, 16:48] = [200, 30, 30]                        # red subject
    alpha = np.zeros((height, width), dtype=np.float32)
    alpha[16:48, 16:48] = 1.0
    fg = refine.estimate_foreground(rgb, alpha)
    assert fg is not None and fg.shape == (height, width, 3)
    centre = fg[32, 32]
    assert centre[0] == pytest.approx(200 / 255, abs=0.03)   # red stays red
    assert centre[1] == pytest.approx(30 / 255, abs=0.03)    # no white bleed into G/B
    assert float(fg.max()) <= 1.0 and float(fg.min()) >= 0.0


def test_foreground_estimation_respects_size_mismatch():
    rgb = np.zeros((32, 32, 3), dtype=np.uint8)
    alpha = np.zeros((16, 16), dtype=np.float32)
    assert refine.estimate_foreground(rgb, alpha) is None


def test_smoothstep_pushes_midtones_apart():
    out = refine._smoothstep(np.array([0.5, 0.2, 0.8], dtype=np.float32))
    assert out[0] == pytest.approx(0.5, abs=0.02)
    assert out[1] < 0.2 and out[2] > 0.8


# ------------------------------------------------------------------ silueta / policy
def test_silueta_is_the_default_engine():
    from unbg_server.config import settings
    from unbg_server.engines import registry

    assert settings.default_model == "silueta"
    assert registry.get().info.id == "silueta"
    for alias in ("light", "fast", "default", "photo"):
        assert registry.get(alias).info.id == "silueta"


def test_registry_lists_lightweight_first_and_keeps_heavy_models_optional():
    from unbg_server.engines import registry

    described = registry.describe()
    assert described[0]["id"] == "silueta"
    assert described[0]["size_mb"] == 44
    assert {"birefnet-general", "birefnet-portrait", "u2netp"} <= {m["id"] for m in described}


def test_only_one_model_is_kept_in_memory():
    from unbg_server.config import settings
    from unbg_server.engines import registry

    assert settings.single_model is True
    first = registry.get("fake")
    first.load()
    assert "fake" in registry.loaded_models()
    registry.get("silueta")  # a different id evicts the previous engine
    assert "fake" not in registry.loaded_models()
    assert "silueta" in registry._CACHE  # noqa: SLF001


def test_silueta_crop_box_covers_the_subject_with_padding():
    from unbg_server.engines.silueta import CROP_PAD, SiluetaEngine

    engine = SiluetaEngine()
    mask = np.zeros((100, 200), dtype=np.float32)
    mask[40:60, 50:150] = 1.0
    left, top, right, bottom = engine._subject_box(mask)
    assert left < 50 and right > 150 and top < 40 and bottom > 60
    assert left == max(0, 50 - int(100 * CROP_PAD))
    assert engine._subject_box(np.zeros((10, 10), dtype=np.float32)) is None


def test_second_pass_is_off_by_default():
    from unbg_server.config import settings

    assert settings.second_pass is False


# ------------------------------------------------------------------ endpoints
def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["version"]
    assert isinstance(body["runtime"]["providers"], list)


def test_models_lists_registry(client):
    body = client.get("/api/models").json()
    ids = [m["id"] for m in body["models"]]
    assert "birefnet-general" in ids and "birefnet-portrait" in ids
    for item in body["models"]:
        assert {"id", "label", "license", "available"} <= set(item)


def test_remove_returns_transparent_png(client):
    response = client.post("/api/remove?model=fake", files={"file": ("a.png", make_image(), "image/png")})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-unbg-model"] == "fake"
    out = Image.open(io.BytesIO(response.content))
    assert out.mode == "RGBA"
    corner = out.getpixel((0, 0))[3]
    centre = out.getpixel((out.width // 2, out.height // 2))[3]
    assert corner == 0 and centre == 255


def test_remove_white_background(client):
    response = client.post(
        "/api/remove?model=fake&background=white",
        files={"file": ("a.jpg", make_image(fmt="JPEG"), "image/jpeg")},
    )
    assert response.status_code == 200
    out = Image.open(io.BytesIO(response.content))
    assert out.mode == "RGB"
    assert out.getpixel((0, 0)) == (255, 255, 255)


def test_remove_unknown_model_is_404(client):
    response = client.post("/api/remove?model=nope", files={"file": ("a.png", make_image(), "image/png")})
    assert response.status_code == 404
    assert response.json()["error"] == "unknown_model"


def test_remove_rejects_non_image(client):
    response = client.post("/api/remove?model=fake", files={"file": ("a.txt", b"nope", "text/plain")})
    assert response.status_code == 415
    assert response.json()["error"] == "unsupported_media"


def test_remove_bad_background(client):
    response = client.post(
        "/api/remove?model=fake&background=banana",
        files={"file": ("a.png", make_image(), "image/png")},
    )
    assert response.status_code == 400
    assert response.json()["error"] == "bad_background"


def test_remove_store_gives_result_url(client):
    response = client.post(
        "/api/remove?model=fake&store=true", files={"file": ("a.png", make_image(), "image/png")}
    )
    url = response.headers["x-unbg-result"]
    assert url.startswith("/api/results/")
    fetched = client.get(url)
    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "image/png"


def test_result_path_traversal_blocked(client):
    assert client.get("/api/results/..%2f..%2fetc%2fpasswd").status_code in (400, 404)
    assert client.get("/api/results/missing.png").status_code == 410


def test_batch_returns_per_file_status(client):
    files = [
        ("files", ("one.png", make_image(), "image/png")),
        ("files", ("bad.txt", b"not an image", "text/plain")),
    ]
    body = client.post("/api/batch?model=fake", files=files).json()
    assert body["count"] == 2
    assert body["results"][0]["ok"] is True
    assert body["results"][1]["ok"] is False
    assert body["results"][1]["error"] == "unsupported_media"


def test_batch_limit_enforced(client):
    object.__setattr__(main.settings, "max_batch", 1)
    try:
        _batch_over_limit(client)
    finally:
        object.__setattr__(main.settings, "max_batch", 8)


def _batch_over_limit(client):
    files = [
        ("files", ("one.png", make_image(), "image/png")),
        ("files", ("two.png", make_image(), "image/png")),
    ]
    response = client.post("/api/batch?model=fake", files=files)
    assert response.status_code == 413


def test_detail_high_runs_tiled(client):
    # A 256 px inference size forces the 600x400 image into several blended crops.
    object.__setattr__(main.settings, "input_size", 256)
    try:
        data = make_image(600, 400)
        response = client.post(
            "/api/remove?model=fake&detail=high", files={"file": ("a.png", data, "image/png")}
        )
    finally:
        object.__setattr__(main.settings, "input_size", 1024)
    assert response.status_code == 200
    meta = response.headers["x-unbg-meta"]
    assert "tiled" in meta
    assert "\"tiles\"" in meta


def test_unavailable_model_is_503(client):
    """BiRefNet is not downloaded in CI, so asking for it must fail cleanly."""
    response = client.post(
        "/api/remove?model=birefnet-general", files={"file": ("a.png", make_image(), "image/png")}
    )
    assert response.status_code == 503
    assert response.json()["error"] == "model_unavailable"
